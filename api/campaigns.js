'use strict';
/**
 * Campaign history for one Gmail account, and the people inside one campaign.
 *
 *   GET  /api/campaigns?owner=me@gmail.com          -> the runs
 *   GET  /api/campaigns?id=12&people=1              -> who was in run 12
 *   GET  /api/campaigns?quota=me@gmail.com          -> that account's rolling 24h send count
 *   POST /api/campaigns { action:'start', ... }     -> create a campaign row
 *   POST /api/campaigns { action:'finish', campaignId, status } -> close it out
 *
 * Scoped by the sending address so signing in with a Gmail account shows that
 * account's history. Only the address is used: the App Password never reaches
 * the server.
 *
 * The start/finish actions exist because sending a fresh (non-follow-up,
 * non-imported) campaign previously had no code path that ever called
 * store.startCampaign() — every /api/send call for an ordinary compose-and-
 * send campaign was persisted with campaign_id = NULL. That silently broke
 * two things: Section 4 never listed a freshly-sent campaign (only follow-ups
 * and imports, which DO call startCampaign), and store.followupCandidates()
 * — which requires a real campaignId — could never find anyone to chase for
 * a campaign sent the normal way. This is the fix: the browser now starts a
 * campaign before its send loop and finishes it after, exactly as
 * api/followup.js and api/import.js already do for their own runs.
 */
const { readJson, send } = require('../lib/util');
const store = require('../lib/store');
const { describe, httpFor, classify } = require('../lib/errors');
const log = require('../lib/log');
const auth = require('../lib/auth');

module.exports = log.wrap('campaigns', auth.require(async function handler(req, res) {
  if (req.method === 'GET') return get(req, res);
  if (req.method === 'POST') return post(req, res);
  return send(res, 405, describe('METHOD_NOT_ALLOWED'));
}));

async function get(req, res) {
  if (!(await store.available())) return send(res, 200, { ok: true, available: false, campaigns: [], reason: store.reason() });

  const q = req.query || {};
  try {
    if (q.people && q.id) {
      const people = await store.campaignPeople(q.id);
      return send(res, 200, { ok: true, available: true, people });
    }
    if (q.quota) {
      /* Google enforces this cap itself (500 recipients/24h on a personal
         account), not us — this just surfaces it up front, per account, so a
         page with several accounts sending at once can show each one's
         remaining headroom instead of the first sign of trouble being a
         mid-campaign SEND_QUOTA_EXCEEDED. */
      const quota = await store.sentToday(q.quota);
      return send(res, 200, { ok: true, available: true, quota });
    }
    const campaigns = await store.campaigns(q.owner, q.limit);
    send(res, 200, { ok: true, available: true, driver: store.driver(), campaigns });
  } catch (e) {
    const code = classify(e);
    send(res, httpFor(code), describe(e));
  }
}

async function post(req, res) {
  if (!(await store.available())) return send(res, 503, describe('DB_UNAVAILABLE'));
  const b = await readJson(req);

  try {
    if (b.action === 'start') {
      if (!b.from) return send(res, 400, describe('BAD_REQUEST', { error: 'from is required' }));
      const campaignId = await store.startCampaign({
        name: b.name || b.subject || 'Campaign', subject: b.subject || null,
        from: b.from, total: Number(b.total) || 0,
        groupKey: b.groupKey || null,
      });
      log.info('campaign_started', { campaignId, from: b.from, total: b.total });
      return send(res, 200, { ok: true, campaignId });
    }
    if (b.action === 'finish') {
      if (!b.campaignId) return send(res, 400, describe('BAD_REQUEST', { error: 'campaignId is required' }));
      await store.finishCampaign(b.campaignId, b.status || 'done');
      return send(res, 200, { ok: true });
    }
    return send(res, 400, describe('BAD_REQUEST', { error: 'action must be start or finish' }));
  } catch (e) {
    const code = classify(e);
    send(res, httpFor(code), describe(e));
  }
}
