const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let recipients = [];

/* ---------- tabs ---------- */
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  $(t.dataset.tab).classList.add('active');
  if (t.dataset.tab === 's4') loadAnalytics();
});

function say(el, text, ok) {
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'bad');
}

/* Turn the raw SMTP/socket error into something actionable. */
function hintFor(r) {
  const e = String((r && r.error) || '');
  if (/EACCES|ECONNREFUSED|ETIMEDOUT|ENETUNREACH/i.test(e)) {
    return '  — the connection was blocked before reaching Google. Try SMTP port 587, '
      + 'or check a firewall/VPN/antivirus on this machine.';
  }
  if (/535|Username and Password not accepted/i.test(e)) {
    return '  — Google rejected the login. Use a 16-character App Password (not your normal one); '
      + 'on a Workspace domain the admin must also allow SMTP access.';
  }
  if (/534|application-specific/i.test(e)) {
    return '  — this account needs 2-Step Verification enabled and an App Password.';
  }
  return '';
}

/* ================= SECTION 1 — Gmail app password ================= */

const CRED_KEY = 'mailblaster.creds';
(function restore() {
  try {
    const c = JSON.parse(localStorage.getItem(CRED_KEY) || '{}');
    ['gUser', 'gPass', 'fromName', 'replyTo', 'smtpPort'].forEach(k => { if (c[k]) $(k).value = c[k]; });
  } catch (e) {}
})();

function creds() {
  return {
    gUser: $('gUser').value.trim(),
    gPass: $('gPass').value.trim(),
    fromName: $('fromName').value.trim(),
    replyTo: $('replyTo').value.trim(),
    smtpPort: $('smtpPort').value,
  };
}
function persist() {
  if ($('remember').checked) localStorage.setItem(CRED_KEY, JSON.stringify(creds()));
  else localStorage.removeItem(CRED_KEY);
}
['gUser', 'gPass', 'fromName', 'replyTo', 'smtpPort', 'remember'].forEach(id => $(id).addEventListener('change', persist));

$('btnVerify').onclick = async () => {
  const b = $('btnVerify');
  b.disabled = true;
  say($('verifyMsg'), 'Connecting to smtp.gmail.com…', true);
  try {
    const c = creds();
    const r = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: c.gUser, pass: c.gPass, port: c.smtpPort }),
    }).then(x => x.json());
    say($('verifyMsg'), r.ok ? '✓ ' + r.message : '✗ ' + r.error + hintFor(r), r.ok);
    persist();
  } catch (e) {
    say($('verifyMsg'), '✗ ' + e.message, false);
  }
  b.disabled = false;
};

/* ================= SECTION 2 — recipients & salutations ================= */

const GENERIC = new Set(['info', 'admin', 'hr', 'contact', 'sales', 'support', 'team', 'office',
  'careers', 'career', 'hello', 'hi', 'mail', 'email', 'enquiry', 'enquiries', 'inquiry', 'help',
  'service', 'services', 'accounts', 'account', 'billing', 'noreply', 'no-reply', 'marketing',
  'general', 'desk', 'reception', 'md', 'ceo', 'the', 'and',
  'research', 'purchase', 'procurement', 'export', 'exports', 'import', 'imports', 'qa', 'qc',
  'rnd', 'lab', 'labs', 'factory', 'works', 'plant', 'store', 'stores', 'legal', 'finance',
  'website', 'web', 'webmaster', 'operations', 'orders', 'order', 'query', 'queries',
  'customercare', 'feedback', 'newsletter', 'subscribe', 'unsubscribe']);

/* Honorifics and professional prefixes. Left in place they become the
   greeting itself - "Hi Dr," - so they are stripped, and what remains is
   treated as a surname rather than a first name. */
const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'capt', 'adv', 'ca', 'cs',
  'er', 'shri', 'smt', 'sri', 'late']);

/* Fragments that mark a mailbox as a company rather than a person. */
const COMPANYISH = /(chem|pharma|biotech|agro|tech|studio|mktg|marketing|exports?|industr|solutions?|systems?|enterprises?|traders?|group|intl|international|medipro|polymer|labs?)$/i;

