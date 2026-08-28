const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ================= multi-account sessions =================
   Several Gmail accounts can each have a campaign in flight at once in this
   one tab. Everything that used to be a single module-level flag (sending,
   stopRequested) or a single cache (campaignCache, logCache, followupAudience,
   replyCache) is a cross-contamination bug waiting to happen the moment a
   second account is added: Stop on account B would silently also kill
   account A's still-running send loop, because both read and write the same
   variable. This map is the fix — one slot of state per account, addressed
   by lowercased email, so two accounts sending concurrently can never step on
   each other.

   The single-account UI (Sections 1-5) still shows exactly one account's
   state at a time; `activeAccount()` says which. Switching accounts is a
   cheap pointer change, not a page reload — sending, once started, keeps
   running against ITS OWN account's session even while a different one is
   the one currently shown on screen. */
const ACCOUNTS_KEY = 'mailblaster.accounts';   // ordered list of saved account emails
const sessions = new Map();                    // email -> AccountSession

/* Declared up here, not where Section 5's campaign-drilldown code actually
   uses them, because selectAccount() (just below) already writes to
   campaignCache on page load via restore() -> selectAccount() for ANY
   returning user with even one saved account. A `let` declared later in the
   file is real, but unusable until its own line runs (the temporal dead
   zone) — reading it from a function that CAN be called earlier throws
   "Cannot access before initialization" the moment that happens, which broke
   every returning user's first page load the instant selectAccount() started
   touching this cache. Moving the declaration, not just working around the
   read, is what actually fixes it — Section 5's code still declares nothing
   new, it just no longer redeclares what already exists up here. */
let campaignCache = [];
let currentCampaign = null;

function newSession(email) {
  return {
    email,
    gPass: '', fromName: '', replyTo: '', smtpPort: '587',
    sending: false, stopRequested: false,
    lastError: null,
    sentToday: null,           // filled in by refreshQuota()
    progress: null,            // { done, total } while sending, so the account card can show "sending 7/50"
    /* Off by default — see the checkbox's own label in Section 1 for why:
       this trades a real network round-trip (and its own failure mode)
       before every send for fresher suppression. "Scan for replies" in
       Section 6 does the same thing on demand for anyone who'd rather not
       pay that cost automatically. */
    autoScanOnSend: false,
  };
}

function session(email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return null;
  if (!sessions.has(key)) sessions.set(key, newSession(key));
  return sessions.get(key);
}

let activeAccountEmail = '';
const activeAccount = () => session(activeAccountEmail);

function savedAccountList() {
  try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]'); } catch (e) { return []; }
}
function saveAccountList(list) {
  try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list)); } catch (e) {}
}
/* Per-account credentials are namespaced by email so adding a second account
   can never overwrite the first's saved App Password — the single flat
   'mailblaster.creds' key this replaced could only ever hold one account. */
const acctCredsKey = email => 'mailblaster.creds.' + email;
function loadAccountCreds(email) {
  try { return JSON.parse(localStorage.getItem(acctCredsKey(email)) || '{}'); } catch (e) { return {}; }
}
function saveAccountCreds(email, creds) {
  try { localStorage.setItem(acctCredsKey(email), JSON.stringify(creds)); } catch (e) {}
}

let recipients = [];

/* ---------- API key ----------
   When the deployment sets MAILBLASTER_API_KEY every endpoint requires it, so
   the page needs it too. It is attached in one place rather than at each of
   the call sites: a request that quietly forgets the header would surface as a
   confusing 401 rather than an obvious mistake.

   This is a deployment secret, not a per-user credential — anyone holding it
   can read everything this deployment stores. It lives in localStorage next to
   the Gmail settings, and is sent only to this origin. */
const API_KEY_STORE = 'mailblaster.apikey';

function apiKey() {
  try { return localStorage.getItem(API_KEY_STORE) || ''; } catch (e) { return ''; }
}
function setApiKey(v) {
  try {
    if (v) localStorage.setItem(API_KEY_STORE, v);
    else localStorage.removeItem(API_KEY_STORE);
  } catch (e) {}
}

/* Wrap fetch once, so every current and future call carries the key. Only
   same-origin /api/ requests are touched — the key must never be attached to
   a third-party URL. */
const rawFetch = window.fetch.bind(window);
window.fetch = function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  const key = apiKey();
  if (key && url.indexOf('/api/') === 0) {
    const opts = Object.assign({}, init);
    opts.headers = Object.assign({}, (init && init.headers) || {}, { 'X-API-Key': key });
    return rawFetch(input, opts);
  }
  return rawFetch(input, init);
};

/* A 401 means the key is missing or wrong; say so once, plainly, rather than
   letting every panel fail with its own vague message. */
let keyPromptShown = false;
async function apiGet(url) {
  const r = await fetch(url).then(x => x.json());
  if (r && r.code === 'UNAUTHORIZED') promptForKey();
  return r;
}
function promptForKey() {
  if (keyPromptShown) return;
  keyPromptShown = true;
  const v = prompt('This deployment requires an API key.\n\n'
    + 'Paste the value of MAILBLASTER_API_KEY from your Vercel project settings.');
  if (v) { setApiKey(v.trim()); location.reload(); }
}

/* Wire the API key field, and tell the user whether this deployment needs one
   so an empty box is never mistaken for a broken page. */
if ($('apiKeyInput')) {
  $('apiKeyInput').value = apiKey();
  $('btnSaveKey').onclick = function () {
    setApiKey($('apiKeyInput').value.trim());
    say($('apiKeyMsg'), 'Saved. Reloading…', true);
    setTimeout(function () { location.reload(); }, 500);
  };
  $('btnClearKey').onclick = function () {
    setApiKey('');
    $('apiKeyInput').value = '';
    say($('apiKeyMsg'), 'Key forgotten on this browser.', true);
  };
  /* /api/log answers without a key when none is configured, so it doubles as
     the probe for whether this deployment is protected. */
  rawFetch('/api/log').then(function (r) { return r.json(); }).then(function (r) {
    const state = $('apiKeyState');
    if (r && r.code === 'UNAUTHORIZED') {
      state.textContent = apiKey() ? 'saved key rejected' : 'required';
      if (!apiKey()) $('apiKeyBox').open = true;
    } else {
      state.textContent = 'not required here';
    }
  }).catch(function () {});
}

/* ---------- mail window ----------
   One <template> in index.html, cloned into every place that composes an
   email. Each mount carries a prefix, and every data-id inside the clone
   becomes prefix+Id — so the compose window owns composeSubject/composeEditor
   and the follow-up owns fuSubject/fuEditor, from identical markup.

   Doing it this way rather than copying the block means the two windows
   cannot drift apart: a change to the toolbar or the signature block lands in
   both, and there is exactly one definition to maintain. */
/* Clone the template into one mount point. Pulled out of mountMailWindows()
   so a mount added after page load (the multi-account checklist's extra
   windows in Section 4) can go through the exact same stamping, rather than
   a second, slightly different copy of this logic. */
function mountOneMailWindow(mount) {
  const tpl = document.getElementById('mailWindowTpl');
  if (!tpl) return;
  const prefix = mount.dataset.prefix;
  const mode = mount.dataset.mode || 'campaign';
  const node = tpl.content.cloneNode(true);

  // rows that belong to only one mode (the thread picker, the quoted original)
  node.querySelectorAll('[data-only]').forEach(el => {
    if (el.dataset.only !== mode) el.remove();
  });

  // data-id -> a real, unique id for this instance
  node.querySelectorAll('[data-id]').forEach(el => {
    el.id = prefix + el.dataset.id;
    el.removeAttribute('data-id');
  });
  node.querySelectorAll('[data-for]').forEach(el => {
    el.setAttribute('for', prefix + el.dataset.for);
    el.removeAttribute('data-for');
  });
  // toolbars act on this instance's editor
  node.querySelectorAll('.toolbar [data-cmd], .toolbar [data-chip]').forEach(b => {
    b.dataset.target = prefix + 'Editor';
  });

  mount.appendChild(node);
}

function mountMailWindows() {
  document.querySelectorAll('.mailmount').forEach(mountOneMailWindow);
}
mountMailWindows();

/* Reach a field of one mail window: mw('compose','Subject'). */
const mw = (prefix, name) => document.getElementById(prefix + name);

/* ---------- tabs ---------- */

/* Shared by every nav control that switches which section shows — the
   persistent Accounts/Activity buttons (class "tab"), the wizard step
   strip (class "wstep"), and the in-page "Find that past campaign" /
   "the Replies screen" links (class "tab", styled inline via "linklike")
   — so there is exactly one place that knows how to switch panels, not
   one copy per nav style. */
function goToSection(tabId) {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tab[data-tab="' + tabId + '"]').forEach(x => x.classList.add('active'));
  $(tabId).classList.add('active');
  if (tabId === 's5') { loadAnalytics(); loadCampaigns(); }
  if (tabId === 's6') loadCampaigns();
  refreshWizardSteps();
}

document.querySelectorAll('.tab').forEach(t => t.onclick = () => goToSection(t.dataset.tab));
document.querySelectorAll('.wstep').forEach(t => t.onclick = () => {
  goToSection(t.dataset.tab);
  if (t.dataset.substep === 'review') { composeSubstep = 'review'; jumpToComposeReview(); }
  else if (t.dataset.substep === 'send') { composeSubstep = 'send'; jumpToComposeSend(); }
  else if (t.dataset.tab === 's4') composeSubstep = 'compose';
  refreshWizardSteps();
});

/* Compose/Review/Send all live in the SAME panel (s4) — they only differ by
   which part of it you're working on, which the panel id alone can't say.
   Tracked as one small piece of real state rather than inferred from scroll
   position (unreliable, and adding an IntersectionObserver just to answer
   "which section are you looking at" would be real complexity for a purely
   cosmetic indicator). The wizard strip is the only way into s4 at all
   (checked: nothing else targets it), so every entry sets this explicitly —
   there's no other route that could leave it stale. */
let composeSubstep = 'compose';

/* The step strip's current/done state tracks whichever section is ACTUALLY
   showing wherever that's unambiguous (Recipients = s3), and composeSubstep
   for the one panel where it isn't. Every earlier step reads as done once
   you've moved past it. Accounts (s1) and Activity (s5/s6) aren't part of
   this sequence at all, so no wizard step lights up for either. */
function refreshWizardSteps() {
  const strip = $('wizardSteps');
  if (!strip) return;
  const activePanel = document.querySelector('.panel.active');
  const activeId = activePanel ? activePanel.id : '';
  const substepOrder = { compose: 2, review: 3, send: 4 };
  const currentStep = activeId === 's3' ? 1 : activeId === 's4' ? (substepOrder[composeSubstep] || 2) : 0;
  strip.querySelectorAll('.wstep').forEach(el => {
    const n = Number(el.dataset.stepnum);
    el.classList.toggle('done', currentStep > 0 && n < currentStep);
    el.classList.toggle('current', currentStep > 0 && n === currentStep);
  });

  /* Compose/Review/Send are one panel (s4) with three blocks tagged
     data-substep="compose|review|send" — a CSS class on the panel itself
     shows only the matching block(s), so clicking a step actually swaps
     what's on screen instead of just scrolling within one long page. The
     From/To/Subject header has no data-substep, so it stays visible
     throughout — you always know who you're writing to and what the
     subject is, on every one of the three "screens." */
  const composePanel = $('s4');
  if (composePanel) {
    composePanel.classList.remove('substep-compose', 'substep-review', 'substep-send');
    composePanel.classList.add('substep-' + composeSubstep);
  }
  // The heading said "Compose" even while showing Review or Send — same
  // panel, so the text has to be kept in sync with composeSubstep by hand.
  if ($('s4heading')) {
    const heading = { compose: 'Step 2 — Compose', review: 'Step 3 — Review', send: 'Step 4 — Send' };
    $('s4heading').textContent = heading[composeSubstep] || heading.compose;
  }
}
refreshWizardSteps();

/* Review and Send aren't separate panels — they're further down the SAME
   compose panel (s4) — so clicking either step must DO the thing, not just
   scroll toward a button and leave the click for you: a scroll to a button
   already in view produces no visible motion at all, which reads as "this
   step does nothing." Review actually renders the preview (using the first
   parsed recipient, exactly what the Preview button itself does) rather
   than waiting for a second click on a button it just scrolled past. */
