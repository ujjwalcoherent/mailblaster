'use strict';

/**
 * Recognising campaigns the user sent before they had this tool, so a
 * follow-up can be threaded onto the original rather than arriving as an
 * unrelated new email.
 *
 * The user never has to describe the campaign: their Sent folder already holds
 * every fact we need — recipients, subject, body, timestamps and, critically,
 * the Message-Ids that make threading possible.
 *
 * Nothing here talks to the network or the database. It takes the envelopes
 * lib/imap.js returned and works out which of them form a campaign, so it can
 * be tested against fixtures rather than a live mailbox.
 */

const { parseName } = require('./util');

/* A campaign is a burst: several recipients, sent close together. The gap is
   what separates a blast from ordinary correspondence — a person writing five
   emails by hand takes minutes between them, a mail merge takes seconds. */
const MIN_RECIPIENTS = 3;
const BURST_GAP_MS = 120 * 1000;   // median gap below this reads as automated

/**
 * Group sent messages into candidate campaigns.
 *
 * Confidence is reported rather than enforced: a slow, hand-sent campaign is
 * still a campaign, it just needs a human to confirm it, so it is surfaced
 * with the reason attached instead of being silently dropped.
 */
function cluster(messages) {
  const groups = new Map();
  for (const m of messages || []) {
    const key = m.normalised || '';
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const out = [];
  for (const [key, msgs] of groups) {
    msgs.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const times = msgs.map(m => new Date(m.at).getTime()).sort((a, b) => a - b);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    const medianGap = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;

    const recipients = new Set();
    msgs.forEach(m => (m.to || []).forEach(t => recipients.add(t)));
    const bcc = msgs.some(m => m.bccLikely);

    let confidence = 'low';
    let reason;
    if (recipients.size >= MIN_RECIPIENTS && gaps.length && medianGap <= BURST_GAP_MS) {
      confidence = 'high';
      reason = 'sent to ' + recipients.size + ' people, ' + Math.round(medianGap / 1000) + 's apart';
    } else if (recipients.size >= MIN_RECIPIENTS) {
      confidence = 'medium';
      reason = 'sent to ' + recipients.size + ' people, but ' + humanGap(medianGap)
        + ' apart — check these are not individual emails';
    } else if (bcc && msgs.length === 1) {
      confidence = 'medium';
      reason = 'one message with hidden recipients — looks like a BCC blast';
    } else {
      reason = recipients.size + ' recipient(s) — probably ordinary correspondence';
    }

    out.push({
      key,
      subject: msgs[0].subject,
      count: msgs.length,
      recipients: [...recipients],
      recipientCount: recipients.size,
      firstAt: msgs[0].at,
      lastAt: msgs[msgs.length - 1].at,
      medianGapMs: medianGap,
      spanMs: times[times.length - 1] - times[0],
      bccLikely: bcc,
      confidence,
      reason,
      uids: msgs.map(m => m.uid),
      messageIds: msgs.map(m => m.messageId).filter(Boolean),
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => (rank[a.confidence] - rank[b.confidence])
    || String(b.lastAt).localeCompare(String(a.lastAt)));
  return out;
}

/* Find the biggest set of messages that share a shape, by comparing each
   against the others and keeping whichever group agrees most. With only two
   samples there is no majority to find, so both are kept. */
function pickMajority(list, split) {
  if (list.length < 3) return { kept: list, dropped: [] };
  const toks = list.map(s => split(s.body));
  const similarity = (a, b) => {
    const n = Math.max(a.length, b.length) || 1;
    let same = 0;
    for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
    return same / n;
  };
  let best = null;
  for (let i = 0; i < list.length; i++) {
    const group = list.filter((_, j) => similarity(toks[i], toks[j]) >= 0.6);
    if (!best || group.length > best.length) best = group;
  }
  const keptSet = new Set(best.map(s => s.uid));
  const dropped = list.filter(s => !keptSet.has(s.uid)).map(s => {
    const sim = similarity(split(best[0].body), split(s.body));
    return {
      to: (s.to || [])[0] || '',
      uid: s.uid,
      differencePct: Math.round((1 - sim) * 100),
    };
  });
  return { kept: best, dropped };
}

function humanGap(ms) {
  if (!ms) return '0s';
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm';
  return Math.round(ms / 3600000) + 'h';
}

/**
 * Expand from a single message the user pasted or forwarded.
 *
 * Message-Id is definitive but only identifies one message, so it locates the
 * anchor and the subject then finds its siblings. If the paste had no headers
 * at all, the subject alone still works — with lower confidence.
 */
function parsePasted(raw) {
  const text = String(raw || '');
  const grab = name => {
    const m = text.match(new RegExp('^' + name + ':\\s*(.+)$', 'mi'));
    return m ? m[1].trim() : null;
  };
  const messageId = (grab('Message-ID') || '').match(/<[^>]+>/);
  const parsed = {
    messageId: messageId ? messageId[0] : null,
    subject: grab('Subject'),
    to: (grab('To') || '').toLowerCase().match(/[\w.+-]+@[\w.-]+/),
    date: grab('Date'),
  };
  parsed.to = parsed.to ? parsed.to[0] : null;

  /* No headers at all: treat the first non-empty line as the subject, which is
     what someone pasting a screenshot's worth of text will have given us. */
  if (!parsed.subject && !parsed.messageId) {
    const first = text.split(/\r?\n/).map(l => l.trim()).find(Boolean);
    if (first) { parsed.subject = first.slice(0, 200); parsed.weak = true; }
  }
  parsed.usable = !!(parsed.messageId || parsed.subject);
  return parsed;
}

/**
 * Rebuild the template from bodies that were sent to different people.
 *
 * Compare messages token by token: what is identical everywhere is the
 * template, and what varies in step with the recipient is a merge field. A
 * fragment is only called {{name}} when it actually matches the name parsed
 * from that recipient's address — otherwise it is marked as a variable the
 * user must name, rather than guessed at.
 */
function rebuildTemplate(samples, opts) {
  const list = (samples || []).filter(s => s && s.body);
  if (!list.length) return { template: '', fields: [], outliers: [], confidence: 'none' };
  if (list.length === 1) {
    return {
      template: list[0].body,
      fields: [],
      outliers: [],
      confidence: 'low',
      note: 'Only one message available, so no merge fields could be detected.',
    };
  }

  const split = s => String(s).split(/(\s+)/);

  /* One unrelated message that happens to share the subject would otherwise
     make every token look variable and reduce the whole template to {{?}}.
     So outliers are found against the MAJORITY shape first and set aside
     before the template is built — then reported, never silently dropped. */
  const majority = pickMajority(list, split);
  const kept = majority.kept;
  const setAside = majority.dropped;
  const base = split(kept[0].body);
  const fields = [];
  const varyingAt = new Set();

  for (let i = 0; i < base.length; i++) {
    const here = kept.map(s => split(s.body)[i]);
    if (here.some(t => t !== here[0])) varyingAt.add(i);
  }

  /* A varying token that equals the recipient's parsed first name is the
     greeting merge field — the one case we can name with confidence. */
  const nameLike = idx => kept.every((s, n) => {
    const token = String(split(s.body)[idx] || '').replace(/[^\w'-]/g, '');
    if (!token) return false;
    const who = (s.to && s.to[0]) ? parseName(s.to[0]) : null;
    return !!(who && who.first && token.toLowerCase() === who.first.toLowerCase());
  });

  const outTokens = base.slice();
  for (const idx of varyingAt) {
    if (nameLike(idx)) {
      const punct = String(base[idx] || '').match(/[^\w'-]+$/);
      outTokens[idx] = '{{name}}' + (punct ? punct[0] : '');
      if (!fields.includes('{{name}}')) fields.push('{{name}}');
    } else {
      outTokens[idx] = '{{?}}';
      if (!fields.includes('{{?}}')) fields.push('{{?}}');
    }
  }

  /* Messages that differ far more than the merge fields explain are probably
     not part of this campaign at all — surface them for review. */
  const outliers = setAside;

  return {
    template: outTokens.join(''),
    fields,
    outliers,
    confidence: fields.includes('{{name}}') ? 'high' : (fields.length ? 'medium' : 'high'),
    note: fields.includes('{{?}}')
      ? 'Some text varied between messages but could not be identified — shown as {{?}} for you to name or replace.'
      : null,
  };
}

module.exports = { cluster, parsePasted, rebuildTemplate, normaliseGap: humanGap,
  MIN_RECIPIENTS, BURST_GAP_MS };
