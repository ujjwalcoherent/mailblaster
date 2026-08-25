'use strict';

/**
 * A thin DeepSeek client for one job: suggesting that two campaign clusters
 * which didn't match by exact-string or timing might actually be the same
 * campaign (e.g. "Great meeting at the event India Health 2026" and "Great
 * meeting at the event" — a missing event name, not a different mailing).
 *
 * This is deliberately the LAST resort, not the first. `lib/importer.js`'s
 * `cluster()` (exact subject match after normalisation) and `api/import.js`'s
 * `query` param (server-side IMAP subject-or-body search) already handle the
 * common cases. This module only ever runs against whatever's LEFT after
 * those — small, low-confidence clusters — and its output is always a
 * suggestion the user reviews and confirms, never an automatic merge. That
 * mirrors this codebase's existing rule for the deterministic importer:
 * "surfaced with the reason attached... never silently dropped."
 *
 * Genuinely optional: with no DEEPSEEK_API_KEY set, every function here is a
 * no-op that returns null/empty rather than throwing, and the caller's
 * deterministic clustering is the only thing that ran. Nothing about this
 * app's core behaviour depends on this file.
 *
 * Cost is tracked, not assumed: DeepSeek's response `usage` object reports
 * exactly how many tokens hit the prompt cache vs missed it, and pricing
 * genuinely differs by 30x+ between the two — so a cost estimate that
 * doesn't read `usage` back is just a guess. Rates below are quoted from
 * DeepSeek's own pricing page (api-docs.deepseek.com/quick_start/pricing) as
 * of August 2026; they are not fetched at runtime — bake in a refresh of
 * this table if DeepSeek reprices.
 */

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-flash';   // cheapest tier: this is a yes/no classification, not generation

/* $ per 1,000,000 tokens. peak hours are 01:00-04:00 and 06:00-10:00 UTC,
   Monday-Friday; every other hour is off-peak. A cache HIT is ~31x cheaper
   than a cache MISS on input — the same system prompt repeated across many
   pairwise comparisons should hit the cache after the first call. */
const PRICING = {
  'deepseek-v4-flash': {
    inputCacheHit: { offPeak: 0.007, peak: 0.014 },
    inputCacheMiss: { offPeak: 0.22, peak: 0.44 },
    output: { offPeak: 0.66, peak: 1.32 },
  },
  'deepseek-v4-pro': {
    inputCacheHit: { offPeak: 0.022, peak: 0.044 },
    inputCacheMiss: { offPeak: 0.66, peak: 1.32 },
    output: { offPeak: 1.98, peak: 3.96 },
  },
};

/** Is `date` (default: now) inside DeepSeek's peak billing window? */
function isPeakHour(date) {
  const d = date || new Date();
  const day = d.getUTCDay();          // 0 = Sunday
  if (day === 0 || day === 6) return false;
  const hour = d.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/**
 * Compute exact cost in USD for one DeepSeek response's `usage` object.
 * Billing is priced by the REQUEST's own timestamp — DeepSeek's docs don't
 * separately define billing-by-completion-time, so that's the only
 * defensible clock point, and it must be read as UTC explicitly (not
 * whatever timezone the host happens to run in).
 */
function costOf(usage, opts) {
  const model = (opts && opts.model) || MODEL;
  const at = (opts && opts.at) || new Date();
  const table = PRICING[model] || PRICING[MODEL];
  const bucket = isPeakHour(at) ? 'peak' : 'offPeak';

  const cacheHitTokens = Number(usage.prompt_cache_hit_tokens || 0);
  const cacheMissTokens = Number(usage.prompt_cache_miss_tokens
    || Math.max(0, Number(usage.prompt_tokens || 0) - cacheHitTokens));
  const outputTokens = Number(usage.completion_tokens || 0);

  const cost = (cacheHitTokens / 1e6) * table.inputCacheHit[bucket]
    + (cacheMissTokens / 1e6) * table.inputCacheMiss[bucket]
    + (outputTokens / 1e6) * table.output[bucket];

  return {
    usd: cost,
    model,
    peak: bucket === 'peak',
    cacheHitTokens, cacheMissTokens, outputTokens,
  };
}

function apiKey() {
  return process.env.DEEPSEEK_API_KEY || '';
}

/** True if this module can actually make calls right now. */
function available() {
  return !!apiKey();
}

/**
 * One chat completion call, JSON-mode, with cost logged via lib/log.js
 * (tagged 'llm_usage') on every response — success or not — so cost is
 * visible in the same structured log stream as everything else, with no
 * separate observability system to stand up.
 */
async function complete(messages, opts) {
  const key = apiKey();
  if (!key) return null;   // no key configured: caller's deterministic path is authoritative

  const model = (opts && opts.model) || MODEL;
  const log = require('./log');
  const startedAt = new Date();

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
      },
      body: JSON.stringify({
        model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0,   // classification, not creative generation
      }),
    });
  } catch (e) {
    log.warn('llm_request_failed', { model, error: e.message });
    return null;
  }

  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (e) { /* ignore */ }
    log.warn('llm_request_failed', { model, status: res.status, detail: detail.slice(0, 300) });
    return null;
  }

  const data = await res.json();
  const usage = data.usage || {};
  const cost = costOf(usage, { model, at: startedAt });
  log.info('llm_usage', {
    model, peak: cost.peak,
    promptTokens: usage.prompt_tokens || 0,
    cacheHitTokens: cost.cacheHitTokens, cacheMissTokens: cost.cacheMissTokens,
    completionTokens: cost.outputTokens,
    costUsd: Number(cost.usd.toFixed(6)),
  });

  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch (e) {
    log.warn('llm_bad_json', { model });
    return null;
  }
}

/**
 * Ask whether two subject lines plausibly describe the SAME campaign,
 * allowing for a missing/added event name, year, or similar personalised
 * fragment — the exact case exact-string clustering misses. Returns
 * `{ same: boolean, reason: string }`, or null if the LLM path is
 * unavailable/failed (deterministic clustering already ran; this is purely
 * additive).
 *
 * Never call this for every pair in a large scan — it's meant for the
 * handful of small/singleton clusters LEFT OVER after deterministic
 * clustering, not a substitute for it.
 */
async function suggestSameCampaign(subjectA, subjectB) {
  const result = await complete([
    {
      role: 'system',
      content: 'You classify whether two email subject lines are the same mail-merge campaign, '
        + 'allowing for one being a template with a personalised fragment (an event name, a year, '
        + 'a company name) either present or missing. Reply ONLY as JSON: '
        + '{"same": true|false, "reason": "one short sentence"}.',
    },
    {
      role: 'user',
      content: 'Subject A: ' + JSON.stringify(subjectA) + '\nSubject B: ' + JSON.stringify(subjectB),
    },
  ]);
  if (!result || typeof result.same !== 'boolean') return null;
  return { same: result.same, reason: String(result.reason || '') };
}

module.exports = { available, complete, suggestSameCampaign, costOf, isPeakHour, PRICING, MODEL };