const titleCase = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/**
 * Pull a salutation out of the local part of an address.
 *
 * Returns a confidence alongside the name. `low` does NOT mean the name is
 * wrong - "harvinder@" and "sreesanth@" are perfectly good first names - it
 * means there is no separator to confirm where a first name ends, so the guess
 * deserves a human glance before it reaches a real inbox. The UI flags these
 * rather than silently rewriting them.
 */
function parseName(email) {
  const local = String(email).split('@')[0] || '';
  const stripped = local.replace(/[0-9]+/g, '');
  const hasSeparator = /[._\-+]/.test(stripped) || /[a-z][A-Z]/.test(local);

  let tokens = local.replace(/[0-9]+/g, ' ').split(/[._\-+\s]+/).filter(Boolean);
  tokens = tokens.flatMap(t => t.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ')).filter(Boolean);
  if (!tokens.length) return { first: '', full: '', generic: true, confidence: 'none' };

  // A mailbox that OPENS with a role word is a role mailbox, whatever follows:
  // info.olivepharma@ is the company's inbox, not a person called Olivepharma.
  if (GENERIC.has(tokens[0].toLowerCase())) {
    return { first: '', full: '', generic: true, confidence: 'none' };
  }

  // Strip honorifics; note that we did, because "dr.tamhane" leaves a surname.
  const titleStripped = tokens.some(t => TITLES.has(t.toLowerCase()));
  tokens = tokens.filter(t => !TITLES.has(t.toLowerCase()));

  // "s.gadnis" is an initial plus a surname - there is no first name here.
  const initialLed = tokens.length > 1 && tokens[0].length === 1;

  const named = tokens.filter(t => !GENERIC.has(t.toLowerCase()) && t.length > 1);
  if (!named.length) return { first: '', full: '', generic: true, confidence: 'none' };

  const parts = named.slice(0, 2).map(titleCase);
  const first = parts[0];

  let confidence = 'high';
  // No vowel at all means initials, not a name: "svtk", "jgk", "crs".
  if (!/[aeiou]/i.test(first)) confidence = 'low';
  else if (titleStripped || initialLed) confidence = 'low';
  // A digit sitting between letters is not a real separator: zoom2animus is
  // one handle, not "Zoom" the person.
  const digitSplit = /[a-z][0-9]+[a-z]/i.test(local);
  // A title glued to the name reads badly as a greeting: "Hi Drdjha,".
  const titlePrefix = /^(dr|mr|mrs|ms|prof|capt)[a-z]/i.test(first) && first.length > 3;

  if (titlePrefix || digitSplit) {
    confidence = 'low';
  } else if (!hasSeparator) {
    if (COMPANYISH.test(first)) confidence = 'low';       // looks like a company
    else if (first.length >= 8) confidence = 'low';        // probably first+last run together
    else if (first.length <= 3) confidence = 'low';        // initials
  }

  return { first, full: parts.join(' '), generic: false, confidence };
}

$('btnParse').onclick = () => {
  const found = ($('rawEmails').value.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || []);
  const seen = new Set();
  recipients = [];
  for (const e of found) {
    const email = e.toLowerCase();
    if (seen.has(email)) continue;      // de-duplicate within the pasted list
    seen.add(email);
    recipients.push(Object.assign({ email }, parseName(email)));
  }
  renderRecipients();
  const dupes = found.length - recipients.length;
  const generic = recipients.filter(x => x.generic).length;
  const low = recipients.filter(x => !x.generic && x.confidence === 'low').length;
  say($('parseMsg'),
    recipients.length + ' unique email(s)'
    + (dupes ? ' · ' + dupes + ' duplicate(s) removed' : '')
    + ' · ' + (recipients.length - generic) + ' name(s) parsed'
    + (generic ? ' · ' + generic + ' will use the fallback name' : '')
    + (low ? ' · ⚠ ' + low + ' name(s) need a check before sending' : ''),
    recipients.length > 0);
};

function renderRecipients() {
  const tb = document.querySelector('#recTable tbody');
  tb.innerHTML = recipients.map((r, i) => {
    const low = !r.generic && r.confidence === 'low';
    const badge = r.generic
      ? '<span class="badge g">generic inbox</span>'
      : low
        ? '<span class="badge w" title="No separator in the address, so this may be a full name run together, initials, or a company. Check it.">check this name</span>'
        : '<span class="badge p">from email id</span>';
    return '<tr class="' + (r.generic ? 'generic' : low ? 'lowconf' : '') + '">'
    + '<td>' + (i + 1) + '</td>'
    + '<td>' + esc(r.email) + '</td>'
    + '<td><input data-i="' + i + '" class="nm" value="' + esc(r.first) + '" placeholder="' + esc($('fallbackName').value) + '"/></td>'
    + '<td>' + badge + '</td>'
    + '<td><button data-del="' + i + '">✕</button></td>'
    + '</tr>';
  }).join('');

  tb.querySelectorAll('.nm').forEach(inp => inp.oninput = () => {
    const i = +inp.dataset.i, v = inp.value.trim();
    recipients[i].first = v;
    recipients[i].full = v || recipients[i].full;
    recipients[i].generic = !v;
  });
  tb.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    recipients.splice(+b.dataset.del, 1);
    renderRecipients();
  });
}

