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

/* A subject template often carries a trailing (or leading) variable
   fragment beyond what greeting-stripping removes — "Great meeting at the
   event" vs "Great meeting at the event India Health 2026" — so exact-key
   equality on the normalised subject under-clusters real campaigns into
   several near-identical entries. Word-overlap catches this: two subjects
   are the same template when the SHORTER one's words are (almost) all
   present in the longer one, in the same relative order, regardless of
   extra words tacked onto either end. Order matters — "health india" vs
   "india health" is treated as a weaker match than a straight subset would
   suggest, since word order swapping is a real (if rare) different-subject
   signal a smaller wordset can hide. */
const SUBJECT_OVERLAP_THRESHOLD = 0.8;

function subjectTokens(normalised) {
  return String(normalised || '').split(' ').filter(Boolean);
}

/** Fraction of `shorter`'s words found in `longer`, in the same relative order (LCS length / shorter length). */
function orderedOverlap(shorter, longer) {
  if (!shorter.length) return 0;
  let i = 0;
  for (const word of longer) {
    if (word === shorter[i]) i++;
    if (i === shorter.length) break;
  }
  return i / shorter.length;
}

function subjectSimilarity(a, b) {
  const ta = subjectTokens(a), tb = subjectTokens(b);
  if (!ta.length || !tb.length) return ta.length === tb.length ? 1 : 0;
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return orderedOverlap(shorter, longer);
}

/**
 * Group sent messages into candidate campaigns.
 *
 * Grouping is by subject WORD OVERLAP, not exact match, so a template with a
 * variable fragment tacked onto one end clusters correctly even when the
 * normalised subjects differ as strings. Each group's anchor is its first
 * (longest-surviving) member — later messages join if they overlap the
 * anchor by SUBJECT_OVERLAP_THRESHOLD or more, so drift across many small
 * edits can't silently chain unrelated subjects together one hop at a time.
 *
 * Confidence is reported rather than enforced: a slow, hand-sent campaign is
 * still a campaign, it just needs a human to confirm it, so it is surfaced
 * with the reason attached instead of being silently dropped.
 */
function cluster(messages) {
  const anchors = [];   // [{ tokens, msgs }]
  for (const m of messages || []) {
    const norm = m.normalised || '';
    if (!norm) continue;
    const toks = subjectTokens(norm);
    let best = null, bestScore = 0;
    for (const a of anchors) {
      const score = subjectSimilarity(norm, a.tokens.join(' '));
      if (score >= SUBJECT_OVERLAP_THRESHOLD && score > bestScore) { best = a; bestScore = score; }
    }
    if (best) best.msgs.push(m);
    else anchors.push({ tokens: toks, msgs: [m] });
  }

  const out = [];
  for (const { msgs } of anchors) {
    msgs.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    // The group's display subject is its earliest message's, not whichever anchored the group first.
    const key = msgs[0].normalised || '';
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

/**
 * Given a cluster's messages (each already carrying `messageId`,
 * `inReplyTo`, `references` from lib/imap.js's scanSent()), work out which
 * imported message is itself a reply to another imported message, and
 * assign each one a `followupRound` — 0 for the first message in a chain,
 * 1 for whatever answers it, 2 for whatever answers THAT, and so on.
 *
 * This is what "resume from the latest point" needs for a campaign that
 * already had manual back-and-forth before this tool existed: without it,
 * every imported send is recorded as round 0 regardless of its real
 * position, and a follow-up sent after import would thread onto the very
 * first message in a conversation rather than the most recent one.
 *
 * A chain is scoped to ONE recipient — two different people's initial and
 * follow-up emails share a subject and a burst window (that's what makes
 * them one cluster), but "message B replies to message A" only makes sense
 * within the same person's own thread, so linking is done per recipient,
 * not across the whole cluster.
 *
 * Returns a Map from this cluster's `uid`s to `{ round, parentUid }`. A
 * message whose In-Reply-To/References don't resolve to another message IN
 * THIS SAME CLUSTER (the common case — replying to something outside the
 * cluster, or not replying to anything) is round 0 with no parent: it's the
 * start of its own chain, which is the correct, safe default.
 */
function linkThreadPositions(messages) {
  const out = new Map();
  const byRecipient = new Map();
  for (const m of messages || []) {
    const to = (m.to && m.to[0]) || '';
    if (!byRecipient.has(to)) byRecipient.set(to, []);
    byRecipient.get(to).push(m);
  }

  for (const group of byRecipient.values()) {
    group.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const byMessageId = new Map(group.filter(m => m.messageId).map(m => [m.messageId, m]));

    for (const m of group) {
      /* The immediate parent is whichever of THIS message's In-Reply-To or
         References ids matches a message-id we actually have in this same
         recipient's group — checking References too (not just
         In-Reply-To) means a message that dropped In-Reply-To but kept
         References still links correctly. */
      const candidateIds = [m.inReplyTo, ...(m.references || [])].filter(Boolean);
      const parent = candidateIds.map(id => byMessageId.get(id)).find(Boolean);
      if (!parent || parent === m) {
        out.set(m.uid, { round: 0, parentUid: null });
        continue;
      }
      const parentInfo = out.get(parent.uid);
      const parentRound = parentInfo ? parentInfo.round : 0;
      out.set(m.uid, { round: parentRound + 1, parentUid: parent.uid });
    }
  }
  return out;
}

module.exports = { cluster, parsePasted, rebuildTemplate, linkThreadPositions, normaliseGap: humanGap,
  MIN_RECIPIENTS, BURST_GAP_MS };