function jumpToComposeReview() {
  const list = instanceRecipients('compose');
  const el = $('preview');
  if (list.length && el) {
    renderSinglePreview('compose', list[0], el);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    say($('composeMsg'), 'Parse some recipients first (Step 1), then Review will show what they’ll actually receive.', false);
    if ($('composeBtnPreview')) $('composeBtnPreview').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
function jumpToComposeSend() {
  const btn = $('composeBtnSend');
  if (!btn) return;
  btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // A scroll to a button already on screen has no visible motion at all —
  // flash it so clicking "Send" from the step strip is never silent.
  btn.classList.add('flash');
  setTimeout(() => btn.classList.remove('flash'), 900);
}

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

/* ================= SECTION 1 — Gmail accounts ================= */

/* The form (#gUser etc.) always edits whichever account is "active" — the
   one expanded in the account list below. creds() keeps its old shape and
   name so every other function in this file that already calls creds()
   needs no change; only what backs it moved from one flat localStorage key
   to a per-account session. */
function creds() {
  return {
    gUser: $('gUser').value.trim(),
    gPass: $('gPass').value.trim(),
    fromName: $('fromName').value.trim(),
    replyTo: $('replyTo').value.trim(),
    smtpPort: $('smtpPort').value,
  };
}

function fillAccountForm(email) {
  const s = session(email) || newSession('');
  $('gUser').value = email || '';
  $('gPass').value = s.gPass || '';
  $('fromName').value = s.fromName || '';
  $('replyTo').value = s.replyTo || '';
  $('smtpPort').value = s.smtpPort || '587';
  if ($('autoScanOnSend')) $('autoScanOnSend').checked = !!s.autoScanOnSend;
  $('editingAccountLabel').textContent = email || '— new account —';

  /* This browser may not have the password (fresh browser, cleared storage,
     or it was only ever saved server-side) even though the account is known
     server-side. Fetch it once and fill the field in — the whole point of
     saving to the database is that editing display name / reply-to never
     forces the app password to be typed in again. Fired after the
     synchronous fill above so the field is never left showing a stale value
     while this is in flight; guarded by whichever account is still open by
     the time it resolves, so switching accounts mid-fetch can't stomp the
     next one's field. */
  if (email && !s.gPass) {
    fetchSavedAccountPassword(email);
  }
}

async function fetchSavedAccountPassword(email) {
  try {
    const r = await fetch('/api/accounts?email=' + encodeURIComponent(email) + '&reveal=1').then(x => x.json());
    if (r && r.ok && r.account && r.account.password) {
      const s = session(email);
      s.gPass = r.account.password;
      if (activeAccountEmail === email && $('gUser').value.trim().toLowerCase() === email) {
        $('gPass').value = s.gPass;
      }
    }
  } catch (e) { /* no saved server-side copy, or DB unavailable — the form just stays blank */ }
}

/* The add/edit form stays hidden once at least one account exists, so
   Section 1's default view is just the compact card list — opened
   deliberately by "+ Add another account" or a card's own "Edit", and
   closed again after a successful Verify or Cancel. A fresh install with
   nothing saved yet opens it automatically (see restore(), below), since a
   list with nothing on it and no visible way to add anything would be a
   dead end. */
function showAccountFormBox() { if ($('accountFormBox')) $('accountFormBox').classList.remove('hidden'); }
function hideAccountFormBox() { if ($('accountFormBox')) $('accountFormBox').classList.add('hidden'); }

function persist() {
  const c = creds();
  if (!c.gUser) return;
  const s = session(c.gUser);
  const autoScanOnSend = !!($('autoScanOnSend') && $('autoScanOnSend').checked);
  Object.assign(s, { gPass: c.gPass, fromName: c.fromName, replyTo: c.replyTo, smtpPort: c.smtpPort, autoScanOnSend });
  activeAccountEmail = c.gUser;
  if ($('remember').checked) {
    saveAccountCreds(c.gUser, Object.assign({}, c, { autoScanOnSend }));
    const list = savedAccountList();
    if (!list.includes(c.gUser)) { list.push(c.gUser); saveAccountList(list); }
  }
  renderAccountList();
  refreshComposeHeader();
}
['gUser', 'gPass', 'fromName', 'replyTo', 'smtpPort', 'remember', 'autoScanOnSend'].forEach(id => $(id).addEventListener('change', persist));

/* Render the saved-account cards. Each shows a live status chip (idle /
   sending N/M / error) read straight from that account's own session, so
   two cards never show the same in-flight state — the bug this whole model
   exists to prevent. */
function renderAccountList() {
  const host = $('accountList');
  if (!host) return;
  const list = savedAccountList();
  if (!list.length) {
    host.innerHTML = '<p class="hint">No accounts saved yet — fill in the form below and click Verify, or Add another account.</p>';
    return;
  }
  host.innerHTML = list.map(email => {
    const s = session(email);
    const editing = email === activeAccountEmail;
    const status = s.sending ? 'sending' : (s.lastError ? 'error' : 'idle');
    /* "sending 7/50" while a campaign or follow-up is actually in flight for
       THIS account, not just a static "sending…" — this is what lets
       several concurrently-sending accounts be told apart at a glance. */
    const statusLabel = s.sending
      ? (s.progress ? 'sending ' + s.progress.done + '/' + s.progress.total : 'sending…')
      : (s.lastError ? 'error' : 'idle');
    const progressBar = s.sending && s.progress
      ? '<span class="acctprogress"><i style="width:' + Math.round(s.progress.done / s.progress.total * 100) + '%"></i></span>'
      : '';
    // The chip alone just says "error" — a hover title with the actual
    // message means the reason doesn't disappear the moment verifyMsg's
    // text is overwritten by whatever's typed next.
    const errorTitle = (!s.sending && s.lastError) ? ' title="' + esc(s.lastError) + '"' : '';
    const quotaCell = s.sentToday && typeof s.sentToday.sent === 'number'
      ? quotaHtml(s.sentToday)
      : '<span class="hint">checking…</span>';

    // A labelled details grid (From name / Reply-to / SMTP / Sent today),
    // the same "small muted label above a bold value" shape a real settings
    // card uses, rather than one flat row where the email, a status word,
    // and two buttons all fight for the same line at equal visual weight.
    return '<div class="accountcard' + (editing ? ' editing' : '') + '" data-email="' + esc(email) + '">'
      + '<div class="accounthead">'
      + '<span class="addr">' + esc(email) + '</span>'
      + '<span class="acctstatus ' + status + '"' + errorTitle + '>' + esc(statusLabel) + '</span>'
      + '</div>'
      + progressBar
      + '<div class="acctfields">'
      + '<div class="acctfield"><span class="acctfieldlbl">From name</span><span class="acctfieldval">' + (s.fromName ? esc(s.fromName) : '<span class="hint">not set</span>') + '</span></div>'
      + '<div class="acctfield"><span class="acctfieldlbl">SMTP port</span><span class="acctfieldval">' + esc(s.smtpPort || '587') + '</span></div>'
      + '<div class="acctfield"><span class="acctfieldlbl">Sent today</span><span class="acctfieldval">' + quotaCell + '</span></div>'
      + '</div>'
      + '<div class="acctactions">'
      + '<button class="edit" data-email="' + esc(email) + '">Edit</button>'
      + '<button class="danger remove" data-email="' + esc(email) + '">Remove</button>'
      + '</div>'
      + '</div>';
  }).join('');

  host.querySelectorAll('.edit').forEach(b => b.onclick = () => { selectAccount(b.dataset.email); showAccountFormBox(); });
  host.querySelectorAll('.remove').forEach(b => b.onclick = () => removeAccount(b.dataset.email));
}

/* Gmail's own daily cap (500 recipients/24h on a personal account, enforced
   by Google, not by this app) is easy to hit invisibly across several
   concurrently-sending accounts. Showing it up front, per account, means a
   quota exhaustion is a thing you see coming rather than a mid-campaign
   SEND_QUOTA_EXCEEDED surprise. */
function quotaHtml(q) {
  const pct = Math.min(100, Math.round((q.sent / (q.limit || 500)) * 100));
  const cls = pct >= 100 ? 'full' : pct >= 80 ? 'warn' : '';
  return '<span class="quota ' + cls + '"><span class="quotabar ' + cls + '"><i style="width:' + pct + '%"></i></span>'
    + q.sent + ' / ' + q.limit + ' sent today</span>';
}

async function refreshQuota(email) {
  const s = session(email);
  if (!s) return;
  try {
    const r = await fetch('/api/campaigns?quota=' + encodeURIComponent(email)).then(x => x.json());
    if (r && r.ok && r.quota) s.sentToday = r.quota;
  } catch (e) { /* quota display is a nicety, not load-bearing — fail quiet */ }
  renderAccountList();
}

function selectAccount(email) {
  activeAccountEmail = String(email || '').trim().toLowerCase();
  fillAccountForm(activeAccountEmail);
  renderAccountList();
  refreshComposeHeader();
  campaignCache = [];
  if (typeof loadCampaigns === 'function') loadCampaigns();
  refreshQuota(activeAccountEmail);
}

function removeAccount(email) {
  const s = session(email);
  if (s && s.sending) {
    return alert('"' + email + '" is still sending. Stop that campaign before removing the account.');
  }
  const alsoServer = confirm('Remove ' + email + '?\n\nOK = forget it everywhere (this browser AND the saved copy other devices can see).\nCancel = forget it on this browser only.\n\nEither way, its send history on the server is untouched.');
  saveAccountList(savedAccountList().filter(e => e !== email));
  try { localStorage.removeItem(acctCredsKey(email)); } catch (e) {}
  sessions.delete(email);
  if (alsoServer) {
    fetch('/api/accounts?email=' + encodeURIComponent(email), { method: 'DELETE' }).catch(() => {});
  }
  if (activeAccountEmail === email) {
    const remaining = savedAccountList();
    selectAccount(remaining[0] || '');
  } else {
    renderAccountList();
  }
}

if ($('btnAddAccount')) $('btnAddAccount').onclick = () => {
  activeAccountEmail = '';
  fillAccountForm('');
  showAccountFormBox();
  $('gUser').focus();
  renderAccountList();
};

if ($('btnCancelAccountEdit')) $('btnCancelAccountEdit').onclick = () => {
  hideAccountFormBox();
  // Re-show whichever account was actually last active, discarding an
  // unsaved edit or an abandoned "add another" the same way closing the
  // form implies.
  const list = savedAccountList();
  if (activeAccountEmail && list.includes(activeAccountEmail)) fillAccountForm(activeAccountEmail);
  else if (list.length) selectAccount(list[0]);
};

/* Restore every previously saved account so their cards show up immediately,
   then activate whichever was last active (or the first one saved). Nothing
   saved yet means the form has nothing to hide behind, so it opens by
   default — a card list with zero cards and no visible way to add one
   would be a dead end. */
(function restore() {
  const list = savedAccountList();
  list.forEach(email => {
    const c = loadAccountCreds(email);
    const s = session(email);
    Object.assign(s, { gPass: c.gPass || '', fromName: c.fromName || '', replyTo: c.replyTo || '',
      smtpPort: c.smtpPort || '587', autoScanOnSend: !!c.autoScanOnSend });
  });
  if (list.length) selectAccount(list[0]);
  else { renderAccountList(); showAccountFormBox(); }

  /* Accounts saved from a DIFFERENT browser only exist server-side, so this
     browser's own localStorage list is silent about them on a first load.
     Fetch the metadata (never the password — fillAccountForm() fetches that
     lazily, only for whichever account is actually opened) and fold in any
     email this browser doesn't already know about, so every device sees the
     same set of accounts rather than one device silently missing some. */
  fetch('/api/accounts').then(x => x.json()).then(r => {
    if (!r || !r.ok || !Array.isArray(r.accounts) || !r.accounts.length) return;
    const known = new Set(savedAccountList());
    let added = false;
    r.accounts.forEach(a => {
      const s = session(a.email);
      Object.assign(s, { fromName: s.fromName || a.fromName, replyTo: s.replyTo || a.replyTo,
        smtpPort: s.smtpPort || a.smtpPort, autoScanOnSend: s.autoScanOnSend || a.autoScanOnSend });
      if (!known.has(a.email)) { known.add(a.email); added = true; }
    });
    if (added) {
      saveAccountList([...known]);
      renderAccountList();
      if (!activeAccountEmail) selectAccount([...known][0]);
    }
  }).catch(() => {});
})();

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
    const s = session(c.gUser);
    if (s) s.lastError = r.ok ? null : (r.error || 'verification failed');
    persist();
    if (c.gUser) refreshQuota(c.gUser);
    /* A newly-verified account may already have real campaign history on
       the server (added on a new browser/device, or re-added after being
       removed here — removeAccount() only ever forgets local credentials,
       never server-side history). Refreshing here means that history shows
       up the moment the account is usable, not only after separately
       clicking over to Activity and hoping it's already loaded. */
    if (r.ok && typeof loadCampaigns === 'function') loadCampaigns();
    /* Verified credentials are saved server-side (encrypted) the moment they
       are known good, so the app password never has to be typed in again on
       any browser or device — editing the display name later, or opening
       this account on a new machine, both just work. Best-effort: a DB
       outage or a deployment with no ACCOUNTS_ENCRYPTION_KEY must not block
       using the account locally, only the cross-device convenience. */
    if (r.ok && c.gUser && c.gPass) {
      fetch('/api/accounts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: c.gUser, password: c.gPass, fromName: c.fromName, replyTo: c.replyTo,
          smtpPort: c.smtpPort, autoScanOnSend: !!($('autoScanOnSend') && $('autoScanOnSend').checked),
        }),
      }).catch(() => {});
    }
    // A successful Verify means this account is fully set up — the form
    // has done its job, so it closes back down to the compact card list.
    if (r.ok) hideAccountFormBox();
  } catch (e) {
    say($('verifyMsg'), '✗ ' + e.message, false);
  }
  b.disabled = false;
};

/* ================= SECTION 3 — recipients & salutations ================= */

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

/* Pulled out of the Section 3 "Parse emails & names" click handler so a
   per-account compose window (Section 4's multi-account checklist) can reuse
   the exact same regex + de-duplication + name-parsing logic against its own
   pasted text, rather than a second copy that could drift from this one. */
function parseRecipientsFromText(text) {
  const found = (String(text || '').match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || []);
  const seen = new Set();
  const list = [];
  for (const e of found) {
    const email = e.toLowerCase();
    if (seen.has(email)) continue;      // de-duplicate within the pasted list
    seen.add(email);
    list.push(Object.assign({ email }, parseName(email)));
  }
  return { list, dupes: found.length - list.length };
}

function parseSummary(list, dupes) {
  const generic = list.filter(x => x.generic).length;
  const low = list.filter(x => !x.generic && x.confidence === 'low').length;
  return list.length + ' unique email(s)'
    + (dupes ? ' · ' + dupes + ' duplicate(s) removed' : '')
    + ' · ' + (list.length - generic) + ' name(s) parsed'
    + (generic ? ' · ' + generic + ' will use the fallback name' : '')
    + (low ? ' · ⚠ ' + low + ' name(s) need a check before sending' : '');
}

$('btnParse').onclick = () => {
  const { list, dupes } = parseRecipientsFromText($('rawEmails').value);
  recipients = list;
  renderRecipients();
  say($('parseMsg'), parseSummary(recipients, dupes), recipients.length > 0);
};

/* ---------- CSV/spreadsheet import ----------
   A pasted list only ever gives an email; a spreadsheet can carry a name AND
   arbitrary extra columns (industry, website_name, whatever) that become
   merge fields with no code change, per lib/util.js's resolveField(). The
   real risk here isn't parsing — Papa.parse does that correctly — it's
   GUESSING which column is the email/first/last name wrong and silently
   sending "Hi Acme Corp," to someone. So every guess is shown and editable
   before anything is imported, never applied blind. */

/* One column can repeat (email, email2, email3, ... — a person with several
   addresses on one row) or two columns can BOTH be "the name" (first + last
   in separate columns rather than one). Scored by how closely a header
   matches a known pattern, not just whether it contains a substring, so
   "Company Email" doesn't win over an unambiguous "Email" column. */
const CSV_FIELD_PATTERNS = {
  email: /^e[-_ ]?mail(?:[-_ ]?(?:address|\d+))?$/i,
  firstName: /^(?:first[-_ ]?name|given[-_ ]?name|fname)$/i,
  lastName: /^(?:last[-_ ]?name|surname|family[-_ ]?name|lname)$/i,
  fullName: /^(?:full[-_ ]?name|name|contact[-_ ]?name)$/i,
};

function guessCsvMapping(headers) {
  // role: 'email' | 'firstName' | 'lastName' | 'fullName' | 'ignore' | 'field'
  const guesses = headers.map(h => {
    const trimmed = String(h || '').trim();
    for (const role of ['email', 'firstName', 'lastName', 'fullName']) {
      if (CSV_FIELD_PATTERNS[role].test(trimmed)) return { header: h, role };
    }
    // A bare "e-mail" substring match, looser than the exact patterns above,
    // catches real-world headers like "Work Email" or "Contact E-Mail"
    // that a strict pattern would otherwise miss and leave unmapped.
    if (/e[-_ ]?mail/i.test(trimmed)) return { header: h, role: 'email' };
    return { header: h, role: 'field' };   // becomes a merge field, not ignored
  });
  // Several email-shaped columns (email, email2, alt_email...) are all kept
  // as 'email' candidates; the mapping UI picks the primary, the rest become
  // additional-email fields rather than silently dropped.
  return guesses;
}

let csvRows = [];       // raw parsed objects, one per spreadsheet row
let csvHeaders = [];
let csvMapping = [];    // [{ header, role }] — role is user-editable after the guess

function renderCsvMapping() {
  const host = $('csvMapping');
  host.classList.remove('hidden');
  const roleOptions = ['email', 'firstName', 'lastName', 'fullName', 'field', 'ignore'];
  const roleLabel = { email: 'Email', firstName: 'First name', lastName: 'Last name',
    fullName: 'Full name', field: 'Merge field ({{' + '...' + '}})', ignore: 'Ignore this column' };
  host.innerHTML = '<p class="hint">' + csvRows.length + ' row(s) found. Confirm what each column means:</p>'
    + '<div class="tablewrap"><table><thead><tr><th>Column</th><th>Use as</th><th>Sample</th></tr></thead><tbody>'
    + csvMapping.map((m, i) => {
        const sample = csvRows[0] ? String(csvRows[0][m.header] ?? '') : '';
        return '<tr><td class="mono" style="font-size:12px">' + esc(m.header) + '</td>'
          + '<td><select class="csvRoleSelect" data-i="' + i + '">'
          + roleOptions.map(r => '<option value="' + r + '"' + (r === m.role ? ' selected' : '') + '>' + esc(roleLabel[r]) + '</option>').join('')
          + '</select></td>'
          + '<td class="hint" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(sample) + '</td></tr>';
      }).join('')
    + '</tbody></table></div>';

  host.querySelectorAll('.csvRoleSelect').forEach(sel => sel.onchange = () => {
    csvMapping[+sel.dataset.i].role = sel.value;
  });

  const hasEmail = csvMapping.some(m => m.role === 'email');
  $('btnCsvImport').classList.toggle('hidden', !hasEmail);
  if (!hasEmail) say($('csvMsg'), 'No column is mapped to Email — pick one above before importing.', false);
  else say($('csvMsg'), '', true);
}