/* ================= SECTION 3 — compose ================= */

/* Footer image, held as base64 so it survives a page reload with the rest of
   the draft. Declared up here because the draft-restore IIFE below reads it.
   It is sent to the API as an inline CID attachment, not a data: URI. */
let footerImage = null;   // { filename, content(base64), mime }

const editor = $('editor');
let savedRange = null;
editor.addEventListener('mouseup', saveSel);
editor.addEventListener('keyup', saveSel);
function saveSel() {
  const s = window.getSelection();
  if (s.rangeCount && editor.contains(s.anchorNode)) savedRange = s.getRangeAt(0);
}
function restoreSel() {
  if (!savedRange) return editor.focus();
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(savedRange);
}

document.querySelectorAll('.toolbar button[data-cmd]').forEach(b => b.onclick = e => {
  e.preventDefault();
  restoreSel();
  const cmd = b.dataset.cmd;
  if (cmd === 'hilite') {
    if (!document.execCommand('hiliteColor', false, $('hlColor').value)) {
      document.execCommand('backColor', false, $('hlColor').value);
    }
  } else if (cmd === 'fore') {
    document.execCommand('foreColor', false, $('foreColor').value);
  } else if (cmd === 'createLink') {
    const url = prompt('Link URL', 'https://');
    if (url) document.execCommand('createLink', false, url);
  } else {
    document.execCommand(cmd, false, null);
  }
  saveSel();
});

document.querySelectorAll('.toolbar button[data-chip]').forEach(b => b.onclick = e => {
  e.preventDefault();
  restoreSel();
  document.execCommand('insertText', false, b.dataset.chip);
  saveSel();
});

$('btnHtmlView').onclick = () => {
  const ta = $('htmlSource');
  if (ta.classList.contains('hidden')) {
    ta.value = editor.innerHTML;
    ta.classList.remove('hidden');
    editor.classList.add('hidden');
  } else {
    editor.innerHTML = ta.value;
    ta.classList.add('hidden');
    editor.classList.remove('hidden');
  }
};

const bodyHtml = () => $('htmlSource').classList.contains('hidden') ? editor.innerHTML : $('htmlSource').value;

/* draft autosave */
const DRAFT_KEY = 'mailblaster.draft';
const DRAFT_FIELDS = ['subject', 'greeting', 'closing', 'footerHtml', 'fallbackName', 'delayMs', 'rawEmails',
  'footerImgW', 'footerImgPos', 'footerImgLink'];
(function restoreDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
    DRAFT_FIELDS.forEach(k => { if (d[k] != null) $(k).value = d[k]; });
    if (d.body) editor.innerHTML = d.body;
    if (d.footerImage) { footerImage = d.footerImage; renderFooterImg(); }
  } catch (e) {}
})();
function saveDraft() {
  const d = { body: bodyHtml(), footerImage };
  DRAFT_FIELDS.forEach(k => d[k] = $(k).value);
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch (e) {
    // localStorage is ~5 MB; a large signature can overflow it. Keep the text.
    delete d.footerImage;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  }
}
DRAFT_FIELDS.forEach(k => $(k).addEventListener('input', saveDraft));
editor.addEventListener('input', saveDraft);

/* ---- footer image (signature / banner) ---- */

