'use strict';
/**
 * Who a follow-up should go to, and starting the run that sends it.
 *
 *   GET  /api/followup?campaign=12          -> eligible people, with reasons
 *   POST /api/followup { campaignId, name } -> create the follow-up campaign
 *
 * Eligibility is decided here, not in the browser. A page left open for an
 * hour has a stale idea of who has replied, and mailing someone who already
 * answered is the failure this whole system exists to prevent — so the list is
 * rebuilt from the database at the moment of sending.
 *
 * The actual delivery still goes through /api/send, one call per person, so a
 * follow-up gets the same progress reporting, the same error codes and the
 * same duplicate protection as an original campaign.
 */
const { readJson, send } = require('../lib/util');
const store = require('../lib/store');
const { describe, httpFor, classify } = require('../lib/errors');
const log = require('../lib/log');
const auth = require('../lib/auth');

/* Why each person is eligible. Shown in the UI so the audience is never a
   mystery, and used to drive the include/exclude checkboxes. */
const REASONS = {
  noreply: 'Delivered, but never answered',
  ooo: 'Was out of office, and the return date has passed',
  soft: 'Mailbox was temporarily full',
  failed: 'The original never got through',
};

module.exports = log.wrap('followup', auth.require(async function handler(req, res) {
  if (!(await store.available())) {
    return send(res, 200, { ok: true, available: false, candidates: [] });
  }

  if (req.method === 'GET') {
    const campaignId = (req.query || {}).campaign;
    if (!campaignId) return send(res, 400, describe('BAD_REQUEST', { error: 'campaign id is required' }));
    try {
      const all = await store.followupCandidates(campaignId, {
        maxFollowups: Number((req.query || {}).cap) || 3,
      });
      const counts = { noreply: 0, ooo: 0, soft: 0, failed: 0 };
      all.forEach(c => { counts[c.why] = (counts[c.why] || 0) + 1; });
      return send(res, 200, {
        ok: true, available: true, candidates: all, counts, reasons: REASONS,
      });
    } catch (e) {
      const code = classify(e);
      return send(res, httpFor(code), describe(e));
    }
  }

  if (req.method !== 'POST') return send(res, 405, describe('METHOD_NOT_ALLOWED'));

  const b = await readJson(req);
  if (!b.campaignId) return send(res, 400, describe('BAD_REQUEST', { error: 'campaignId is required' }));

  try {
    const parent = (await store.campaigns(b.owner, 500)).find(c => String(c.id) === String(b.campaignId));
    if (!parent) return send(res, 404, { ok: false, error: 'Campaign not found' });

    const include = b.include || { noreply: true };
    const candidates = (await store.followupCandidates(b.campaignId, {
      maxFollowups: b.cap === false ? false : Number(b.maxFollowups || 3),
    })).filter(c => include[c.why]);

    if (!candidates.length) {
      return send(res, 200, {
        ok: true, candidates: [], campaignId: null,
        message: 'Nobody in this campaign matches the chosen audience.',
      });
    }

    /* A follow-up is its own run, linked to the campaign it chases, so each
       round can be counted separately while the thread stays continuous. */
    const round = Number(parent.followupRound || 0) + 1;
    const id = await store.startCampaign({
      name: b.name || (parent.name + ' · follow-up ' + round),
      subject: parent.subject,
      from: parent.from,
      total: candidates.length,
      parentId: parent.id,
      followupRound: round,
    });

    log.info('followup_started', {
      campaignId: id, parent: parent.id, round, recipients: candidates.length,
    });

    send(res, 200, { ok: true, campaignId: id, followupRound: round, candidates });
  } catch (e) {
    const code = classify(e);
    send(res, httpFor(code), describe(e));
  }
}));