if ($('csvFile')) $('csvFile').onchange = () => {
  const file = $('csvFile').files[0];
  if (!file) return;
  say($('csvMsg'), 'Reading ' + file.name + '…', true);
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      csvHeaders = results.meta.fields || [];
      csvRows = results.data || [];
      if (!csvHeaders.length || !csvRows.length) {
        say($('csvMsg'), 'Could not find any columns or rows — is the first row a header row?', false);
        $('csvMapping').classList.add('hidden');
        $('btnCsvImport').classList.add('hidden');
        return;
      }
      csvMapping = guessCsvMapping(csvHeaders);
      renderCsvMapping();
    },
    error: (err) => say($('csvMsg'), 'Could not read that file: ' + err.message, false),
  });
};

if ($('btnCsvImport')) $('btnCsvImport').onclick = () => {
  const emailCols = csvMapping.filter(m => m.role === 'email').map(m => m.header);
  const firstCol = (csvMapping.find(m => m.role === 'firstName') || {}).header;
  const lastCol = (csvMapping.find(m => m.role === 'lastName') || {}).header;
  const fullCol = (csvMapping.find(m => m.role === 'fullName') || {}).header;
  const fieldCols = csvMapping.filter(m => m.role === 'field').map(m => m.header);

  const seen = new Set();
  const list = [];
  let skipped = 0;
  for (const row of csvRows) {
    // A row can carry several email columns (email, email2, ...) — each
    // becomes its own recipient sharing that row's name/fields, since a
    // person's own second address should still get greeted correctly, not
    // silently dropped just because it wasn't in the primary column.
    for (const col of emailCols) {
      const email = String(row[col] || '').trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { if (row[col]) skipped++; continue; }
      if (seen.has(email)) continue;
      seen.add(email);

      const csvFirst = firstCol ? String(row[firstCol] || '').trim() : '';
      const csvLast = lastCol ? String(row[lastCol] || '').trim() : '';
      const csvFull = fullCol ? String(row[fullCol] || '').trim() : '';
      let parsed;
      if (csvFirst || csvLast) {
        parsed = { first: csvFirst, full: [csvFirst, csvLast].filter(Boolean).join(' '), generic: false, confidence: 'high', source: 'csv' };
      } else if (csvFull) {
        const parts = csvFull.split(/\s+/);
        parsed = { first: parts[0] || '', full: csvFull, generic: false, confidence: 'high', source: 'csv' };
      } else {
        parsed = parseName(email);   // no name column at all — fall back to guessing from the address
      }

      const fields = {};
      for (const col of fieldCols) {
        const v = row[col];
        if (v != null && String(v).trim() !== '') fields[col] = v;
      }

      list.push(Object.assign({ email }, parsed, Object.keys(fields).length ? { fields } : {}));
    }
  }

  if (!list.length) return say($('csvMsg'), 'No valid email addresses found in the mapped column(s).', false);
  recipients = list;
  renderRecipients();
  say($('csvMsg'), list.length + ' recipient(s) imported'
    + (skipped ? ' · ' + skipped + ' row(s) skipped (invalid email)' : '')
    + (fieldCols.length ? ' · ' + fieldCols.length + ' merge field column(s) carried over' : ''),
    true);
  $('csvImportBox').open = false;
};

function renderRecipients() {
  if (typeof refreshComposeHeader === 'function') setTimeout(refreshComposeHeader, 0);
  const tb = document.querySelector('#recTable tbody');
  tb.innerHTML = recipients.map((r, i) => {
    const low = !r.generic && r.confidence === 'low';
    const badge = r.generic
      ? '<span class="badge g">generic inbox</span>'
      : low
        ? '<span class="badge w" title="No separator in the address, so this may be a full name run together, initials, or a company. Check it.">check this name</span>'
        : r.source === 'csv'
          ? '<span class="badge p">from spreadsheet</span>'
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

/* ================= SECTION 4 — compose ================= */

/* Every piece of state that used to be a single module-level global
   (footerImage, savedRange, activeEditor, its own recipient list) is now one
   entry in this map, keyed by the same `prefix` mw() already uses to reach a
   mail window's ids — the same idiom `sessions` uses for per-account state,
   just per mail-window-instance instead of per-account. The one always-there
   entry is 'compose', mounted below exactly like every other prefix; nothing
   about Section 4's default window is special-cased any more. */
const composeInstances = new Map();

function composeState(prefix) {
  if (!composeInstances.has(prefix)) {
    composeInstances.set(prefix, {
      footerImage: null,      // { filename, content(base64), mime }
      savedRange: null,
      activeEditor: null,
      /* Only ever non-null for an extra per-account window (Section 4's
         checklist): those parse their own pasted list rather than sharing
         Section 3's global `recipients`, which stays what the single
         default window reads so nothing about today's one-account flow
         changes shape. */
      ownRecipients: null,
      /* Also only set for an extra per-account window — the fixed account
         it sends as, so its Send/Stop never read whichever account happens
         to be active in Section 1 (unlike the default window, which always
         has). */
      ownAccount: null,
    });
  }
  return composeInstances.get(prefix);
}

/* The default compose window reads/writes Section 3's shared `recipients`
   list, same as before this refactor; an extra per-account window (added by
   the multi-account checklist) keeps its own. One indirection here is what
   lets every other function below stay written once, in terms of "this
   instance's recipients," rather than needing an if/else at every call site. */
function instanceRecipients(prefix) {
  const st = composeState(prefix);
  return st.ownRecipients || recipients;
}
function setInstanceRecipients(prefix, list) {
  const st = composeState(prefix);
  if (st.ownRecipients) st.ownRecipients = list;
  else recipients = list;
}

function editors() {
  return Array.from(document.querySelectorAll('.editor[contenteditable="true"]'));
}
/* The rich-text editor is a shared component: every mail window has its own
   toolbar, so the saved selection tracks WHICH editor was last focused per
   window, and a toolbar button restores into that one — otherwise every
   button would silently act on whichever window happened to load first. */
function saveSel(prefix) {
  const s = window.getSelection();
  if (!s.rangeCount) return;
  const host = editors().find(el => el.contains(s.anchorNode));
  if (!host) return;
  // Only this editor's own instance state changes — a selection made in one
  // window's editor must never overwrite another window's saved range.
  const owner = [...composeInstances.keys()].find(p => host === $(p + 'Editor'));
  if (owner) { const st = composeState(owner); st.activeEditor = host; st.savedRange = s.getRangeAt(0); }
}
function restoreSel(prefix, target) {
  const st = composeState(prefix);
  /* A toolbar can name its editor with data-target; otherwise use whichever
     was focused last in this instance, falling back to this instance's own
     editor. */
  const want = target ? $(target) : null;
  if (want && want !== st.activeEditor) { st.activeEditor = want; st.savedRange = null; }
  if (!st.activeEditor) st.activeEditor = $(prefix + 'Editor');
  if (!st.savedRange) return st.activeEditor.focus();
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(st.savedRange);
}
document.addEventListener('mouseup', () => saveSel());
document.addEventListener('keyup', () => saveSel());

function bodyHtmlOf(prefix) {
  const src = $(prefix + 'HtmlSource'), ed = $(prefix + 'Editor');
  return src.classList.contains('hidden') ? ed.innerHTML : src.value;
}

function renderFooterImgOf(prefix) {
  const st = composeState(prefix);
  const el = $(prefix + 'FooterImgPrev');
  if (!el) return;
  if (!st.footerImage) { el.innerHTML = ''; return; }
  const w = ($(prefix + 'FooterImgW') || {}).value || 220;
  el.innerHTML = '<img src="data:' + st.footerImage.mime + ';base64,' + st.footerImage.content
    + '" style="width:' + w + 'px;max-width:100%"/>'
    + '<div class="lbl">' + esc(st.footerImage.filename) + ' · '
    + Math.round(st.footerImage.content.length * 0.75 / 1024) + ' KB</div>';
}

function readFileB64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve({ filename: file.name, content: String(fr.result).split(',')[1] });
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

function fill(tpl, r) {
  const fb = $('fallbackName').value || 'there';
  const first = r.first || fb, full = r.full || fb;
  return String(tpl || '')
    .replace(/\{\{\s*name\s*\}\}/gi, first)
    .replace(/\{\{\s*first_?name\s*\}\}/gi, first)
    .replace(/\{\{\s*full_?name\s*\}\}/gi, full)
    .replace(/\{\{\s*email\s*\}\}/gi, r.email);
}

/* draft autosave — only ever the default "compose" window's fields, exactly
   as before: an extra per-account window is throwaway state for one send,
   not a second draft slot. */
const DRAFT_KEY = 'mailblaster.draft';
const DRAFT_FIELDS = ['composeSubject', 'composeGreeting', 'composeClosing', 'composeFooterHtml',
  'fallbackName', 'composeDelayMinMs', 'composeDelayMaxMs', 'rawEmails',
  'composeFooterImgW', 'composeFooterImgPos', 'composeFooterImgLink'];
function restoreDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
    DRAFT_FIELDS.forEach(k => { if (d[k] != null) $(k).value = d[k]; });
    const ed = $('composeEditor');
    if (d.body && ed) ed.innerHTML = d.body;
    if (d.footerImage) { composeState('compose').footerImage = d.footerImage; renderFooterImgOf('compose'); }
  } catch (e) {}
}
function saveDraft() {
  const d = { body: bodyHtmlOf('compose'), footerImage: composeState('compose').footerImage };
  DRAFT_FIELDS.forEach(k => d[k] = $(k).value);
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch (e) {
    // localStorage is ~5 MB; a large signature can overflow it. Keep the text.
    delete d.footerImage;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  }
}

/* sending/stopRequested used to be single page-wide flags — meaning Stop on
   ANY mail window silently killed every other account's in-flight send too.
   They now live on each account's own session (session(email).sending /
   .stopRequested), so two accounts sending at once can never step on each
   other. anySending()/sendingAccounts() below exist only for the handful of
   places (beforeunload) that still need a page-wide answer. */
function anySending() {
  for (const s of sessions.values()) if (s.sending) return true;
  return false;
}
function sendingAccounts() {
  return [...sessions.values()].filter(s => s.sending).map(s => s.email);
}

window.addEventListener('beforeunload', e => {
  if (!anySending()) return;
  e.preventDefault();
  e.returnValue = 'Still sending for: ' + sendingAccounts().join(', ') + '. Leaving this page stops them.';
  return e.returnValue;
});

/* Most recent delivered email for each of the given addresses, taken from the
   log already loaded into Section 5. */
function previousSendsFor(emails) {
  const want = new Set(emails);
  const out = {};
  for (const e of logCache) {                 // logCache is newest-first
    const to = String(e.to).toLowerCase();
    if (e.status === 'sent' && want.has(to) && !out[to]) out[to] = e;
  }
  return out;
}

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

/**
 * Bind every control inside one mail-window instance (toolbar, HTML-source
 * toggle, footer image, attachments, preview, send/stop) to that instance's
 * own state via `prefix`. Called once for the default "compose" window and
 * once per checked account in the multi-account checklist — same wiring
 * either way, so the two cannot drift apart the way two hand-written copies
 * would.
 */
function mountCompose(prefix) {
  const st = composeState(prefix);

  const root = $(prefix + 'Editor') ? $(prefix + 'Editor').closest('.mailwindow') : null;
  if (!root) return;

  root.querySelectorAll('.toolbar button[data-cmd]').forEach(b => b.onclick = e => {
    e.preventDefault();
    restoreSel(prefix, b.dataset.target);
    const cmd = b.dataset.cmd;
    if (cmd === 'hilite') {
      const hl = $(prefix + 'HlColor');
      if (!document.execCommand('hiliteColor', false, hl.value)) {
        document.execCommand('backColor', false, hl.value);
      }
    } else if (cmd === 'fore') {
      document.execCommand('foreColor', false, $(prefix + 'ForeColor').value);
    } else if (cmd === 'createLink') {
      const url = prompt('Link URL', 'https://');
      if (url) document.execCommand('createLink', false, url);
    } else {
      document.execCommand(cmd, false, null);
    }
    saveSel();
  });

  root.querySelectorAll('.toolbar button[data-chip]').forEach(b => b.onclick = e => {
    e.preventDefault();
    restoreSel(prefix, b.dataset.target);
    document.execCommand('insertText', false, b.dataset.chip);
    saveSel();
  });

  if ($(prefix + 'BtnHtmlView')) $(prefix + 'BtnHtmlView').onclick = () => {
    const ta = $(prefix + 'HtmlSource'), ed = $(prefix + 'Editor');
    if (ta.classList.contains('hidden')) {
      ta.value = ed.innerHTML;
      ta.classList.remove('hidden');
      ed.classList.add('hidden');
    } else {
      ed.innerHTML = ta.value;
      ta.classList.add('hidden');
      ed.classList.remove('hidden');
    }
  };

  if (prefix === 'compose') {
    // Only the default window's fields are persisted — see the comment above saveDraft().
    restoreDraft();
    DRAFT_FIELDS.forEach(k => { const el = $(k); if (el) el.addEventListener('input', saveDraft); });
    if ($('composeEditor')) $('composeEditor').addEventListener('input', saveDraft);
  }

  if ($(prefix + 'FooterImg')) $(prefix + 'FooterImg').onchange = async () => {
    const f = $(prefix + 'FooterImg').files[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024 &&
        !confirm('That image is ' + (f.size / 1048576).toFixed(1) + ' MB. Big signatures slow every send '
               + 'and can trip spam filters. Use it anyway?')) {
      $(prefix + 'FooterImg').value = '';
      return;
    }
    const b64 = await readFileB64(f);
    st.footerImage = { filename: f.name, content: b64.content, mime: f.type || 'image/png' };
    renderFooterImgOf(prefix);
    if (prefix === 'compose') saveDraft();
    if (typeof refreshComposeSummaries === 'function') refreshComposeSummaries(prefix);
  };

  if ($(prefix + 'BtnClearImg')) $(prefix + 'BtnClearImg').onclick = () => {
    st.footerImage = null;
    $(prefix + 'FooterImg').value = '';
    renderFooterImgOf(prefix);
    if (prefix === 'compose') saveDraft();
    if (typeof refreshComposeSummaries === 'function') refreshComposeSummaries(prefix);
  };

  if ($(prefix + 'FooterImgW')) $(prefix + 'FooterImgW').addEventListener('input', () => renderFooterImgOf(prefix));

  if ($(prefix + 'Files')) $(prefix + 'Files').onchange = () => {
    $(prefix + 'FileList').innerHTML = Array.from($(prefix + 'Files').files)
      .map(f => '<span>📎 ' + esc(f.name) + ' · ' + (f.size / 1024).toFixed(0) + ' KB</span>').join('');
    if (typeof refreshComposeSummaries === 'function') refreshComposeSummaries(prefix);
  };

  if ($(prefix + 'BtnPreview')) $(prefix + 'BtnPreview').onclick = () => {
    const list = instanceRecipients(prefix);
    const msgEl = $(prefix + 'Msg');
    if (!list.length) return say(msgEl, 'Parse some recipients first.', false);
    renderSinglePreview(prefix, list[0], $('preview'));
    // Only the default window drives the top wizard strip — extra
    // multi-account windows are a layer on top of it, not a second wizard.
    if (prefix === 'compose' && typeof refreshWizardSteps === 'function') { composeSubstep = 'review'; refreshWizardSteps(); }
  };

  if ($(prefix + 'BtnStop')) $(prefix + 'BtnStop').onclick = () => {
    /* Only the account whose credentials this window is currently showing is
       stopped — Stop must never reach across and kill a different account's
       in-flight loop. The default window still reads the active account
       (creds()); an extra per-account window carries its own fixed account. */
    const email = st.ownAccount || (creds().gUser);
    const s = session(email);
    if (s) s.stopRequested = true;
    say($(prefix + 'Msg'), 'Stopping after the current email…', false);
  };

  if ($(prefix + 'BtnSend')) $(prefix + 'BtnSend').onclick = () => sendFromWindow(prefix);
}

/* Render one recipient's merged subject/body/footer into a target element —
   the exact rendering `composeBtnPreview` always did, pulled out so the
   combined multi-account preview (Section 4's checklist) can loop it across
   every checked window rather than reimplementing template merge logic. */
function renderSinglePreview(prefix, r, target) {
  const st = composeState(prefix);
  target.classList.remove('hidden');
  const imgW = ($(prefix + 'FooterImgW') || {}).value || 220;
  const img = st.footerImage
    ? '<img src="data:' + st.footerImage.mime + ';base64,' + st.footerImage.content
      + '" style="display:block;width:' + imgW + 'px;max-width:100%;margin:10px 0"/>'
    : '';
  const footerHtmlVal = ($(prefix + 'FooterHtml') || {}).value || '';
  const footerBlock = (($(prefix + 'FooterImgPos') || {}).value === 'above')
    ? img + fill(footerHtmlVal, r)
    : fill(footerHtmlVal, r) + img;

  target.innerHTML =
    '<div class="to"><b>To:</b> ' + esc(r.email) + ' &nbsp; <b>Subject:</b> ' + esc(fill(($(prefix + 'Subject') || {}).value || '', r)) + '</div>'
    + '<p>' + esc(fill(($(prefix + 'Greeting') || {}).value || '', r)) + '</p>'
    + fill(bodyHtmlOf(prefix), r)
    + ((($(prefix + 'Closing') || {}).value) ? '<p style="white-space:pre-line">' + esc(fill($(prefix + 'Closing').value, r)) + '</p>' : '')
    + (footerBlock ? '<hr/>' + footerBlock : '');
}

$('btnFallbackFlagged').onclick = () => {
  const flagged = recipients.filter(r => !r.generic && r.confidence === 'low');
  if (!flagged.length) return say($('parseMsg'), 'No flagged names to replace.', true);
  if (!confirm('Replace ' + flagged.length + ' flagged name(s) with the fallback greeting "'
      + ($('fallbackName').value || 'there') + '"?')) return;
  flagged.forEach(r => { r.first = ''; r.full = ''; r.generic = true; });
  renderRecipients();
  say($('parseMsg'), flagged.length + ' flagged name(s) now use the fallback greeting.', true);
};

/* No longer a permanent Section 3 button: skipping already-delivered
   addresses only ever makes sense when RESUMING a paused/stopped campaign,
   never when starting a fresh one (which has no history to skip against
   yet), so it doesn't belong as an always-visible action for the common
   "start new" path. The function stays — resumeCampaign() already does
   this same filtering server-side via /api/resume, but this client-side
   version is kept available for wiring into wherever "resume a paused
   campaign" ends up living in the account-first-then-fork flow. */
async function skipAlreadySent() {
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
}

/* A fresh random pause between delayMin and delayMax for EVERY send, not
   one fixed interval repeated identically — a constant gap between every
   message is a mechanical, easily fingerprinted pattern; real human sending
   never lands on the same interval twice. */
function randomDelay(min, max) {
  return min >= max ? min : Math.round(min + Math.random() * (max - min));
}

/**
 * The send flow for one mail window — same steps `composeBtnSend` always ran
 * (de-dupe, warn about repeats, size-check attachments, confirm, start a
 * campaign row, run the send loop), generalised over `prefix` and the
 * account it is actually sending as, so the default "compose" window and any
 * extra per-account window run this exact same code.
 */
async function sendFromWindow(prefix, opts) {
  opts = opts || {};
  if (prefix === 'compose' && typeof refreshWizardSteps === 'function') { composeSubstep = 'send'; refreshWizardSteps(); }
  const ownAccount = composeState(prefix).ownAccount;
  const c = ownAccount ? (function () {
    const s = session(ownAccount);
    return { gUser: ownAccount, gPass: s.gPass, fromName: s.fromName, replyTo: s.replyTo, smtpPort: s.smtpPort };
  })() : creds();
  const msgEl = $(prefix + 'Msg');
  if (!c.gUser || !c.gPass) return say(msgEl, 'Add your Gmail + app password in Section 1.', false);
  let list = instanceRecipients(prefix);
  if (!list.length) return say(msgEl, 'No recipients — parse them first.', false);

  // Final de-duplication guard, in case rows were edited after parsing.
  const uniq = new Map();
  list.forEach(r => { if (!uniq.has(r.email)) uniq.set(r.email, r); });
  if (uniq.size !== list.length) {
    const dropped = list.length - uniq.size;
    list = [...uniq.values()];
    setInstanceRecipients(prefix, list);
    if (prefix === 'compose') renderRecipients();
    say(msgEl, 'Removed ' + dropped + ' duplicate address(es) before sending.', true);
  }

  if (!opts.skipRepeatCheck) {
    // Warn about anyone who has already received mail in a previous run.
    const delivered = await sentAddresses();
    const repeats = list.filter(r => delivered.has(r.email));
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
        + '\n\nOK = skip them and send to the other ' + (list.length - repeats.length)
        + '\nCancel = send to everyone anyway (they get it twice)'
        + '\n\nTo read the exact email they received, cancel and open Section 5, then View.');
      if (answer) {
        list = list.filter(r => !delivered.has(r.email));
        setInstanceRecipients(prefix, list);
        if (prefix === 'compose') renderRecipients();
        if (!list.length) return say(msgEl, 'Everyone on this list has already been sent to.', false);
      }
    }
  }

  const st = composeState(prefix);
  const files = $(prefix + 'Files') ? Array.from($(prefix + 'Files').files) : [];
  let totalBytes = files.reduce((a, f) => a + f.size, 0);
  if (st.footerImage) totalBytes += st.footerImage.content.length * 0.75;
  if (!opts.skipSizeCheck && totalBytes > 3.5 * 1024 * 1024) {
    if (!confirm('Attachments total ' + (totalBytes / 1048576).toFixed(1) + ' MB. Hosted serverless functions '
      + 'usually cap a request body around 4.5 MB, so this may fail online (it is fine locally). Continue?')) return;
  }
  if (!opts.skipConfirm && !confirm('Send to ' + list.length + ' recipient(s)?')) return;

  /* Start a real campaign row before sending anything. Without this, every
     send in this loop would persist with campaign_id = NULL: Section 5 would
     never list the run, and store.followupCandidates() — which requires a
     real campaignId — could never find anyone to follow up with afterwards. */
  let campaignId = null;
  try {
    const started = await fetch('/api/campaigns', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'start', from: c.gUser, subject: ($(prefix + 'Subject') || {}).value, total: list.length,
        groupKey: opts.groupKey || undefined,
      }),
    }).then(x => x.json());
    if (started.ok) campaignId = started.campaignId;
  } catch (e) { /* history unavailable (no DB) — sending still works, just unlogged as a campaign */ }

  const attachments = await Promise.all(files.map(readFileB64));
  const base = {
    user: c.gUser, pass: c.gPass, port: c.smtpPort, fromName: c.fromName, replyTo: c.replyTo,
    cc: (($(prefix + 'Cc') || {}).value || '').trim() || undefined,
    bcc: (($(prefix + 'Bcc') || {}).value || '').trim() || undefined,
    campaignId,
    subject: ($(prefix + 'Subject') || {}).value,
    greeting: ($(prefix + 'Greeting') || {}).value,
    bodyHtml: bodyHtmlOf(prefix),
    closing: ($(prefix + 'Closing') || {}).value,
    footerHtml: ($(prefix + 'FooterHtml') || {}).value,
    fallbackName: $('fallbackName').value || 'there',
    attachments,
    footerImage: st.footerImage ? { filename: st.footerImage.filename, content: st.footerImage.content } : null,
    footerImageWidth: ($(prefix + 'FooterImgW') || {}).value,
    footerImagePosition: ($(prefix + 'FooterImgPos') || {}).value,
    footerImageLink: (($(prefix + 'FooterImgLink') || {}).value || '').trim(),
  };

  const delayMin = Math.max(0, parseInt(($(prefix + 'DelayMinMs') || {}).value || '600', 10));
  const delayMax = Math.max(delayMin, parseInt(($(prefix + 'DelayMaxMs') || {}).value || '1800', 10));
  const total = list.length;
  let sent = 0, failed = 0;

  /* Bound to THIS account's session, captured now — even if the user switches
     the active account in Section 1 mid-campaign, this loop keeps checking
     and clearing flags on the account it actually started for, never
     whichever account happens to be showing on screen by the time a later
     iteration runs. */
  const acctSession = session(c.gUser);
  acctSession.sending = true;
  acctSession.stopRequested = false;
  $(prefix + 'BtnSend').disabled = true;
  if ($(prefix + 'BtnStop')) $(prefix + 'BtnStop').classList.remove('hidden');
  if ($(prefix + 'ProgressWrap')) $(prefix + 'ProgressWrap').classList.remove('hidden');
  renderAccountList();

  /* Opt-in, off by default (Section 1's checkbox) — the account this
     campaign is sending FROM, checked at send time, not whichever account
     is active on screen. Suppression from a stale reply is checked
     server-side regardless; this only makes it more likely to be fresh. */
  if (acctSession.autoScanOnSend) {
    say(msgEl, 'Scanning ' + c.gUser + ' for replies first (enabled in Section 1)…', true);
    await scanRepliesFor(c.gUser, 30);
  }
  say(msgEl, 'Sending… keep this tab open — closing or reloading it stops the campaign.', true);

  let stopped = false;
  const loopStartedAt = Date.now();
  for (let i = 0; i < total; i++) {
    if (acctSession.stopRequested) { stopped = true; break; }
    const r = list[i];
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
    loadAnalytics();   // Section 5 updates live, not just at the end

    if ($(prefix + 'Bar')) $(prefix + 'Bar').style.width = ((i + 1) / total * 100) + '%';
    if ($(prefix + 'ProgressText')) {
      // Measured from what's ACTUALLY happened so far (real network time
      // included, not just the configured delay), so the estimate reflects
      // this account's real pace rather than assuming every send takes
      // exactly as long as the delay setting.
      const remaining = total - (i + 1);
      const avgMsPerSend = (Date.now() - loopStartedAt) / (i + 1);
      const etaTxt = remaining > 0 ? ' · about ' + humanSpan(remaining * avgMsPerSend) + ' left' : '';
      $(prefix + 'ProgressText').textContent = (i + 1) + ' / ' + total + ' · ' + sent + ' delivered · ' + failed + ' failed'
        + etaTxt
        + (entry.status === 'failed' ? ' · last error: ' + entry.error : '');
    }
    /* The account card's status chip shows "sending 7/50" live, not just
       "sending…" — this is what lets several concurrently-sending accounts
       be told apart from a glance at Section 1 without opening either mail
       window. */
    acctSession.progress = { done: i + 1, total };
    renderAccountList();
    if (delayMax && i < total - 1) await new Promise(s => setTimeout(s, randomDelay(delayMin, delayMax)));
  }

  if (campaignId) {
    try {
      await fetch('/api/campaigns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'finish', campaignId, status: stopped ? 'stopped' : 'done' }),
      });
    } catch (e) { /* not fatal — the campaign row just stays 'running' */ }
  }

  acctSession.sending = false;
  acctSession.progress = null;
  if ($(prefix + 'BtnStop')) $(prefix + 'BtnStop').classList.add('hidden');
  say(msgEl,
    (stopped ? '■ Stopped — ' : '✓ Finished — ') + sent + ' delivered, ' + failed + ' failed.'
      + (stopped || failed ? ' Use "Skip already-sent" before resuming.' : ''),
    !stopped && failed === 0);
  $(prefix + 'BtnSend').disabled = false;
  renderAccountList();
  refreshQuota(c.gUser);
  loadAnalytics();
  return { sent, failed, stopped, campaignId };
}