function renderFooterImg() {
  const el = $('footerImgPrev');
  if (!footerImage) { el.innerHTML = ''; return; }
  const w = $('footerImgW').value || 220;
  el.innerHTML = '<img src="data:' + footerImage.mime + ';base64,' + footerImage.content
    + '" style="width:' + w + 'px;max-width:100%"/>'
    + '<div class="lbl">' + esc(footerImage.filename) + ' · '
    + Math.round(footerImage.content.length * 0.75 / 1024) + ' KB</div>';
}

$('footerImg').onchange = async () => {
  const f = $('footerImg').files[0];
  if (!f) return;
  if (f.size > 2 * 1024 * 1024 &&
      !confirm('That image is ' + (f.size / 1048576).toFixed(1) + ' MB. Big signatures slow every send '
             + 'and can trip spam filters. Use it anyway?')) {
    $('footerImg').value = '';
    return;
  }
  const b64 = await readFileB64(f);
  footerImage = { filename: f.name, content: b64.content, mime: f.type || 'image/png' };
  renderFooterImg();
  saveDraft();
};

$('btnClearImg').onclick = () => {
  footerImage = null;
  $('footerImg').value = '';
  renderFooterImg();
  saveDraft();
};

$('footerImgW').addEventListener('input', renderFooterImg);

$('files').onchange = () => {
  $('fileList').innerHTML = Array.from($('files').files)
    .map(f => '<span>📎 ' + esc(f.name) + ' · ' + (f.size / 1024).toFixed(0) + ' KB</span>').join('');
};

function fill(tpl, r) {
  const fb = $('fallbackName').value || 'there';
  const first = r.first || fb, full = r.full || fb;
  return String(tpl || '')
    .replace(/\{\{\s*name\s*\}\}/gi, first)
    .replace(/\{\{\s*first_?name\s*\}\}/gi, first)
    .replace(/\{\{\s*full_?name\s*\}\}/gi, full)
    .replace(/\{\{\s*email\s*\}\}/gi, r.email);
}

$('btnPreview').onclick = () => {
  if (!recipients.length) return say($('sendMsg'), 'Parse some recipients first (Section 2).', false);
  const r = recipients[0], p = $('preview');
  p.classList.remove('hidden');
  const img = footerImage
    ? '<img src="data:' + footerImage.mime + ';base64,' + footerImage.content
      + '" style="display:block;width:' + ($('footerImgW').value || 220) + 'px;max-width:100%;margin:10px 0"/>'
    : '';
  const footerBlock = $('footerImgPos').value === 'above'
    ? img + fill($('footerHtml').value, r)
    : fill($('footerHtml').value, r) + img;

  p.innerHTML =
    '<div class="to"><b>To:</b> ' + esc(r.email) + ' &nbsp; <b>Subject:</b> ' + esc(fill($('subject').value, r)) + '</div>'
    + '<p>' + esc(fill($('greeting').value, r)) + '</p>'
    + fill(bodyHtml(), r)
    + ($('closing').value ? '<p style="white-space:pre-line">' + esc(fill($('closing').value, r)) + '</p>' : '')
    + (footerBlock ? '<hr/>' + footerBlock : '');
};

/* The send loop lives in this tab: closing or reloading mid-campaign kills it.
   Warn before that happens, and let the user resume by skipping addresses that
   already went out. */
let sending = false;
let stopRequested = false;

window.addEventListener('beforeunload', e => {
  if (!sending) return;
  e.preventDefault();
  e.returnValue = 'A campaign is still sending. Leaving this page stops it.';
  return e.returnValue;
});

/* Most recent delivered email for each of the given addresses, taken from the
   log already loaded into Section 4. */
function previousSendsFor(emails) {
  const want = new Set(emails);
  const out = {};
  for (const e of logCache) {                 // logCache is newest-first
    const to = String(e.to).toLowerCase();
    if (e.status === 'sent' && want.has(to) && !out[to]) out[to] = e;
  }
  return out;
}

