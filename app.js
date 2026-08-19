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

/* ================= SECTION 1 — Gmail app password ================= */

const CRED_KEY = 'mailblaster.creds';
(function restore() {
  try {
    const c = JSON.parse(localStorage.getItem(CRED_KEY) || '{}');
    ['gUser', 'gPass', 'fromName', 'replyTo'].forEach(k => { if (c[k]) $(k).value = c[k]; });
  } catch (e) {}
})();

function creds() {
  return {
    gUser: $('gUser').value.trim(),
    gPass: $('gPass').value.trim(),
    fromName: $('fromName').value.trim(),
    replyTo: $('replyTo').value.trim(),
  };
}
function persist() {
  if ($('remember').checked) localStorage.setItem(CRED_KEY, JSON.stringify(creds()));
  else localStorage.removeItem(CRED_KEY);
}
['gUser', 'gPass', 'fromName', 'replyTo', 'remember'].forEach(id => $(id).addEventListener('change', persist));

$('btnVerify').onclick = async () => {
  const b = $('btnVerify');
  b.disabled = true;
  say($('verifyMsg'), 'Connecting to smtp.gmail.com…', true);
  try {
    const c = creds();
    const r = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: c.gUser, pass: c.gPass }),
    }).then(x => x.json());
    say($('verifyMsg'), r.ok ? '✓ ' + r.message : '✗ ' + r.error, r.ok);
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
  'general', 'desk', 'reception', 'md', 'ceo', 'the', 'and']);

const titleCase = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

function parseName(email) {
  const local = String(email).split('@')[0] || '';
  let tokens = local.replace(/[0-9]+/g, ' ').split(/[._\-+\s]+/).filter(Boolean);
  tokens = tokens.flatMap(t => t.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ')).filter(Boolean);
  const named = tokens.filter(t => !GENERIC.has(t.toLowerCase()) && t.length > 1);
  if (!named.length) return { first: '', full: '', generic: true };
  const parts = named.slice(0, 2).map(titleCase);
  return { first: parts[0], full: parts.join(' '), generic: false };
}

$('btnParse').onclick = () => {
  const found = ($('rawEmails').value.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || []);
  const seen = new Set();
  recipients = [];
  for (const e of found) {
    const email = e.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    recipients.push(Object.assign({ email }, parseName(email)));
  }
  renderRecipients();
  const generic = recipients.filter(x => x.generic).length;
  say($('parseMsg'),
    recipients.length + ' unique email(s) · ' + (recipients.length - generic) + ' name(s) parsed'
    + (generic ? ' · ' + generic + ' will use the fallback name' : ''),
    recipients.length > 0);
};

function renderRecipients() {
  const tb = document.querySelector('#recTable tbody');
  tb.innerHTML = recipients.map((r, i) =>
    '<tr class="' + (r.generic ? 'generic' : '') + '">'
    + '<td>' + (i + 1) + '</td>'
    + '<td>' + esc(r.email) + '</td>'
    + '<td><input data-i="' + i + '" class="nm" value="' + esc(r.first) + '" placeholder="' + esc($('fallbackName').value) + '"/></td>'
    + '<td>' + (r.generic ? '<span class="badge g">generic inbox</span>' : '<span class="badge p">from email id</span>') + '</td>'
    + '<td><button data-del="' + i + '">✕</button></td>'
    + '</tr>').join('');

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
const DRAFT_FIELDS = ['subject', 'greeting', 'closing', 'footerHtml', 'fallbackName', 'delayMs', 'rawEmails'];
(function restoreDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
    DRAFT_FIELDS.forEach(k => { if (d[k] != null) $(k).value = d[k]; });
    if (d.body) editor.innerHTML = d.body;
  } catch (e) {}
})();
function saveDraft() {
  const d = { body: bodyHtml() };
  DRAFT_FIELDS.forEach(k => d[k] = $(k).value);
  localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
}
DRAFT_FIELDS.forEach(k => $(k).addEventListener('input', saveDraft));
editor.addEventListener('input', saveDraft);

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
  p.innerHTML =
    '<div class="to"><b>To:</b> ' + esc(r.email) + ' &nbsp; <b>Subject:</b> ' + esc(fill($('subject').value, r)) + '</div>'
    + '<p>' + esc(fill($('greeting').value, r)) + '</p>'
    + fill(bodyHtml(), r)
    + ($('closing').value ? '<p style="white-space:pre-line">' + esc(fill($('closing').value, r)) + '</p>' : '')
    + ($('footerHtml').value ? '<hr/>' + fill($('footerHtml').value, r) : '');
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

  const files = Array.from($('files').files);
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  if (totalBytes > 3.5 * 1024 * 1024) {
    if (!confirm('Attachments total ' + (totalBytes / 1048576).toFixed(1) + ' MB. Hosted serverless functions '
      + 'usually cap a request body around 4.5 MB, so this may fail online (it is fine locally). Continue?')) return;
  }
  if (!confirm('Send to ' + recipients.length + ' recipient(s)?')) return;

  const attachments = await Promise.all(files.map(readFileB64));
  const base = {
    user: c.gUser, pass: c.gPass, fromName: c.fromName, replyTo: c.replyTo,
    subject: $('subject').value,
    greeting: $('greeting').value,
    bodyHtml: bodyHtml(),
    closing: $('closing').value,
    footerHtml: $('footerHtml').value,
    fallbackName: $('fallbackName').value || 'there',
    attachments,
  };

  const delay = Math.max(0, parseInt($('delayMs').value || '800', 10));
  const total = recipients.length;
  let sent = 0, failed = 0;

  $('btnSend').disabled = true;
  $('progressWrap').classList.remove('hidden');
  say($('sendMsg'), 'Sending…', true);

  for (let i = 0; i < total; i++) {
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

    $('bar').style.width = ((i + 1) / total * 100) + '%';
    $('progressText').textContent = (i + 1) + ' / ' + total + ' · ' + sent + ' delivered · ' + failed + ' failed'
      + (entry.status === 'failed' ? ' · last error: ' + entry.error : '');
    if (delay && i < total - 1) await new Promise(s => setTimeout(s, delay));
  }

  say($('sendMsg'), '✓ Finished — ' + sent + ' delivered, ' + failed + ' failed.', failed === 0);
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
  let rows = null, source = 'this browser (localStorage)';
  try {
    const r = await fetch('/api/log').then(x => x.json());
    if (r && r.ok && r.available) { rows = r.rows; source = 'SQLite (data/mail.db)'; }
  } catch (e) {}
  if (!rows) rows = localLogAll().slice().reverse();

  logCache = rows;
  $('logSource').textContent = 'Source: ' + source;

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
    + '</tr>').join('') || '<tr><td colspan="6">Nothing to show.</td></tr>';
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