mountCompose('compose');

/* ---------- Section 4: sending to several accounts at once ----------
   The default "compose" window (above) always exists and always sends as
   whichever account is active in Section 1, exactly as before this existed.
   Checking an account here mounts a second, independent, full mail window
   for it — its own recipients, subject, body — rather than fanning one
   compose form out across accounts, because the existing window already
   carries too much per-instance state (footer image, draft, toolbar
   selection) for "one form, many accounts" to mean anything simpler. */

// email -> the prefix its extra window was mounted under, so unchecking can
// find and remove exactly that window's DOM and instance state.
const multiAccountWindows = new Map();

function sanitizeForId(email) {
  return String(email || '').replace(/[^a-zA-Z0-9]/g, '_');
}

function renderComposeAccountPicker() {
  const host = $('composeAccountPicker');
  if (!host) return;
  const accounts = savedAccountList();
  // A single saved account has nothing to pick between — showing a
  // one-item checklist here would just be clutter for the common case.
  if (accounts.length < 2) { host.innerHTML = ''; return; }

  host.innerHTML = '<p class="hint">Send this same compose window to more than one account at once:</p>'
    + accounts.map(email => {
      const checked = multiAccountWindows.has(email) || (email === activeAccountEmail && multiAccountWindows.size === 0 && accounts[0] === email);
      return '<label class="inline"><input type="checkbox" class="composeAcctCheck" data-email="' + esc(email) + '"'
        + (checked ? ' checked' : '') + '/> ' + esc(email) + '</label>';
    }).join(' ');

  host.querySelectorAll('.composeAcctCheck').forEach(cb => cb.onchange = () => {
    if (cb.checked) mountMultiAccountWindow(cb.dataset.email);
    else unmountMultiAccountWindow(cb.dataset.email);
    refreshComposeMultiBox();
  });
}

/* Mount an extra full mail window for one account, in addition to the
   always-there default one. Reuses mountOneMailWindow()/mountCompose() —
   the exact same stamping and wiring the default window and the follow-up
   window already go through — so this is one more instance of something
   that already works, not a new code path. */
function mountMultiAccountWindow(email) {
  if (multiAccountWindows.has(email)) return;
  const host = $('composeExtraWindows');
  if (!host) return;
  const prefix = 'compose_' + sanitizeForId(email);

  const wrap = document.createElement('div');
  wrap.className = 'mailmount';
  wrap.dataset.prefix = prefix;
  wrap.dataset.mode = 'campaign';
  wrap.dataset.email = email;
  host.appendChild(wrap);
  mountOneMailWindow(wrap);

  const st = composeState(prefix);
  st.ownAccount = email;
  st.ownRecipients = [];   // this window parses its own list — never Section 3's global one

  mountCompose(prefix);

  // Its own paste box + parse button, above its recipient count — Section
  // 3's parser logic is reused (parseRecipientsFromText), not copied.
  const pasteWrap = document.createElement('div');
  pasteWrap.className = 'msection';
  pasteWrap.innerHTML = '<textarea id="' + prefix + 'RawEmails" rows="4" '
    + 'placeholder="Paste this account\'s recipients here"></textarea>'
    + '<div class="row"><button id="' + prefix + 'BtnParse">Parse emails &amp; names</button>'
    + '<span id="' + prefix + 'ParseMsg" class="msg"></span></div>';
  wrap.querySelector('.mailhead').insertAdjacentElement('afterend', pasteWrap);

  $(prefix + 'BtnParse').onclick = () => {
    const { list, dupes } = parseRecipientsFromText($(prefix + 'RawEmails').value);
    st.ownRecipients = list;
    say($(prefix + 'ParseMsg'), parseSummary(list, dupes), list.length > 0);
    refreshComposeMultiBox();
  };

  const from = $(prefix + 'From');
  if (from) { from.textContent = email; from.classList.remove('empty'); }

  multiAccountWindows.set(email, prefix);
}