/* Show the exact message a recipient received, merge tags already resolved. */
function viewSent(i) {
  const e = logCache[i];
  if (!e) return;
  $('modalTitle').textContent = e.subject || '(no subject)';
  $('modalMeta').innerHTML =
    '<b>To:</b> ' + esc(e.to) + ' &nbsp;&middot;&nbsp; <b>From:</b> ' + esc(e.from)
    + ' &nbsp;&middot;&nbsp; ' + new Date(e.time).toLocaleString()
    + ' &nbsp;&middot;&nbsp; <span class="badge ' + e.status + '">' + e.status + '</span>'
    + (e.attachments && e.attachments.length
        ? ' &nbsp;&middot;&nbsp; attached: ' + e.attachments.map(esc).join(', ') : '')
    + (e.error ? '<br/><span class="msg bad">' + esc(e.error) + '</span>' : '');
  $('modalBody').innerHTML = e.body
    ? e.body
    : '<p class="hint">The body was not recorded for this send &mdash; it predates body logging.</p>';
  $('modal').classList.remove('hidden');
}

function closeModal() { $('modal').classList.add('hidden'); }
$('modalClose').onclick = closeModal;
$('modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* Every address that has ever been delivered, from whichever log is live. */
async function sentAddresses() {
  const out = new Set();
  try {
    const r = await fetch('/api/log').then(x => x.json());
    if (r && r.ok && r.available) {
      r.rows.forEach(e => { if (e.status === 'sent') out.add(String(e.to).toLowerCase()); });
      return out;
    }
  } catch (e) {}
  localLogAll().forEach(e => { if (e.status === 'sent') out.add(String(e.to).toLowerCase()); });
  return out;
}

$('btnStop').onclick = () => {
  stopRequested = true;
  say($('sendMsg'), 'Stopping after the current email…', false);
};

$('btnFallbackFlagged').onclick = () => {
  const flagged = recipients.filter(r => !r.generic && r.confidence === 'low');
  if (!flagged.length) return say($('parseMsg'), 'No flagged names to replace.', true);
  if (!confirm('Replace ' + flagged.length + ' flagged name(s) with the fallback greeting "'
      + ($('fallbackName').value || 'there') + '"?')) return;
  flagged.forEach(r => { r.first = ''; r.full = ''; r.generic = true; });
  renderRecipients();
  say($('parseMsg'), flagged.length + ' flagged name(s) now use the fallback greeting.', true);
};

$('btnSkipSent').onclick = async () => {
  if (!recipients.length) return say($('parseMsg'), 'Parse the list first.', false);
  const done = await sentAddresses();
  const before = recipients.length;
  recipients = recipients.filter(r => !done.has(r.email));
  renderRecipients();
  const removed = before - recipients.length;
  say($('parseMsg'),
    removed
      ? 'Removed ' + removed + ' address(es) already delivered · ' + recipients.length + ' left to send'
      : 'None of these have been delivered yet — nothing removed.',
    true);
};

function readFileB64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve({ filename: file.name, content: String(fr.result).split(',')[1] });
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

$('btnSend').onclick = async () => {
  const c = creds();
  if (!c.gUser || !c.gPass) return say($('sendMsg'), 'Add your Gmail + app password in Section 1.', false);
  if (!recipients.length) return say($('sendMsg'), 'No recipients — parse them in Section 2.', false);

  // Final de-duplication guard, in case rows were edited after parsing.
  const uniq = new Map();
  recipients.forEach(r => { if (!uniq.has(r.email)) uniq.set(r.email, r); });
  if (uniq.size !== recipients.length) {
    const dropped = recipients.length - uniq.size;
    recipients = [...uniq.values()];
    renderRecipients();
    say($('sendMsg'), 'Removed ' + dropped + ' duplicate address(es) before sending.', true);
  }

  // Warn about anyone who has already received mail in a previous run.
  const delivered = await sentAddresses();
  const repeats = recipients.filter(r => delivered.has(r.email));
  if (repeats.length) {
    const prev = previousSendsFor(repeats.map(r => r.email));
    const preview = repeats.slice(0, 5).map(r => {
      const p = prev[r.email];
      return p
        ? r.email + '  ->  "' + p.subject + '"  sent ' + new Date(p.time).toLocaleDateString()
        : r.email;
    }).join('\n');
    const answer = confirm(
      repeats.length + ' of these have already been delivered to previously:\n\n' + preview
      + (repeats.length > 5 ? '\n…and ' + (repeats.length - 5) + ' more' : '')
      + '\n\nOK = skip them and send to the other ' + (recipients.length - repeats.length)
      + '\nCancel = send to everyone anyway (they get it twice)'
      + '\n\nTo read the exact email they received, cancel and open Section 4, then View.');
    if (answer) {
      recipients = recipients.filter(r => !delivered.has(r.email));
      renderRecipients();
      if (!recipients.length) return say($('sendMsg'), 'Everyone on this list has already been sent to.', false);
    }
  }

  const files = Array.from($('files').files);
  let totalBytes = files.reduce((a, f) => a + f.size, 0);
  if (footerImage) totalBytes += footerImage.content.length * 0.75;
  if (totalBytes > 3.5 * 1024 * 1024) {
    if (!confirm('Attachments total ' + (totalBytes / 1048576).toFixed(1) + ' MB. Hosted serverless functions '
      + 'usually cap a request body around 4.5 MB, so this may fail online (it is fine locally). Continue?')) return;
  }
  if (!confirm('Send to ' + recipients.length + ' recipient(s)?')) return;

  const attachments = await Promise.all(files.map(readFileB64));
  const base = {
    user: c.gUser, pass: c.gPass, port: c.smtpPort, fromName: c.fromName, replyTo: c.replyTo,
    subject: $('subject').value,
    greeting: $('greeting').value,
    bodyHtml: bodyHtml(),
    closing: $('closing').value,
    footerHtml: $('footerHtml').value,
    fallbackName: $('fallbackName').value || 'there',
    attachments,
    footerImage: footerImage ? { filename: footerImage.filename, content: footerImage.content } : null,
    footerImageWidth: $('footerImgW').value,
    footerImagePosition: $('footerImgPos').value,
    footerImageLink: $('footerImgLink').value.trim(),
  };

  const delay = Math.max(0, parseInt($('delayMs').value || '800', 10));
  const total = recipients.length;
  let sent = 0, failed = 0;

  sending = true;
  $('btnSend').disabled = true;
  $('btnStop').classList.remove('hidden');
  stopRequested = false;
  $('progressWrap').classList.remove('hidden');
  say($('sendMsg'), 'Sending… keep this tab open — closing or reloading it stops the campaign.', true);

  let stopped = false;
  for (let i = 0; i < total; i++) {
    if (stopRequested) { stopped = true; break; }
    const r = recipients[i];
    let entry;
    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ recipient: r }, base)),
      }).then(x => x.json());
      entry = res.entry || {
        time: new Date().toISOString(), from: c.gUser, to: r.email, name: r.first,
        subject: base.subject, attachments: [], status: 'failed', error: res.error || 'Unknown error',
      };
    } catch (e) {
      entry = {
        time: new Date().toISOString(), from: c.gUser, to: r.email, name: r.first || base.fallbackName,
        subject: base.subject, attachments: attachments.map(a => a.filename),
        status: 'failed', error: e.message,
      };
    }
    if (entry.status === 'sent') sent++; else failed++;
    localLog(entry);
    loadAnalytics();   // Section 4 updates live, not just at the end

    $('bar').style.width = ((i + 1) / total * 100) + '%';
    $('progressText').textContent = (i + 1) + ' / ' + total + ' · ' + sent + ' delivered · ' + failed + ' failed'
      + (entry.status === 'failed' ? ' · last error: ' + entry.error : '');
    if (delay && i < total - 1) await new Promise(s => setTimeout(s, delay));
  }

  sending = false;
  $('btnStop').classList.add('hidden');
  say($('sendMsg'),
    (stopped ? '■ Stopped — ' : '✓ Finished — ') + sent + ' delivered, ' + failed + ' failed.'
      + (stopped || failed ? ' Use "Skip already-sent" in Section 2 before resuming.' : ''),
    !stopped && failed === 0);
  $('btnSend').disabled = false;
  loadAnalytics();
};

