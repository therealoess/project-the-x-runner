// Project THE X Runner — renderer logic.
//
// Single-window state machine: Unpaired → Pairing → Connected ↔ Offline.
// All access to the OS goes through window.THEX (preload bridge); the
// renderer itself never touches Node APIs.

const $ = (id) => document.getElementById(id);

const cards = {
  unpaired:  $('state-unpaired'),
  pairing:   $('state-pairing'),
  connected: $('state-connected'),
  offline:   $('state-offline')
};
function show(name) {
  for (const k of Object.keys(cards)) cards[k].hidden = (k !== name);
}

let stats = { jobs: 0, last: null };
let paired = false;

function fmtTime(ms) {
  if (!ms) return '—';
  const ago = Date.now() - ms;
  if (ago < 60_000)    return Math.max(1, Math.round(ago / 1000)) + 's ago';
  if (ago < 3600_000)  return Math.round(ago / 60_000) + 'm ago';
  return new Date(ms).toLocaleString();
}
function fmtDate(ms) {
  if (!ms) return '—';
  try { return new Date(ms).toLocaleString(); } catch { return '—'; }
}

// Refresh the relative-time labels on the Connected card every 10s so
// 'Last activity: 3m ago' stays accurate without a hard reload.
setInterval(() => {
  if (!cards.connected.hidden) {
    $('kv-last').textContent = fmtTime(stats.last);
  }
}, 10_000);

async function refresh() {
  const s = await window.THEX.getState();
  paired = !!s.creds;
  $('version').textContent = 'v' + s.version;
  if (s.paired_user) {
    $('kv-user').textContent = (s.paired_user.email || s.paired_user.name || '—');
  } else {
    $('kv-user').textContent = '—';
  }
  $('kv-dashboard').textContent  = s.dashboard_url || '—';
  $('kv-paired-at').textContent  = fmtDate(s.paired_at);
  $('open-at-login').checked     = !!s.open_at_login;
  if (!paired) { show('unpaired'); return; }
  if (s.is_connected)             show('connected');
  else if (s.runner_running)      show('offline');
  else                            show('offline');
}

window.THEX.onRunnerState((p) => {
  if (p.state === 'pairing')    { $('pairing-message').textContent = 'Talking to your dashboard.'; show('pairing'); }
  if (p.state === 'starting')   { $('pairing-message').textContent = 'Starting the local runner.';   show('pairing'); }
  if (p.state === 'connected')  { refresh(); }
  if (p.state === 'reconnecting') { show('offline'); }
  if (p.state === 'unpaired')   { show('unpaired'); if (p.error) showPairError(p.error); }
  if (p.state === 'stopped')    { refresh(); /* re-check creds + connection state */ }
  if (p.state === 'error')      { showPairError(p.message || 'unknown error'); }
  if (p.state === 'update_downloading') { showUpdateBanner(`Downloading update v${p.version || ''}…`, false); }
  if (p.state === 'update_ready')       { showUpdateBanner(`Update v${p.version || ''} ready — restart to install.`, true); }
});

// Update banner — shown at the top of the active card whenever a new
// release has been auto-downloaded. The 'Restart now' button calls the
// IPC handler which kills the runner cleanly + tells electron-updater to
// quitAndInstall. 'Later' just hides the banner; the update still applies
// automatically when the user next quits the app.
function showUpdateBanner(text, withButton) {
  let bar = document.getElementById('update-banner');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'update-banner';
    bar.className = 'update-banner';
    document.body.insertBefore(bar, document.body.firstChild);
  }
  bar.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = text;
  bar.appendChild(label);
  if (withButton) {
    const btn = document.createElement('button');
    btn.textContent = 'Restart now';
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Restarting…';
      try { await window.THEX.applyUpdate(); } catch {}
    });
    bar.appendChild(btn);
    const later = document.createElement('button');
    later.textContent = 'Later';
    later.className = 'ghost';
    later.addEventListener('click', () => bar.remove());
    bar.appendChild(later);
  }
}
window.THEX.onStats((p) => {
  stats = { jobs: p.jobs ?? stats.jobs, last: p.last ?? stats.last };
  $('kv-jobs').textContent = String(stats.jobs);
  $('kv-last').textContent = fmtTime(stats.last);
});
window.THEX.onLog((p) => {
  const feed = $('log-feed');
  const stamp = new Date(p.t).toLocaleTimeString();
  feed.textContent += `[${stamp}] ${p.line}\n`;
  // Keep the feed bounded — 400 lines max so memory + scroll stay tame.
  const lines = feed.textContent.split('\n');
  if (lines.length > 400) feed.textContent = lines.slice(-400).join('\n');
  feed.scrollTop = feed.scrollHeight;
});

// ---------- Pair card --------------------------------------------------
function showPairError(msg) {
  const el = $('pair-error');
  el.textContent = '✕ ' + msg;
  el.hidden = false;
}
$('pair-btn').addEventListener('click', async () => {
  $('pair-error').hidden = true;
  const url  = $('pair-url').value.trim();
  const code = $('pair-code').value.trim();
  if (!url || !code) { showPairError('Both the dashboard URL and the pairing code are required.'); return; }
  $('pair-btn').disabled = true;
  show('pairing');
  const r = await window.THEX.pair({ dashboard_url: url, code });
  $('pair-btn').disabled = false;
  if (!r.ok) { show('unpaired'); showPairError(r.error || 'Pairing failed.'); return; }
  refresh();
});
$('open-dashboard').addEventListener('click', (e) => {
  e.preventDefault();
  const url = $('pair-url').value.trim() || 'https://project-the-x.com';
  window.THEX.openExternal(url);
});

// ---------- Connected card actions ------------------------------------
$('hide-btn').addEventListener('click', () => window.close());
$('restart-btn').addEventListener('click', async () => {
  await window.THEX.stop();
  setTimeout(() => window.THEX.start(), 600);
});
$('unpair-btn').addEventListener('click', async () => {
  if (!confirm('Unpair this runner? You will need a fresh pairing code from the dashboard to reconnect.')) return;
  await window.THEX.unpair();
  refresh();
});
$('unpair-btn-2').addEventListener('click', () => $('unpair-btn').click());
$('open-at-login').addEventListener('change', async (e) => {
  await window.THEX.toggleOpenAtLogin(e.target.checked);
});
$('reconnect-btn').addEventListener('click', async () => {
  await window.THEX.stop();
  setTimeout(() => window.THEX.start(), 400);
});

// ---------- Log toggle + copy/clear -----------------------------------
$('log-toggle').addEventListener('click', () => {
  const feed = $('log-feed');
  feed.hidden = !feed.hidden;
  $('log-toggle').textContent = feed.hidden ? 'Show activity log' : 'Hide activity log';
  // Copy / Clear are only useful while the log is visible.
  $('log-copy').hidden  = feed.hidden;
  $('log-clear').hidden = feed.hidden;
  if (feed.hidden) $('log-copied').hidden = true;
});

$('log-copy').addEventListener('click', async () => {
  const feed = $('log-feed');
  const text = feed.textContent || '';
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for older Electron / when clipboard API is unavailable.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
  const flash = $('log-copied');
  flash.hidden = false;
  clearTimeout(window.__copyFlashTimer);
  window.__copyFlashTimer = setTimeout(() => { flash.hidden = true; }, 1800);
});

$('log-clear').addEventListener('click', () => {
  $('log-feed').textContent = '';
});

// Initial paint.
refresh();