function unmountMultiAccountWindow(email) {
  const prefix = multiAccountWindows.get(email);
  if (!prefix) return;
  // Unchecking mid-send does not stop it — Stop is still the explicit way to
  // interrupt a running loop, exactly like closing any other mail window
  // would not itself cancel an in-flight fetch. The instance state and DOM
  // are only torn down; the send loop already captured its own closures
  // (acctSession, body, list) before this can run, so it keeps delivering
  // to the addresses already queued and simply has nowhere left to render
  // its progress.
  const mount = document.querySelector('.mailmount[data-prefix="' + prefix + '"]');
  if (mount) mount.remove();
  composeInstances.delete(prefix);
  multiAccountWindows.delete(email);
}

/* The combined preview: every recipient across every checked window, in one
   table, so 2+ accounts get exactly one confirm before any of them sends —
   reusing renderSinglePreview()'s per-recipient template merge rather than
   a second rendering path. */
function refreshComposeMultiBox() {
  const box = $('composeMultiBox');
  if (!box) return;
  if (multiAccountWindows.size < 2) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  const rows = [];
  multiAccountWindows.forEach((prefix, email) => {
    const list = instanceRecipients(prefix);
    list.forEach(r => rows.push({ prefix, email, r }));
  });

  const tableHost = $('composeMultiPreview');
  if (!rows.length) {
    tableHost.innerHTML = '<p class="hint">No recipients parsed yet in any checked window.</p>';
    return;
  }
  /* Subject alone doesn't answer "what will this person actually get" —
     a per-row "Preview" expands the exact same rendering renderSinglePreview()
     already does for the single-window Preview button, reused rather than
     duplicated, so the combined view and the single-window view can never
     drift apart in what they consider "the real merged email." */
  tableHost.innerHTML = '<table><thead><tr><th>Account</th><th>To</th><th>Subject</th><th></th></tr></thead><tbody>'
    + rows.map((x, i) => '<tr class="multiprevrow" data-i="' + i + '">'
        + '<td class="mono" style="font-size:11px">' + esc(x.email) + '</td>'
        + '<td>' + esc(x.r.email) + '</td>'
        + '<td>' + esc(fill(($(x.prefix + 'Subject') || {}).value || '', x.r)) + '</td>'
        + '<td><button class="multiprev" data-i="' + i + '">Preview</button></td>'
        + '</tr>'
        + '<tr class="multiprevexpand hidden" data-i="' + i + '"><td colspan="4"></td></tr>').join('')
    + '</tbody></table>';

  tableHost.querySelectorAll('.multiprev').forEach(b => b.onclick = () => {
    const i = +b.dataset.i;
    const expandRow = tableHost.querySelector('.multiprevexpand[data-i="' + i + '"]');
    const open = !expandRow.classList.contains('hidden');
    tableHost.querySelectorAll('.multiprevexpand').forEach(r => r.classList.add('hidden'));
    if (open) return;
    expandRow.classList.remove('hidden');
    renderSinglePreview(rows[i].prefix, rows[i].r, expandRow.querySelector('td'));
  });
}

/* One confirm, then every checked window's own already-correct send loop
   (sendFromWindow) runs — concurrently, each bound to its own account's
   session exactly as the single compose window and the follow-up window
   already do (see AccountSession in ARCHITECTURE.md). A shared groupKey
   ties their campaign rows together for Section 5 without adding any new
   cross-account send-time coupling. */
if ($('composeMultiBtnSend')) $('composeMultiBtnSend').onclick = async () => {
  const entries = [...multiAccountWindows.entries()];   // [email, prefix][]
  if (entries.length < 2) return;

  const totalRecipients = entries.reduce((n, [, prefix]) => n + instanceRecipients(prefix).length, 0);
  if (!totalRecipients) return say($('composeMultiMsg'), 'Nobody parsed yet in any checked window.', false);
  if (!confirm('Send from ' + entries.length + ' accounts to ' + totalRecipients
    + ' recipient(s) total? Each account only sends to its own parsed list.\n\n'
    + 'This is the one confirm for all of them — nothing below will ask again.')) return;

  const groupKey = 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  say($('composeMultiMsg'), 'Sending from ' + entries.length + ' accounts…', true);

  // Every checked window's send loop starts together and runs concurrently —
  // each is already isolated by its own account session (AccountSession),
  // so this is not a new concurrency mechanism, just several existing ones
  // kicked off at once instead of one at a time.
  await Promise.all(entries.map(([, prefix]) =>
    sendFromWindow(prefix, { skipConfirm: true, skipRepeatCheck: false, groupKey })));

  say($('composeMultiMsg'), 'All checked accounts have finished (or stopped).', true);
};

renderComposeAccountPicker();
// The account list can change (add/remove/edit in Section 1) without a
// reload, so the checklist has to be kept in sync the same way it is.
const _origRenderAccountList = renderAccountList;
renderAccountList = function () {
  _origRenderAccountList.apply(this, arguments);
  renderComposeAccountPicker();
};

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

function closeModal() { $('modal').classList.add('hidden'); $('modalBox').classList.remove('wide'); }
$('modalClose').onclick = closeModal;
$('modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* ---------- live mail-window header ----------
   The From and To lines mirror what Section 1 and Section 3 hold, so the
   default compose window always shows who the message is actually going out
   as. An extra per-account window (multi-account checklist) shows its own
   fixed account instead — see mountMultiAccountWindow(). */
function refreshComposeHeader() {
  const from = $('gUser') ? $('gUser').value.trim() : '';
  const name = $('fromName') ? $('fromName').value.trim() : '';
  const el = $('composeFrom');
  if (el) {
    el.textContent = from ? (name ? name + ' <' + from + '>' : from) : '— set your Gmail in Section 1 —';
    el.classList.toggle('empty', !from);
  }
  const to = $('composeTo');
  if (to) {
    const n = recipients.length;
    const flagged = recipients.filter(r => !r.generic && r.confidence === 'low').length;
    to.textContent = n
      ? n + ' recipient' + (n === 1 ? '' : 's') + (flagged ? ' · ' + flagged + ' name(s) flagged for review' : '')
      : 'No recipients parsed yet';
    to.classList.toggle('empty', !n);
  }
}

/* Collapsed sections say what they hold, so nothing is hidden silently.
   Defaults to 'compose' so every existing call site (input listeners below)
   needs no change; an extra per-account window passes its own prefix. */
function refreshComposeSummaries(prefix) {
  prefix = prefix || 'compose';
  const st = composeState(prefix);
  const fs = $(prefix + 'FooterSummary');
  if (fs) {
    const bits = [];
    if ((($(prefix + 'FooterHtml') || {}).value || '').trim()) bits.push('text');
    if (st.footerImage) bits.push('image');
    fs.textContent = bits.length ? bits.join(' + ') : 'none';
  }
  const as = $(prefix + 'AttachSummary');
  if (as) {
    const n = $(prefix + 'Files') ? $(prefix + 'Files').files.length : 0;
    as.textContent = n ? n + ' file' + (n === 1 ? '' : 's') : 'none';
  }
  const cs = $(prefix + 'CcBccSummary');
  if (cs) {
    const cc = (($(prefix + 'Cc') || {}).value || '').trim();
    const bcc = (($(prefix + 'Bcc') || {}).value || '').trim();
    const bits = [];
    if (cc) bits.push('Cc: ' + cc);
    if (bcc) bits.push('Bcc: ' + bcc);
    cs.textContent = bits.length ? bits.join(' · ') : 'none';
  }
}

['gUser', 'fromName'].forEach(id => {
  if ($(id)) $(id).addEventListener('input', refreshComposeHeader);
});
/* History belongs to a Gmail account, so switching account reloads it. */
if ($('gUser')) $('gUser').addEventListener('change', () => {
  campaignCache = [];
  if (typeof loadCampaigns === 'function') loadCampaigns();
});
if ($('composeFooterHtml')) $('composeFooterHtml').addEventListener('input', () => refreshComposeSummaries('compose'));
if ($('composeFiles')) $('composeFiles').addEventListener('change', () => refreshComposeSummaries('compose'));
if ($('composeCc')) $('composeCc').addEventListener('input', () => refreshComposeSummaries('compose'));
if ($('composeBcc')) $('composeBcc').addEventListener('input', () => refreshComposeSummaries('compose'));
refreshComposeHeader();
refreshComposeSummaries('compose');

/* Load the real campaign history for whichever Gmail account is in Section 1.
   Scoped by address so two people sharing a browser do not see each other's
   runs; the App Password is never sent anywhere for this. */
/* Which account Activity is currently filtered to \u2014 '' means every saved
   account combined. Shared by the campaign table, the sent log/stats/chart,
   and the due-list, so picking a tab genuinely filters everything on the
   page, not just the campaign table (a real gap: the sent log/stats/chart
   used to always show every account's data regardless of this filter). */
let campAccountTab = '';

/* Real tabs, not a <select> \u2014 rebuilt whenever the saved-account list
   changes, so a newly added account shows up without a page reload. Works
   identically with one saved account (just "All", nothing else to click)
   or several. Defaults to "All" (empty owner -> every endpoint's own
   combined-view behavior) rather than silently narrowing to whichever
   account happens to be active in Section 1 \u2014 the whole point of the
   combined view is not having to switch accounts just to see everything. */
function refreshCampaignAccountFilter() {
  const host = $('campAccountTabs');
  if (!host) return;
  const accounts = savedAccountList();
  if (!accounts.includes(campAccountTab)) campAccountTab = '';
  host.innerHTML = ['', ...accounts].map(a => {
    const label = a || 'All accounts';
    return '<button class="tab campaccttab' + (a === campAccountTab ? ' active' : '') + '" data-owner="' + esc(a) + '">' + esc(label) + '</button>';
  }).join('');
  host.querySelectorAll('.campaccttab').forEach(b => b.onclick = () => {
    campAccountTab = b.dataset.owner;
    host.querySelectorAll('.campaccttab').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    loadCampaigns();
    loadAnalytics();
  });
}

async function loadCampaigns() {
  refreshCampaignAccountFilter();
  const owner = campAccountTab || '';
  const tb = document.querySelector('#campTable tbody');
  if (tb && !campaignCache.length) {
    tb.innerHTML = '<tr><td colspan="10" class="hint">Loading\u2026</td></tr>';
  }
  try {
    const url = '/api/campaigns' + (owner ? '?owner=' + encodeURIComponent(owner) : '');
    const r = await fetch(url).then(x => x.json());
    if (r && r.ok && r.available) {
      campaignCache = r.campaigns || [];
    } else {
      campaignCache = [];
      if (tb) {
        tb.innerHTML = '<tr><td colspan="10" class="hint">'
          + (r && r.reason ? esc(r.reason) : 'No database connected.') + '</td></tr>';
        return;
      }
    }
  } catch (e) {
    campaignCache = [];
    if (tb) tb.innerHTML = '<tr><td colspan="10" class="msg bad">Could not reach the server.</td></tr>';
    return;
  }
  renderCampaigns();
}

/* ---------- scanning the inbox for replies ----------
   A mailbox scan takes seconds and a hosted function is killed at 60s, so the
   server returns a cursor when its budget runs out and this loop continues
   from there. The button reports progress throughout rather than sitting
   inert, because a silent multi-second wait reads as a broken control.

   Deliberately still one page-wide flag, unlike sending: Section 6 is one
   shared scan button and one shared result list, not one instance per
   account the way Section 4/6's mail windows are — so there is only ever
   one scan control on screen regardless of how many accounts are saved.
   Making this per-account would block a second scan from a DIFFERENT
   account without actually letting two scans run through this one shared
   UI at once; the real fix is duplicating Section 6 per account (like
   compose/follow-up already are), which is a larger change than this flag. */
let scanning = false;

/**
 * The same reply scan Section 6's button runs, but headless — no DOM
 * writes, no UI feedback beyond what the caller chooses to show — for the
 * "scan this account before sending" opt-in toggle in Section 1. Runs to
 * completion (resuming across the server's own budget the same way the UI
 * version does) or gives up after 20 rounds, same backstop as the UI path.
 * Failures are swallowed: a scan that can't complete must not block or
 * corrupt the send it was meant to help, and the deterministic
 * per-recipient suppression check in /api/send /api/followup already
 * happens either way regardless of whether this ran.
 */
async function scanRepliesFor(email, days) {
  const s = session(email);
  if (!s || !s.gPass) return;
  let cursor = null, rounds = 0;
  try {
    do {
      const r = await fetch('/api/replies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: email, pass: s.gPass, days: days || 30, cursor }),
      }).then(x => x.json());
      if (!r.ok) break;
      cursor = r.done ? null : r.cursor;
    } while (cursor && ++rounds < 20);
  } catch (e) { /* best-effort — the send proceeds regardless */ }
}

async function scanReplies() {
  if (scanning) return;
  const c = creds();
  if (!c.gUser || !c.gPass) {
    return say($('replyMsg'), 'Add your Gmail address and App Password in Section 1 first.', false);
  }

  scanning = true;
  const btn = $('btnScanReplies');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  $('scanSpin').classList.remove('hidden');
  $('scanLabel').textContent = 'Scanning\u2026';
  $('scanProgressWrap').classList.remove('hidden');
  say($('replyMsg'), '', true);

  const days = Number($('replyDays').value) || 30;
  let cursor = null, examined = 0, total = 0, rounds = 0;
  const found = [];

  try {
    /* Keep resuming until the server says it finished. The round cap is a
       backstop against a cursor that never advances. */
    do {
      const r = await fetch('/api/replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: c.gUser, pass: c.gPass, days, cursor }),
      }).then(x => x.json());

      if (!r.ok) {
        say($('replyMsg'), (r.error || 'Scan failed') + (r.hint ? ' \u2014 ' + r.hint : ''), false);
        break;
      }

      found.push.apply(found, r.messages || []);
      examined += r.examined || 0;
      total = r.total || total;
      cursor = r.done ? null : r.cursor;

      const pct = total ? Math.min(100, Math.round(examined / total * 100)) : 100;
      $('scanBar').style.width = pct + '%';
      $('scanProgressText').textContent = examined + (total ? ' of ' + total : '') + ' messages examined'
        + (found.length ? ' \u00b7 ' + found.length + ' relevant' : '');
    } while (cursor && ++rounds < 20);

    replyCache = found;
    renderReplyStats();
    renderReplyList();

    if (found.length || examined) {
      const n = k => found.filter(x => x.kind === k).length;
      say($('replyMsg'), 'Done \u2014 ' + n('reply') + ' replied, ' + n('ooo') + ' out of office, '
        + n('bounce') + ' bounced.', true);
      $('replyMeta').textContent = 'Last scan just now \u00b7 last ' + days + ' days \u00b7 '
        + examined + ' messages examined';
    }
    /* Suppression may have changed, so anything showing an audience is stale. */
    if (typeof loadCampaigns === 'function') loadCampaigns();
    if ($('fuCampaign') && $('fuCampaign').value) loadFollowupAudience();
  } catch (e) {
    say($('replyMsg'), 'Could not reach the server: ' + e.message, false);
  } finally {
    scanning = false;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    $('scanSpin').classList.add('hidden');
    $('scanLabel').textContent = 'Scan for replies';
    setTimeout(function () { $('scanProgressWrap').classList.add('hidden'); }, 1200);
  }
}
if ($('btnScanReplies')) $('btnScanReplies').onclick = scanReplies;

/* ---------- follow-up ---------- */

let followupAudience = [];

/* Populate the campaign picker from real history. */
function fillFollowupCampaigns() {
  const sel = $('fuCampaign');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">\u2014 choose a campaign to follow up on \u2014</option>'
    + campaignCache.map(function (c) {
        return '<option value="' + c.id + '">' + esc(c.name) + ' \u00b7 '
          + new Date(c.startedAt).toLocaleDateString() + ' \u00b7 ' + c.sent + ' sent</option>';
      }).join('');
  if (current) sel.value = current;
}