/* ================= SECTION 4 — analytics ================= */
/* Every send is recorded in localStorage; when the app runs somewhere with a
   writable disk (i.e. locally) the same rows are also archived in SQLite and
   that copy wins, so history survives clearing the browser. */

const LOG_KEY = 'mailblaster.log';
let logCache = [];

function localLogAll() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { return []; }
}
function localLog(entry) {
  const all = localLogAll();
  all.push(entry);
  localStorage.setItem(LOG_KEY, JSON.stringify(all.slice(-3000)));
}

async function loadAnalytics() {
  let rows = null;
  let source = '<b>This browser only</b> — history is kept in localStorage, so other devices '
    + 'and other people see nothing. Connect a Postgres database to share it.';
  try {
    const r = await fetch('/api/log').then(x => x.json());
    if (r && r.ok && r.available) {
      rows = r.rows;
      source = r.driver === 'postgres'
        ? '<b>Shared database</b> — every device and visitor sees this same history.'
        : '<b>SQLite</b> — <span class="mono">data/mail.db</span> on this machine.';
    } else if (r && r.reason) {
      source += '<br/><span class="mono">' + esc(r.reason) + '</span>';
    }
  } catch (e) {}
  if (!rows) rows = localLogAll().slice().reverse();

  logCache = rows;
  $('logSource').innerHTML = source;

  const total = rows.length;
  const sent = rows.filter(e => e.status === 'sent').length;
  const failed = total - sent;
  $('stTotal').textContent = total;
  $('stSent').textContent = sent;
  $('stFailed').textContent = failed;
  $('stRate').textContent = (total ? Math.round(sent / total * 100) : 0) + '%';

  const byDay = {};
  rows.forEach(e => {
    const d = String(e.time).slice(0, 10);
    if (!byDay[d]) byDay[d] = { day: d, sent: 0, failed: 0 };
    if (e.status === 'sent') byDay[d].sent++; else byDay[d].failed++;
  });
  const days = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)).slice(-30);
  const max = Math.max(1, ...days.map(d => d.sent + d.failed));
  $('chart').innerHTML = days.length
    ? days.map(d =>
        '<div class="col" title="' + d.day + ': ' + d.sent + ' sent, ' + d.failed + ' failed">'
        + '<div class="stack" style="height:' + ((d.sent + d.failed) / max * 110) + 'px">'
        + '<div class="s" style="flex:' + d.sent + '"></div>'
        + '<div class="f" style="flex:' + d.failed + '"></div></div>'
        + '<div class="lbl">' + d.day.slice(5) + '</div></div>').join('')
    : '<div class="lbl">No data yet</div>';

  renderLog();
}