/* Who would receive it, decided by the server so a page left open for an hour
   cannot mail someone who has since replied. */
async function loadFollowupAudience() {
  const id = $('fuCampaign') && $('fuCampaign').value;
  const setCount = function (k, n) { const el = $(k); if (el) el.textContent = '(' + n + ')'; };
  if (!id) {
    followupAudience = [];
    ['cntNoReply', 'cntOoo', 'cntSoft', 'cntFailed'].forEach(function (k) { setCount(k, 0); });
    /* This used to call $('fuTo').textContent directly and unguarded — but
       clearing the campaign picker with nothing sent yet is a normal, common
       action, and an unguarded DOM write here threw every time it happened,
       which leaves every handler bound AFTER this line unbound.
       updateFollowupCount() already reads fuTo through a guarded $() check,
       so delegate to it instead of touching the DOM directly here. */
    updateFollowupCount();
    return;
  }
  try {
    const r = await fetch('/api/followup?campaign=' + encodeURIComponent(id)
      + ($('fuCap') && $('fuCap').checked ? '&cap=3' : '&cap=999')).then(x => x.json());
    if (!r.ok) return;
    followupAudience = r.candidates || [];
    const c = r.counts || {};
    setCount('cntNoReply', c.noreply || 0);
    setCount('cntOoo', c.ooo || 0);
    setCount('cntSoft', c.soft || 0);
    setCount('cntFailed', c.failed || 0);

    const parent = campaignCache.find(function (x) { return String(x.id) === String(id); });
    if (parent && $('fuSubjectLocked')) {
      $('fuSubjectLocked').innerHTML = 'Re: ' + esc(parent.subject || '(no subject)');
    }
    if (parent && $('fuQuoted')) {
      $('fuQuoted').classList.remove('hidden');
      $('fuQuotedBody').innerHTML = '<p class="hint">The original, sent '
        + new Date(parent.startedAt).toLocaleDateString() + ': <b>'
        + esc(parent.subject || '') + '</b></p>';
    }
    updateFollowupCount();
  } catch (e) {}
}

function chosenReasons() {
  return {
    noreply: !!($('fuNoReply') && $('fuNoReply').checked),
    ooo: !!($('fuOoo') && $('fuOoo').checked),
    soft: !!($('fuSoft') && $('fuSoft').checked),
    failed: !!($('fuFailed') && $('fuFailed').checked),
  };
}

function selectedAudience() {
  const want = chosenReasons();
  return followupAudience.filter(function (p) { return want[p.why]; });
}

function updateFollowupCount() {
  const n = selectedAudience().length;
  if ($('fuTo')) {
    $('fuTo').textContent = n
      ? n + ' recipient' + (n === 1 ? '' : 's') + ' who have not replied'
      : 'Nobody matches the chosen audience';
    $('fuTo').classList.toggle('empty', !n);
  }
}

['fuNoReply', 'fuOoo', 'fuSoft', 'fuFailed'].forEach(function (id) {
  if ($(id)) $(id).addEventListener('change', updateFollowupCount);
});
if ($('fuCap')) $('fuCap').addEventListener('change', loadFollowupAudience);
if ($('fuCampaign')) $('fuCampaign').addEventListener('change', loadFollowupAudience);

/* Send the follow-up as a reply in the original thread. */
async function sendFollowup() {
  const campaignId = $('fuCampaign').value;
  if (!campaignId) return say($('fuMsg'), 'Choose a campaign to follow up on.', false);

  /* The follow-up must be sent — and authenticated — as the account that
     OWNS this campaign, not whichever account happens to be active in
     Section 1. campaignCache is the combined cross-account list (Section 5
     defaults to showing every saved account together), so the campaign
     picker here can easily list a campaign belonging to a different
     account than the one currently showing in Section 1. Using the wrong
     account's credentials wouldn't silently misfire — /api/followup checks
     `owner` server-side and would report "Campaign not found" for a
     mismatch — but that's a confusing failure to hit by accident when the
     right account is one click away. */
  const parentCampaign = campaignCache.find(x => String(x.id) === String(campaignId));
  const owner = parentCampaign ? String(parentCampaign.from || '').trim().toLowerCase() : activeAccountEmail;
  if (!owner) return say($('fuMsg'), 'Could not determine which account owns this campaign.', false);
  const s = session(owner);
  if (!s.gPass) {
    return say($('fuMsg'), 'No saved App Password for ' + owner + '. Open that account in Section 1 and Verify first.', false);
  }
  if (owner !== activeAccountEmail) selectAccount(owner);
  const c = { gUser: owner, gPass: s.gPass, fromName: s.fromName, replyTo: s.replyTo, smtpPort: s.smtpPort };

  const audience = selectedAudience();
  if (!audience.length) return say($('fuMsg'), 'Nobody matches the chosen audience.', false);
  if (!confirm('Send a follow-up to ' + audience.length + ' recipient(s)?\n\n'
    + 'It goes out as a reply in the original thread.')) return;

  let started;
  try {
    started = await fetch('/api/followup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaignId, owner: c.gUser, include: chosenReasons(),
        maxFollowups: ($('fuCap') && $('fuCap').checked) ? 3 : false,
      }),
    }).then(x => x.json());
  } catch (e) {
    return say($('fuMsg'), 'Could not reach the server: ' + e.message, false);
  }
  if (!started.ok || !started.campaignId) {
    return say($('fuMsg'), started.message || started.error || 'Could not start the follow-up.', false);
  }

  /* The server rebuilt the audience at this moment, so use ITS list rather
     than what the page was showing. */
  const people = started.candidates || audience;
  await runSendLoop({
    people: people,
    campaignId: started.campaignId,
    followupRound: started.followupRound,
    prefix: 'fu',
    creds: c,
    threaded: true,
  });
  loadCampaigns();
  loadFollowupAudience();
}
if ($('fuBtnSend')) $('fuBtnSend').onclick = sendFollowup;
if ($('fuBtnStop')) $('fuBtnStop').onclick = function () {
  const s = activeAccount();
  if (s) s.stopRequested = true;
  say($('fuMsg'), 'Stopping after the current email\u2026', false);
};

/* ---------- one send loop, used by campaigns and follow-ups ----------
   Threading is the only real difference: a follow-up carries In-Reply-To and
   References so Gmail nests it under the original.

   Bound to opts.creds.gUser's own session (not the globals sending/
   stopRequested this used to read/write) so a follow-up running for account
   A is untouched by a Stop click on account B's window, and vice versa. */
async function runSendLoop(opts) {
  const p = opts.prefix;
  const msg = $(p + 'Msg');
  const delayMin = Math.max(0, parseInt(($(p + 'DelayMinMs') || {}).value || '600', 10));
  const delayMax = Math.max(delayMin, parseInt(($(p + 'DelayMaxMs') || {}).value || '1800', 10));
  const total = opts.people.length;
  let sent = 0, failed = 0, skipped = 0;

  const acctSession = session(opts.creds.gUser);
  acctSession.sending = true;
  acctSession.stopRequested = false;
  $(p + 'BtnSend').disabled = true;
  if ($(p + 'BtnStop')) $(p + 'BtnStop').classList.remove('hidden');
  $(p + 'ProgressWrap').classList.remove('hidden');
  renderAccountList();

  /* Same opt-in as the compose loop \u2014 see its comment for why this is off
     by default. A follow-up benefits from this more than an initial send
     does: it's exactly the moment a stale "who already replied" list does
     the most damage. */
  if (acctSession.autoScanOnSend) {
    say(msg, 'Scanning ' + opts.creds.gUser + ' for replies first (enabled in Section 1)\u2026', true);
    await scanRepliesFor(opts.creds.gUser, 30);
  }
  say(msg, 'Sending\u2026 keep this tab open.', true);

  const base = {
    user: opts.creds.gUser, pass: opts.creds.gPass, port: opts.creds.smtpPort,
    fromName: opts.creds.fromName, replyTo: opts.creds.replyTo,
    cc: (($(p + 'Cc') || {}).value || '').trim() || undefined,
    bcc: (($(p + 'Bcc') || {}).value || '').trim() || undefined,
    campaignId: opts.campaignId,
    followupRound: opts.followupRound || 0,
    greeting: ($(p + 'Greeting') || {}).value || '',
    bodyHtml: ($(p + 'Editor') || {}).innerHTML || '',
    closing: ($(p + 'Closing') || {}).value || '',
    footerHtml: ($(p + 'FooterHtml') || {}).value || '',
    fallbackName: ($('fallbackName') || {}).value || 'there',
    attachments: [],
  };

  let stopped = false;
  const loopStartedAt = Date.now();
  for (let i = 0; i < total; i++) {
    if (acctSession.stopRequested) { stopped = true; break; }
    const person = opts.people[i];
    const body = Object.assign({
      recipient: { email: person.email, first: person.first, full: person.full },
      subject: opts.threaded ? ('Re: ' + (person.subject || '')) : base.subject,
    }, base);

    /* Thread onto the message being answered. In-Reply-To is just the
       immediate parent; References must carry the WHOLE ancestor chain (RFC
       5322 3.6.4) or a 3rd-round follow-up can lose earlier ancestors and
       thread incorrectly in stricter clients. person.references already
       comes pre-accumulated from store.followupCandidates(). */
    if (opts.threaded && person.messageId) {
      body.inReplyTo = person.messageId;
      body.references = (person.references && person.references.length)
        ? person.references : [person.messageId];
    }

    let res;
    try {
      res = await fetch('/api/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(x => x.json());
    } catch (e) {
      res = { ok: false, error: e.message };
    }

    if (res.duplicate) skipped++;
    else if (res.ok) sent++;
    else failed++;

    $(p + 'Bar').style.width = ((i + 1) / total * 100) + '%';
    const remaining = total - (i + 1);
    const avgMsPerSend = (Date.now() - loopStartedAt) / (i + 1);
    const etaTxt = remaining > 0 ? ' \u00b7 about ' + humanSpan(remaining * avgMsPerSend) + ' left' : '';
    $(p + 'ProgressText').textContent = (i + 1) + ' / ' + total + ' \u00b7 ' + sent + ' delivered'
      + (failed ? ' \u00b7 ' + failed + ' failed' : '')
      + (skipped ? ' \u00b7 ' + skipped + ' already sent' : '')
      + etaTxt
      + (!res.ok && res.error ? ' \u00b7 ' + res.error : '');
    acctSession.progress = { done: i + 1, total };
    renderAccountList();

    if (delayMax && i < total - 1) await new Promise(function (r) { setTimeout(r, randomDelay(delayMin, delayMax)); });
  }

  acctSession.sending = false;
  acctSession.progress = null;
  if ($(p + 'BtnStop')) $(p + 'BtnStop').classList.add('hidden');
  $(p + 'BtnSend').disabled = false;
  say(msg, (stopped ? '\u25a0 Stopped \u2014 ' : '\u2713 Finished \u2014 ') + sent + ' delivered'
    + (failed ? ', ' + failed + ' failed' : '')
    + (skipped ? ', ' + skipped + ' skipped as already sent' : '') + '.',
    !stopped && !failed);
  renderAccountList();
  refreshQuota(opts.creds.gUser);
  return { sent: sent, failed: failed, skipped: skipped, stopped: stopped };
}

/* ---------- resuming an interrupted campaign ----------
   The send loop dies with the tab, so where a run got to is rebuilt from the
   database rather than trusted to the browser. */
async function resumeCampaign(c) {
  /* This campaign's OWN account, not whichever one happens to be active in
     Section 1 right now. With the combined cross-account dashboard, the
     campaign being resumed and the account currently showing in Section 1
     can easily be two different accounts — using creds() here would either
     resume with the wrong account's credentials or fail outright if no
     account happens to be active at all. */
  const owner = String(c.from || '').trim().toLowerCase();
  if (!owner) return alert('This campaign has no recorded sending account — cannot resume it.');
  const s = session(owner);
  if (!s.gPass) {
    return alert('No saved App Password for ' + owner + '. Open that account in Section 1, '
      + 'enter its App Password and Verify, then resume again.');
  }
  // Switch the active account so the compose window (which this loop
  // renders progress into) reflects the account actually sending.
  selectAccount(owner);
  const creds_ = { gUser: owner, gPass: s.gPass, fromName: s.fromName, replyTo: s.replyTo, smtpPort: s.smtpPort };

  let state;
  try {
    state = await fetch('/api/resume?campaign=' + encodeURIComponent(c.id)).then(x => x.json());
  } catch (e) { return alert('Could not reach the server.'); }

  const retry = (state && state.retry) || [];
  if (!retry.length) {
    return alert('Nothing left to send: everyone in this campaign has been delivered to.');
  }
  if (!confirm('Resume "' + c.name + '"?\n\n' + state.done + ' already delivered.\n'
    + retry.length + ' still to send.\n\nAnyone already delivered to is skipped.')) return;

  await runSendLoop({
    people: retry, campaignId: c.id, prefix: 'compose', creds: creds_,
  });
  loadCampaigns();
}

/* The follow-up window is the same component as compose, so it gets the same
   controls. They are bound per-window rather than duplicated: one definition,
   two instances. */

/* Toggle between the rich-text editor and its HTML source. */
if ($('fuBtnHtmlView')) $('fuBtnHtmlView').onclick = function () {
  const ed = $('fuEditor'), src = $('fuHtmlSource');
  if (src.classList.contains('hidden')) {
    src.value = ed.innerHTML;
    src.classList.remove('hidden');
    ed.classList.add('hidden');
    $('fuBtnHtmlView').textContent = 'Rich text';
  } else {
    ed.innerHTML = src.value;
    src.classList.add('hidden');
    ed.classList.remove('hidden');
    $('fuBtnHtmlView').textContent = '</> HTML';
  }
};

if ($('fuBtnClearImg')) $('fuBtnClearImg').onclick = function () {
  if ($('fuFooterImg')) $('fuFooterImg').value = '';
  if ($('fuFooterImgPrev')) $('fuFooterImgPrev').innerHTML = '';
};

/* Show the follow-up exactly as the first recipient will receive it, including
   the quoted original underneath — the whole point of a threaded reply is that
   it arrives as part of an existing conversation. */
if ($('fuBtnPreview')) $('fuBtnPreview').onclick = function () {
  const who = selectedAudience()[0];
  if (!who) return say($('fuMsg'), 'Choose a campaign and an audience first.', false);

  const fallback = ($('fallbackName') || {}).value || 'there';
  const fill = function (t) { return renderTags(t, who, fallback); };
  const box = $('fuPreview');
  box.classList.remove('hidden');
  box.innerHTML =
    '<div class="to"><b>To:</b> ' + esc(who.email)
    + ' &nbsp; <b>Subject:</b> Re: ' + esc(who.subject || '') + '</div>'
    + '<p>' + esc(fill(($('fuGreeting') || {}).value || '')) + '</p>'
    + fill(($('fuEditor') || {}).innerHTML || '')
    + (($('fuClosing') || {}).value
        ? '<p style="white-space:pre-line">' + esc(fill($('fuClosing').value)) + '</p>' : '')
    + '<div class="quotedbody" style="margin-top:14px">'
    + '<p class="hint">\u22ee quoted: the original message, sent '
    + (who.at ? new Date(who.at).toLocaleDateString() : 'earlier') + '</p></div>';
};

/* Merge tags, resolved the same way the server does. */
function renderTags(tpl, r, fallback) {
  const first = r.first || fallback;
  const full = r.full || first;
  return String(tpl || '')
    .replace(/\{\{\s*name\s*\}\}/gi, esc(first))
    .replace(/\{\{\s*first_?name\s*\}\}/gi, esc(first))
    .replace(/\{\{\s*full_?name\s*\}\}/gi, esc(full))
    .replace(/\{\{\s*email\s*\}\}/gi, esc(r.email || ''));
}

/* ================= SECTION 5 — campaigns =================
   Three levels, because that is how the question is actually asked:
   which campaigns ran -> who was in this one -> what happened with this person.
   The trail merges sends and replies into one ordered conversation, so
   "they answered the second follow-up" is visible rather than inferred.
   campaignCache/currentCampaign are declared near the top of the file, not
   here — see that comment for why. */

function fmtWhen(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
    + ', ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ---------- "due for follow-up" — a review-and-confirm list, not a scheduler ----------
   Both "send follow-up now" (Section 6, one click, one campaign) and this
   "what's due across everything" view exist side by side on purpose — this
   app has no server-side cron and credentials are never stored server-side,
   so "automated" here can only ever mean "one click surfaces everyone
   currently due, for you to act on," never an unattended sender that runs
   without the browser open. */
async function checkDueFollowups() {
  const days = Math.max(1, Number($('dueAfterDays').value) || 3);
  const btn = $('btnCheckDue');
  btn.disabled = true;
  say($('dueMsg'), 'Checking every finished campaign…', true);
  $('dueList').innerHTML = '';

  try {
    const r = await fetch('/api/campaigns').then(x => x.json());   // every account, combined
    if (!r.ok || !r.available) { say($('dueMsg'), 'No database connected.', false); return; }

    const cutoff = Date.now() - days * 86400000;
    const candidates = (r.campaigns || []).filter(c =>
      c.status === 'done' && c.finishedAt && new Date(c.finishedAt).getTime() < cutoff
      && !c.imported   // an imported campaign needs its replies scanned first — see api/import.js's nextStep
    );

    if (!candidates.length) {
      say($('dueMsg'), 'Nothing finished more than ' + days + ' day(s) ago.', true);
      return;
    }

    /* A campaign finishing N days ago doesn't mean anyone is actually still
       eligible — /api/followup decides that server-side (do_not_contact,
       ooo_until, the 3-chase cap), so each candidate is checked for real,
       not just listed because it's old. */
    const due = [];
    for (const c of candidates) {
      try {
        const f = await fetch('/api/followup?campaign=' + encodeURIComponent(c.id) + '&cap=3').then(x => x.json());
        if (f.ok && f.candidates && f.candidates.length) due.push({ campaign: c, count: f.candidates.length, counts: f.counts });
      } catch (e) { /* one campaign failing to check must not stop the rest */ }
    }

    say($('dueMsg'), due.length
      ? due.length + ' campaign(s) have someone due for a follow-up.'
      : 'Nothing currently eligible — everyone due has already replied, opted out, or been chased enough.', true);
    $('dueList').innerHTML = due.length ? '<div class="tablewrap"><table><thead><tr>'
      + '<th>Account</th><th>Campaign</th><th>Finished</th><th>Due</th><th></th></tr></thead><tbody>'
      + due.map(d => '<tr>'
          + '<td class="mono" style="font-size:11px">' + esc(d.campaign.from || '—') + '</td>'
          + '<td>' + esc(d.campaign.name) + '</td>'
          + '<td>' + fmtWhen(d.campaign.finishedAt) + '</td>'
          + '<td>' + d.count + ' recipient(s)</td>'
          + '<td><button class="review" data-id="' + d.campaign.id + '">Review &amp; send</button></td>'
          + '</tr>').join('')
      + '</tbody></table></div>' : '';

    $('dueList').querySelectorAll('.review').forEach(b => b.onclick = () => {
      /* Hands off to the exact same manual "send follow-up" flow in
         Section 6 — this view only ever finds candidates and stops; the
         actual send is still the one-click confirm that already exists. */
      const target = due.find(d => String(d.campaign.id) === b.dataset.id);
      if (!target) return;
      document.querySelector('[data-tab="s6"]').click();
      campaignCache = r.campaigns;
      fillFollowupCampaigns();
      $('fuCampaign').value = target.campaign.id;
      loadFollowupAudience();
      $('fuCampaign').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  } catch (e) {
    say($('dueMsg'), 'Could not reach the server: ' + e.message, false);
  } finally {
    btn.disabled = false;
  }
}
if ($('btnCheckDue')) $('btnCheckDue').onclick = checkDueFollowups;

function renderCampaigns() {
  const tb = document.querySelector('#campTable tbody');
  if (!tb) return;
  if (!campaignCache.length) {
    tb.innerHTML = '<tr><td colspan="10">No campaigns yet. '
      + 'Send one from Section 4, or import a past campaign from your Sent folder.</td></tr>';
    return;
  }
  tb.innerHTML = campaignCache.map(function (c, i) {
    const done = c.sent + c.failed;
    const pct = c.total ? Math.round(done / c.total * 100) : 100;
    return '<tr>'
      + '<td class="mono" style="font-size:11px">' + esc(c.from || '—') + '</td>'
      + '<td>' + fmtWhen(c.startedAt) + '</td>'
      + '<td><b>' + esc(c.name) + '</b>'
        + (c.imported ? ' <span class="badge p" title="Imported from Gmail">imported</span>' : '') + '</td>'
      + '<td>' + esc(c.subject || '—') + '</td>'
      + '<td class="progresscell">' + done + ' / ' + (c.total || done)
      + '<div class="minibar" title="' + c.sent + ' delivered, ' + c.failed + ' failed">'
      + '<i class="s" style="flex:' + c.sent + '"></i><i class="f" style="flex:' + c.failed + '"></i></div></td>'
      + '<td>' + (c.replied || 0) + '</td>'
      + '<td>' + (c.ooo || 0) + '</td>'
      + '<td>' + (c.bounced || 0) + '</td>'
      + '<td><span class="badge ' + c.status + '">' + c.status + '</span>'
      + (c.status === 'stopped' && pct < 100
          ? '<br/><small class="hint">' + (100 - pct) + '% left</small>' : '') + '</td>'
      + '<td><button class="open" data-i="' + i + '">Open</button>'
      + (c.status === 'stopped' && done < c.total
          ? ' <button class="resume" data-i="' + i + '">Resume</button>' : '')
      + '</td>'
      + '</tr>';
  }).join('');
  tb.querySelectorAll('.open').forEach(function (b) {
    b.onclick = function () { openCampaign(campaignCache[+b.dataset.i]); };
  });
  tb.querySelectorAll('.resume').forEach(function (b) {
    b.onclick = function () { resumeCampaign(campaignCache[+b.dataset.i]); };
  });
  fillFollowupCampaigns();
}

/* Level 2: everyone in one campaign, and where each of them got to. */
async function openCampaign(c) {
  if (!c) return;
  currentCampaign = c;
  const host = $('campDetail');
  if (!host) return;
  host.classList.remove('hidden');
  host.innerHTML = '<p class="hint">Loading…</p>';

  let people = [];
  try {
    const r = await fetch('/api/campaigns?id=' + encodeURIComponent(c.id) + '&people=1').then(x => x.json());
    if (r && r.ok) people = r.people || [];
  } catch (e) {}

  const done = c.sent + c.failed;
  host.innerHTML =
    '<div class="detailhead">'
    + '<button class="back" id="campBack">&larr; All campaigns</button>'
    + '<h3>' + esc(c.name) + '</h3>'
    + '<span class="badge ' + c.status + '">' + c.status + '</span>'
    + '</div>'
    + '<div class="stats">'
    + '<div class="stat"><span>' + (c.total || done) + '</span><label>Recipients</label></div>'
    + '<div class="stat ok"><span>' + c.sent + '</span><label>Delivered</label></div>'
    + '<div class="stat bad"><span>' + c.failed + '</span><label>Failed</label></div>'
    + '<div class="stat"><span>' + (c.replied || 0) + '</span><label>Replied</label></div>'
    + '</div>'
    + '<p class="hint">Started ' + fmtWhen(c.startedAt)
    + (c.finishedAt ? ' &middot; finished ' + fmtWhen(c.finishedAt) : ' &middot; still running')
    + ' &middot; subject <span class="mono">' + esc(c.subject || '—') + '</span></p>'
    + '<div class="inbox" id="peopleList">'
    + (people.length
        ? people.map(function (p, i) {
            return '<button class="mailitem" data-i="' + i + '">'
              + '<span class="dot ' + personDot(p) + '"></span>'
              + '<span class="who">' + esc(p.name || p.email.split('@')[0]) + '</span>'
              + '<span class="subj">' + esc(p.email)
              + (p.followups ? ' &middot; ' + p.followups + ' follow-up' + (p.followups === 1 ? '' : 's') : '')
              + '</span>'
              + '<span class="meta"><span class="badge ' + personDot(p) + '">' + esc(personLabel(p)) + '</span>'
              + '<span class="when">' + (p.firstSentAt ? fmtWhen(p.firstSentAt).split(',')[0] : '') + '</span></span>'
              + '</button>';
          }).join('')
        : '<p class="empty">No recipients recorded for this campaign.</p>')
    + '</div>';

  $('campBack').onclick = function () { host.classList.add('hidden'); };
  host.querySelectorAll('#peopleList .mailitem').forEach(function (b) {
    b.onclick = function () { openThread(people[+b.dataset.i]); };
  });
}

const personDot = p => p.status === 'replied' ? 'reply'
  : p.status === 'bounced' ? 'bounce'
  : p.status === 'unsubscribed' ? 'unsubscribe'
  : p.status === 'ooo' ? 'ooo'
  : p.firstStatus === 'failed' ? 'bounce' : 'none';

function personLabel(p) {
  if (p.status === 'replied') return 'replied';
  if (p.status === 'bounced') return 'bounced';
  if (p.status === 'unsubscribed') return 'opt-out';
  if (p.status === 'ooo') return 'out of office';
  if (p.firstStatus === 'failed') return 'failed';
  return p.contacts > 1 ? p.contacts + ' contacts' : 'no reply';
}

/* Shared with Section 6's reply list further down — one label per reply
   kind, defined here since the thread table (right below) is the first
   thing in file order to need it. */
const KIND_LABEL = {
  reply: 'Replied', ooo: 'Out of office', bounce: 'Bounced',
  unsubscribe: 'Unsubscribed', none: 'No reply', auto: 'Bulk mail',
};

/* Level 3: the whole conversation with one person, in order. */
async function openThread(p) {
  if (!p) return;
  let trail = [];
  try {
    const r = await fetch('/api/thread?recipient=' + encodeURIComponent(p.id)).then(x => x.json());
    if (r && r.ok) trail = r.trail || [];
  } catch (e) {}

  $('modalTitle').textContent = p.name ? (p.name + ' — ' + p.email) : p.email;
  $('modalMeta').innerHTML =
    '<span class="badge ' + personDot(p) + '">' + esc(personLabel(p)) + '</span>'
    + ' &nbsp;&middot;&nbsp; ' + (p.contacts || p.sends || 0) + ' contact(s)'
    + (p.followups ? ' &middot; ' + p.followups + ' follow-up(s)' : '')
    + (p.repliedAt ? ' &middot; replied ' + fmtWhen(p.repliedAt) : '')
    + (p.doNotContact ? ' &nbsp;&middot;&nbsp; <b>suppressed from future sends</b>' : '');

  renderTrailTable(trail);
  $('modalBox').classList.add('wide');
  $('modal').classList.remove('hidden');
}

/* One row per event (sent or received), oldest first — a proper table
   rather than a loose bullet list, so "who got what and when" reads at a
   glance. A sent row expands in place to the exact delivered HTML
   (lazy-fetched via /api/body — a body is several KB and only worth the
   round trip once someone actually asks to see it) plus its attachment
   filenames; a received row expands to its snippet. Only one row is open
   at a time, mirroring how the campaign drill-down table already behaves. */
function renderTrailTable(trail) {
  const host = $('modalBody');
  if (!trail.length) {
    host.innerHTML = '<p class="hint">No messages recorded for this person yet.</p>';
    return;
  }
  host.innerHTML = '<div class="tablewrap"><table class="trailtable"><thead><tr>'
    + '<th>When</th><th></th><th>Subject</th><th>Attachments</th><th></th>'
    + '</tr></thead><tbody>'
    + trail.map(function (e, i) {
        const statusBadge = e.type === 'sent'
          ? '<span class="badge ' + (e.status === 'sent' ? 'sent' : 'failed') + '">' + esc(e.status || '') + '</span>'
          : '<span class="badge ' + (e.kind || 'none') + '">' + esc(KIND_LABEL[e.kind] || e.kind || '') + '</span>';
        const attachTxt = (e.attachments && e.attachments.length) ? e.attachments.map(esc).join(', ') : '—';
        return '<tr class="trailrow" data-i="' + i + '">'
          + '<td class="when">' + fmtWhen(e.at) + '</td>'
          + '<td>' + statusBadge + '</td>'
          + '<td><b>' + esc(e.label || (e.type === 'sent' ? 'Sent' : 'Received')) + '</b> — ' + esc(e.subject || '(no subject)') + '</td>'
          + '<td class="hint">' + attachTxt + '</td>'
          + '<td><button class="expand" data-i="' + i + '">Details</button></td>'
          + '</tr>'
          + '<tr class="trailexpand hidden" data-i="' + i + '"><td colspan="5"></td></tr>';
      }).join('')
    + '</tbody></table></div>';

  host.querySelectorAll('.expand').forEach(b => b.onclick = () => toggleTrailRow(host, trail, +b.dataset.i));
}

async function toggleTrailRow(host, trail, i) {
  const e = trail[i];
  const expandRow = host.querySelector('.trailexpand[data-i="' + i + '"]');
  const cell = expandRow.querySelector('td');
  const open = !expandRow.classList.contains('hidden');
  if (open) { expandRow.classList.add('hidden'); return; }
  // Collapse any other open row first — one detail view at a time.
  host.querySelectorAll('.trailexpand').forEach(r => r.classList.add('hidden'));
  expandRow.classList.remove('hidden');

  if (e.type === 'received') {
    cell.innerHTML = e.snippet ? '<div class="trailbody">' + esc(e.snippet) + '</div>'
      : '<p class="hint">No preview stored for this message.</p>';
    return;
  }

  cell.innerHTML = '<p class="hint">Loading the exact email that was sent…</p>';
  try {
    const r = await fetch('/api/body?id=' + encodeURIComponent(e.id)).then(x => x.json());
    const bodyHtml = (r.ok && r.body) ? r.body
      : '<p class="hint">The body was not recorded for this send — it predates body logging.</p>';
    cell.innerHTML = (e.error ? '<p class="msg bad">' + esc(e.error) + '</p>' : '')
      + (e.attachments && e.attachments.length
          ? '<p class="hint"><b>Attachments:</b> ' + e.attachments.map(esc).join(', ') + '</p>' : '')
      + '<div class="preview">' + bodyHtml + '</div>';
  } catch (err) {
    cell.innerHTML = '<p class="msg bad">Could not reach the server: ' + esc(err.message) + '</p>';
  }
}

/* ================= SECTION 6 — replies =================
   The stat tiles double as the filter: they are the only summary on screen,
   so making them the control removes a redundant row of pills and keeps the
   count and the filter in one place. */

let replyCache = [];          // everything the last scan found
let replyFilter = 'reply';    // which tile is pressed

function renderReplyStats() {
  const n = k => replyCache.filter(r => r.kind === k).length;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('stReplied', n('reply'));
  set('stOoo', n('ooo'));
  set('stBounced', n('bounce'));
  set('stUnsub', n('unsubscribe'));
  set('stNoReply', n('none'));
}

function renderReplyList() {
  const host = $('replyList');
  if (!host) return;
  const rows = replyCache.filter(r => r.kind === replyFilter);

  if (!rows.length) {
    host.innerHTML = '<p class="empty">No messages in <b>' + esc(KIND_LABEL[replyFilter] || replyFilter)
      + '</b>.' + (replyCache.length ? '' : ' Run a scan to look for replies.') + '</p>';
    return;
  }

  /* Build once and attach by index: rebuilding a node per click, or searching
     the cache by address, both go wrong when two people share a name. */
  host.innerHTML = rows.map((r, i) => {
    const when = new Date(r.receivedAt);
    const today = when.toDateString() === new Date().toDateString();
    const stamp = today
      ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : when.toLocaleDateString([], { day: 'numeric', month: 'short' });
    return '<button class="mailitem" data-i="' + i + '" aria-label="Open message from ' + esc(r.from) + '">'
      + '<span class="dot ' + r.kind + '"></span>'
      + '<span class="who">' + esc(nameFromAddress(r.from)) + '</span>'
      + '<span class="subj"><b>' + esc(r.subject || '(no subject)') + '</b>'
      + (r.snippet ? ' — ' + esc(r.snippet.slice(0, 90)) : '') + '</span>'
      + '<span class="meta">'
      + '<span class="badge ' + r.kind + '">' + esc(replyTag(r)) + '</span>'
      + '<span class="when">' + stamp + '</span></span></button>';
  }).join('');

  host.querySelectorAll('.mailitem').forEach(b => {
    b.onclick = () => openReply(rows[+b.dataset.i]);
  });
}

/* A short, honest label: why this was classified as it was. */
function replyTag(r) {
  if (r.kind === 'ooo' && r.oooUntil) {
    return 'back ' + new Date(r.oooUntil).toLocaleDateString([], { day: 'numeric', month: 'short' });
  }
  if (r.kind === 'bounce') return r.hard ? 'hard bounce' : 'soft bounce';
  if (r.kind === 'unsubscribe') return 'opt-out';
  if (r.contacts) return r.contacts + ordinal(r.contacts) + ' contact';
  return KIND_LABEL[r.kind] || r.kind;
}
const ordinal = n => (n % 10 === 1 && n !== 11) ? 'st' : (n % 10 === 2 && n !== 12) ? 'nd'
  : (n % 10 === 3 && n !== 13) ? 'rd' : 'th';

function nameFromAddress(email) {
  const p = parseName(String(email || ''));
  return p && p.full ? p.full : String(email || '').split('@')[0];
}

/* Open one message in the same viewer used for sent mail, with a bar
   explaining WHY it was classified the way it was — a wrong call should be
   debuggable, not mysterious. */
function openReply(r) {
  if (!r) return;
  $('modalTitle').textContent = r.subject || '(no subject)';
  $('modalMeta').innerHTML =
    '<b>From:</b> ' + esc(r.from)
    + ' &nbsp;&middot;&nbsp; ' + new Date(r.receivedAt).toLocaleString()
    + ' &nbsp;&middot;&nbsp; <span class="badge ' + r.kind + '">' + esc(KIND_LABEL[r.kind] || r.kind) + '</span>'
    + (r.oooUntil ? ' &nbsp;&middot;&nbsp; back ' + new Date(r.oooUntil).toLocaleDateString() : '');
  $('modalBody').innerHTML =
    '<div class="whybar">Detected as <b>' + esc(KIND_LABEL[r.kind] || r.kind) + '</b>'
    + (r.reason ? ' — ' + esc(r.reason) : '') + '</div>'
    + '<div class="mailbodytext">' + esc(r.body || r.snippet || '(no text)').split(String.fromCharCode(10)).join('<br/>') + '</div>';
  $('modal').classList.remove('hidden');
}

document.querySelectorAll('button.stat[data-kind]').forEach(b => {
  b.onclick = () => {
    replyFilter = b.dataset.kind;
    document.querySelectorAll('button.stat[data-kind]').forEach(x =>
      x.setAttribute('aria-pressed', String(x === b)));
    renderReplyList();
  };
});

renderReplyStats();
renderReplyList();

/* ================= SECTION 5 (cont.) — analytics ================= */
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
    const owner = campAccountTab || '';
    const r = await fetch('/api/log' + (owner ? '?owner=' + encodeURIComponent(owner) : '')).then(x => x.json());
    if (r && r.ok && r.available) {
      rows = r.rows;
      source = r.driver === 'postgres'
        ? '<b>Shared database</b> — every device and visitor sees this same history.'
        : '<b>SQLite</b> — <span class="mono">data/mail.db</span> on this machine.';
    } else if (r && r.reason) {
      source += '<br/><span class="mono">' + esc(r.reason) + '</span>';
    }
  } catch (e) {}
  if (!rows) {
    rows = localLogAll().slice().reverse();
    if (campAccountTab) rows = rows.filter(e => String(e.from || '').toLowerCase() === campAccountTab);
  }

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

/* ================= SECTION 2 — reconstructing a past campaign =================

   Search Sent by date range, a subject-or-body text fragment, and/or the
   recipient's email -> cluster the results into candidate campaigns with a
   confidence and a reason (never silently) -> preview the rebuilt template
   for the chosen cluster -> commit it into this app's own history, after
   which it behaves exactly like a campaign sent from here (follow-ups,
   suppression, the full thread view all just work). */

let importClusters = [];
let importMailbox = null;
let importUser = '';

function refreshImportAccountList() {
  const sel = $('impUser');
  if (!sel) return;
  const current = sel.value;
  const accounts = savedAccountList();
  sel.innerHTML = '<option value="">— choose a saved account —</option>'
    + accounts.map(a => '<option value="' + esc(a) + '">' + esc(a) + '</option>').join('');
  if (accounts.includes(current)) sel.value = current;
  else if (accounts.includes(activeAccountEmail)) sel.value = activeAccountEmail;
}
refreshImportAccountList();

if ($('btnImportScan')) $('btnImportScan').onclick = async () => {
  const user = $('impUser').value.trim();
  if (!user) return say($('importMsg'), 'Choose which account’s Sent folder to search.', false);
  const s = session(user);
  if (!s || !s.gPass) return say($('importMsg'), 'That account has no saved App Password — add it in Section 1 first.', false);

  const query = $('impQuery').value.trim();
  const to = $('impTo').value.trim();
  const since = $('impSince').value || null;
  const until = $('impUntil').value || null;
  const pasted = $('impPasted').value.trim();
  if (!query && !to && !since && !pasted) {
    if (!confirm('No search text, recipient or start date given — this will list everything in the last 90 days. Continue?')) return;
  }

  importUser = user;
  const btn = $('btnImportScan');
  btn.disabled = true;
  say($('importMsg'), 'Searching Sent folder…', true);
  $('importResults').innerHTML = '';
  $('importPreview').classList.add('hidden');
  $('impToCaveat').textContent = '';

  try {
    let cursor = null, rounds = 0, examined = 0, total = 0;
    let mailbox = null;
    /* Each /api/import scan call clusters only the UIDs IT fetched — a
       cursor page's worth, not the whole search. A multi-page scan (the
       server stops early at its own time budget and hands back a cursor to
       resume from) would otherwise show only the LAST page's clusters,
       silently dropping every earlier page's results. Merge by cluster key
       across pages instead of overwriting, combining recipient/uid lists
       for a key seen on more than one page. */
    const byKey = new Map();
    let bccCaveat = false;
    do {
      const r = await fetch('/api/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'scan', user, pass: s.gPass,
          query: query || null, to: to || null, since, until, pasted: pasted || null, cursor,
        }),
      }).then(x => x.json());
      if (!r.ok) { say($('importMsg'), (r.error || 'Search failed') + (r.hint ? ' — ' + r.hint : ''), false); break; }
      mailbox = r.mailbox;
      if (r.bccCaveat) bccCaveat = true;
      (r.clusters || []).forEach(c => {
        const prev = byKey.get(c.key);
        if (!prev) { byKey.set(c.key, c); return; }
        prev.uids = [...new Set([...prev.uids, ...c.uids])];
        prev.messageIds = [...new Set([...prev.messageIds, ...c.messageIds])];
        prev.recipients = [...new Set([...prev.recipients, ...c.recipients])];
        prev.recipientCount = prev.recipients.length;
        prev.count += c.count;
        prev.alreadyImported = (prev.alreadyImported || 0) + (c.alreadyImported || 0);
        prev.bccInCluster = prev.bccInCluster || c.bccInCluster;
        if (String(c.firstAt) < String(prev.firstAt)) prev.firstAt = c.firstAt;
        if (String(c.lastAt) > String(prev.lastAt)) prev.lastAt = c.lastAt;
      });
      examined += r.examined || 0;
      total = r.total || total;
      cursor = r.done ? null : r.cursor;
      say($('importMsg'), examined + (total ? ' of ' + total : '') + ' messages examined · '
        + byKey.size + ' candidate campaign(s) found so far…', true);
    } while (cursor && ++rounds < 20);

    importClusters = [...byKey.values()];
    importMailbox = mailbox;
    renderImportClusters();
    say($('importMsg'), importClusters.length
      ? importClusters.length + ' candidate campaign(s) found.'
      : 'Nothing matched. Try a wider date range or a shorter search fragment.', importClusters.length > 0);

    /* A search by recipient email can only ever see the To: header — a real
       BCC send never carries that address in any header a Sent-folder copy
       keeps, so this is said plainly rather than letting "nothing found"
       read as "definitely never contacted." Several comma-separated
       addresses match ANY of them (an OR search — see buildSentSearch()),
       so the caveat text names all of them rather than assuming there's
       only one. */
    if (bccCaveat) {
      const toNames = to.split(',').map(s => s.trim()).filter(Boolean);
      const toLabel = toNames.length > 1 ? 'any of ' + toNames.join(', ') : toNames[0];
      $('impToCaveat').textContent = importClusters.length
        ? 'Note: this search only sees the To: header — if ' + toLabel + ' was BCC’d on a campaign, '
          + 'it may be sitting in one of these results without being named as a recipient, or may not '
          + 'be found at all. Preview a result to check who it actually names.'
        : toLabel + ' ' + (toNames.length > 1 ? 'were' : 'was') + ' not found in the To: header of anything '
          + 'in this range — but a BCC’d send to them would not show up here either. Try searching by '
          + 'subject/body text instead if you know roughly what the campaign said.';
    }
  } catch (e) {
    say($('importMsg'), 'Could not reach the server: ' + e.message, false);
  } finally {
    btn.disabled = false;
  }
};