function renderLog() {
  const q = $('search').value.toLowerCase();
  const rows = logCache.filter(e => !q ||
    String(e.to).toLowerCase().includes(q) || String(e.subject).toLowerCase().includes(q));
  document.querySelector('#logTable tbody').innerHTML = rows.map(e =>
    '<tr>'
    + '<td>' + new Date(e.time).toLocaleString() + '</td>'
    + '<td>' + esc(e.to) + '</td>'
    + '<td>' + esc(e.name) + '</td>'
    + '<td>' + esc(e.subject) + '</td>'
    + '<td>' + (e.attachments && e.attachments.length ? '📎 ' + e.attachments.length : '—') + '</td>'
    + '<td><span class="badge ' + e.status + '" title="' + esc(e.error || '') + '">' + e.status + '</span></td>'
    + '<td><button class="view" data-i="' + logCache.indexOf(e) + '">View</button></td>'
    + '</tr>').join('') || '<tr><td colspan="7">Nothing to show.</td></tr>';

  document.querySelectorAll('#logTable .view').forEach(b => b.onclick = () => viewSent(+b.dataset.i));
}

$('search').oninput = renderLog;
$('btnRefresh').onclick = loadAnalytics;
$('btnClear').onclick = async () => {
  if (!confirm('Delete the entire send history?')) return;
  localStorage.removeItem(LOG_KEY);
  try { await fetch('/api/log', { method: 'DELETE' }); } catch (e) {}
  loadAnalytics();
};
$('btnExport').onclick = () => {
  const head = ['time', 'from', 'to', 'name', 'subject', 'attachments', 'status', 'error'];
  const csv = [head.join(',')].concat(logCache.map(e =>
    head.map(k => '"' + String(k === 'attachments' ? (e[k] || []).join(' | ') : (e[k] == null ? '' : e[k])).replace(/"/g, '""') + '"').join(',')
  )).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'mailblaster-log.csv';
  a.click();
};

loadAnalytics();