/* Confidence is reported, never enforced (importer.js's own design: "a slow,
   hand-sent campaign is still a campaign, it just needs a human to confirm
   it") -- so every cluster shows its reason, and low-confidence ones are not
   hidden, just visually deprioritised. */
function renderImportClusters() {
  const host = $('importResults');
  if (!host) return;
  if (!importClusters.length) { host.innerHTML = ''; return; }
  host.innerHTML = '<div class="tablewrap"><table><thead><tr>'
    + '<th>Confidence</th><th>Subject</th><th>Recipients</th><th>Span</th><th>Why</th><th></th>'
    + '</tr></thead><tbody>'
    + importClusters.map((c, i) => '<tr class="' + (c.confidence === 'low' ? 'lowconf' : '') + '">'
      + '<td><span class="badge ' + (c.confidence === 'high' ? 'sent' : c.confidence === 'medium' ? 'g' : 'w') + '">' + esc(c.confidence) + '</span></td>'
      + '<td>' + esc(c.subject || '(no subject)') + (c.alreadyImported ? ' <span class="badge p">already imported</span>' : '')
      /* Never merged automatically — only ever a suggestion the user reads
         and acts on themselves (open both previews, decide). This is the
         DeepSeek-assisted last resort for clusters the deterministic
         subject/timing match above couldn't tell apart, e.g. one recipient
         got "...at India Health 2026" and another just "...at the event". */
      + (c.mergeSuggestions && c.mergeSuggestions.length
          ? '<br/><span class="hint">💡 might be the same campaign as: '
            + c.mergeSuggestions.map(s => '"' + esc(s.subject) + '" (' + esc(s.reason) + ')').join('; ') + '</span>'
          : '')
      + (c.bccInCluster
          ? '<br/><span class="hint warn">contains a message with hidden (BCC) recipients — preview to see who it actually names</span>'
          : '') + '</td>'
      + '<td>' + c.recipientCount + '</td>'
      + '<td>' + esc(humanSpan(c.spanMs)) + '</td>'
      + '<td class="hint">' + esc(c.reason) + '</td>'
      + '<td><button class="preview" data-i="' + i + '"' + (c.alreadyImported === c.count ? ' disabled' : '') + '>Preview</button></td>'
      + '</tr>').join('')
    + '</tbody></table></div>';
  host.querySelectorAll('.preview').forEach(b => b.onclick = () => previewImportCluster(importClusters[+b.dataset.i]));
}
function humanSpan(ms) {
  if (!ms) return 'one moment';
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  if (ms < 3600000) return Math.round(ms / 60000) + 'm';
  if (ms < 86400000) return Math.round(ms / 3600000) + 'h';
  return Math.round(ms / 86400000) + 'd';
}

let importPreviewCluster = null;

async function previewImportCluster(cluster) {
  importPreviewCluster = cluster;
  const s = session(importUser);
  const box = $('importPreview');
  box.classList.remove('hidden');
  box.innerHTML = '<p class="hint">Loading preview…</p>';
  try {
    const r = await fetch('/api/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'preview', user: importUser, pass: s.gPass, mailbox: importMailbox, uids: cluster.uids }),
    }).then(x => x.json());
    if (!r.ok) { box.innerHTML = '<p class="msg bad">' + esc(r.error || 'Preview failed') + '</p>'; return; }

    box.innerHTML = '<h3>Preview — ' + esc(cluster.subject || '(no subject)') + '</h3>'
      + '<p class="hint">Rebuilt template, confidence <b>' + esc(r.confidence) + '</b>'
      + (r.note ? ' — ' + esc(r.note) : '') + '</p>'
      + '<div class="preview">' + r.template.replace(/\n/g, '<br/>') + '</div>'
      + (r.outliers && r.outliers.length
          ? '<p class="hint warn">' + r.outliers.length + ' message(s) set aside as probably unrelated (differ by '
            + r.outliers.map(o => o.differencePct + '%').join(', ') + ') — not imported.</p>' : '')
      + '<p class="hint">' + r.samples.length + ' message(s) will be imported, one send row each, carrying their original Message-Id '
      + 'so a follow-up can thread onto them.</p>'
      + '<div class="row">'
      + '<button id="btnImportCommit" class="primary">Import this campaign</button>'
      + '<button id="btnImportCancel">Cancel</button>'
      + '</div>';

    $('btnImportCommit').onclick = () => commitImportCluster(cluster);
    $('btnImportCancel').onclick = () => box.classList.add('hidden');
  } catch (e) {
    box.innerHTML = '<p class="msg bad">Could not reach the server: ' + esc(e.message) + '</p>';
  }
}

async function commitImportCluster(cluster) {
  const s = session(importUser);
  if (!confirm('Import "' + (cluster.subject || '(no subject)') + '" as a campaign? '
    + 'Its replies are already sitting in the inbox — scan for replies right after, '
    + 'before sending any follow-up, so anyone who already answered is excluded.')) return;

  const btn = $('btnImportCommit');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
  try {
    const r = await fetch('/api/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'commit', user: importUser, pass: s.gPass, mailbox: importMailbox, uids: cluster.uids, source: 'search' }),
    }).then(x => x.json());
    if (!r.ok) { say($('importMsg'), r.error || 'Import failed', false); return; }

    say($('importMsg'), 'Imported ' + r.added + ' send(s)'
      + (r.skipped ? ', ' + r.skipped + ' skipped (duplicates or hidden BCC recipients)' : '')
      + '. Now scan for replies (Section 6) before sending any follow-up.', true);
    $('importPreview').classList.add('hidden');
    campaignCache = [];
    loadCampaigns();
  } catch (e) {
    say($('importMsg'), 'Could not reach the server: ' + e.message, false);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Import this campaign'; }
  }
}
