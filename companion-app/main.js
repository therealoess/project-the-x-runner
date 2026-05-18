// Project THE X Runner — Electron main process.
//
// Wraps the existing companion CLI (companion/companion.js) in a single
// branded window + system-tray icon. The operator never has to open a
// terminal: install the .app or .exe, paste the pairing code from the
// dashboard, the GUI takes care of the rest.
//
// We deliberately do NOT re-implement the companion's connection /
// dispatch logic here. It runs as a child_process so this app stays a
// thin GUI shell — bug fixes to the CLI ship to the GUI without any
// code duplication.

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, nativeTheme, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
// Auto-updater — pulls the latest release from the runner repo's GitHub
// Releases (build.publish.provider in package.json points here). On launch
// we kick off an async check; if a newer version is available the new
// installer is downloaded silently in the background and a 'restart to
// install' notification is surfaced. Replaces the previous flow where the
// user saw 'A newer companion is available — run npx ... --reinstall' in
// the activity log and had to copy a terminal command they couldn't run.
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); }
catch (e) { /* dev mode without the dep installed — disable auto-update */ }

// ---------- Locate the bundled companion script ------------------------
//
// In dev we run from companion-app/ alongside companion/, so resolve
// ../companion/companion.js. In a packaged build electron-builder copies
// it under process.resourcesPath/companion/companion.js (see
// extraResources in package.json).
function resolveCompanionScript() {
  const devPath = path.join(__dirname, '..', 'companion', 'companion.js');
  if (fs.existsSync(devPath)) return devPath;
  const prodPath = path.join(process.resourcesPath, 'companion', 'companion.js');
  if (fs.existsSync(prodPath)) return prodPath;
  return null;
}

// ---------- Credential helpers (mirrored from companion CLI) -----------
//
// The CLI stores credentials at ~/.project-the-x-companion/credentials.json.
// The GUI reads it to show pairing state before the CLI is even started.
const CRED_DIR  = path.join(os.homedir(), '.project-the-x-companion');
const CRED_FILE = path.join(CRED_DIR, 'credentials.json');

function readCreds() {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); } catch { return null; }
}

// ---------- Companion lifecycle ----------------------------------------
let runner = null;            // ChildProcess
let runnerStartedAt = null;
let jobsThisSession = 0;
let lastActivityAt = null;
let lastEvent = null;         // last status update from the CLI's stdout
let isConnected = false;
let pairingPending = false;
let mainWindow = null;
let tray = null;

function spawnRunner() {
  if (runner && !runner.killed) return runner;
  const script = resolveCompanionScript();
  if (!script) {
    sendToRenderer('runner_state', { state: 'error', message: 'Companion script not found. Reinstall the app.' });
    return null;
  }
  // Refuse to spawn the CLI when there are no credentials on disk. The
  // CLI would just print 'No credentials yet' and exit with code 1, which
  // looks like a crash to the user. Pop the pairing screen instead so the
  // user has somewhere to paste the code they generated.
  if (!fs.existsSync(CRED_FILE)) {
    sendToRenderer('runner_state', { state: 'unpaired' });
    return null;
  }
  // Run without --headless so the CLI's own console output appears in our
  // log feed. Use the Node bundled with Electron — accessed via
  // process.execPath with ELECTRON_RUN_AS_NODE=1 so it behaves like plain
  // Node. Side-steps the "no system Node installed" failure mode that
  // bites every fresh user trying to npx the CLI.
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  runner = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  runnerStartedAt = Date.now();
  sendToRenderer('runner_state', { state: 'starting' });
  runner.stdout.on('data', (b) => onRunnerLog(b.toString('utf8'), 'stdout'));
  runner.stderr.on('data', (b) => onRunnerLog(b.toString('utf8'), 'stderr'));
  runner.on('exit', (code) => {
    isConnected = false;
    refreshTray();
    runner = null;
    // If creds vanished while the CLI was alive (or the CLI exited with
    // code 1 because they were never there), the renderer needs to land
    // on the pair screen — not 'stopped' (which the renderer ignores)
    // and not 'reconnecting' (which the offline card uses).
    if (!fs.existsSync(CRED_FILE)) {
      sendToRenderer('runner_state', { state: 'unpaired' });
    } else {
      sendToRenderer('runner_state', { state: 'stopped', exit_code: code });
    }
  });
  return runner;
}

function killRunner() {
  if (!runner || runner.killed) return;
  try { runner.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { runner?.kill('SIGKILL'); } catch {} }, 2000);
}

// Translate the CLI's plain-text log lines into UI-friendly events.
// The CLI emits things like:
//   [companion] connected to wss://...
//   [companion] received ai_request job_id=abc123
//   [companion] websocket closed; reconnecting in 4s
// We sniff those strings to update the connection dot + job counter
// without coupling to a private protocol — same lines that ship to the
// log feed below feed the status, so any future CLI log change shows up
// in both surfaces consistently.
// Regex-based log sniffing. Critical that 'connected' doesn't false-match
// 'disconnected', and that 'connecting to' doesn't get treated as already
// connected — the CLI logs both lines microseconds apart on every restart.
//
// CLI log shapes we care about (companion.js):
//   [companion] connecting to https://<dashboard>…           ← starting
//   [companion] connected · machine <id> · user <email>      ← CONNECTED ★
//   [companion] disconnected (<code>) … — reconnecting in Xs ← reconnecting
//   [companion] AI request <8-hex> · <label> · <model>       ← job in
//   [companion] AI request done · <8-hex> · ok=true          ← job out
//                  (or 'ai_response' / 'sending ai_response')
//
// Match on the bracketed prefix so a stray 'connected' substring in some
// other log line (e.g. an error message echoing the word) can't flip the UI.
const RX_CONNECTING  = /\[companion\] connecting to/i;
const RX_CONNECTED   = /\[companion\] connected[\s·]/i;
const RX_DISCONNECT  = /\[companion\] disconnected\b|reconnecting in|websocket closed/i;
// The CLI's actual ai-job-start log line is `[companion] AI request <id> · …`
// — the earlier regex only matched 'received ai_request' / 'ai_request job_id'
// which the CLI never emits, so the UI counter sat at 0 for every session
// the user reported as "jobs these sessions doesnt count at all".
const RX_AI_IN       = /\[companion\]\s+AI request\b(?! done)|received ai_request|ai_request job_id|spawn(ing)?\s+claude/i;
const RX_AI_OUT      = /\[companion\]\s+AI request done\b|sending ai_response|ai_response|finished job/i;
// 'No credentials yet' is the literal line companion.js prints when
// loadCreds() returns null at boot. Without this match the GUI would
// silently sit on the previous state (Connecting / Reconnecting) while
// the CLI exits with code 1 — the user sees the activity-log message
// telling them to pair, but no actual pair form, which is what made
// it look like 'the app has no place to enter the code'.
const RX_UNPAIRED    = /credentials not found|not paired|no credentials yet/i;

function onRunnerLog(text, stream) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    sendToRenderer('log', { stream, line, t: Date.now() });
    // Order matters: check the negative-going states first (disconnected
    // contains the substring 'connected'). RX_DISCONNECT is checked before
    // RX_CONNECTED so a 'disconnected' line never trips the connected path.
    if (RX_DISCONNECT.test(line)) {
      isConnected = false;
      sendToRenderer('runner_state', { state: 'reconnecting' });
      refreshTray();
    } else if (RX_CONNECTED.test(line)) {
      isConnected = true; lastActivityAt = Date.now();
      sendToRenderer('runner_state', { state: 'connected' });
      refreshTray();
    } else if (RX_CONNECTING.test(line) && !isConnected) {
      sendToRenderer('runner_state', { state: 'starting' });
    } else if (RX_AI_IN.test(line)) {
      jobsThisSession++; lastActivityAt = Date.now();
      sendToRenderer('stats', { jobs: jobsThisSession, last: lastActivityAt });
    } else if (RX_AI_OUT.test(line)) {
      lastActivityAt = Date.now();
      sendToRenderer('stats', { jobs: jobsThisSession, last: lastActivityAt });
    } else if (RX_UNPAIRED.test(line)) {
      sendToRenderer('runner_state', { state: 'unpaired' });
    }
    lastEvent = line;
  }
}

function sendToRenderer(channel, payload) {
  // Guard against the destroyed-window race: payloads can fire from
  // ticker intervals (auto-update poll, log forwarder) AFTER the user
  // closed the window. webContents.send on a destroyed window throws
  // 'Object has been destroyed' which crashes the main process.
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents?.send(channel, payload); } catch {}
}

// ---------- Pairing ----------------------------------------------------
//
// Pairing exchanges a one-shot code (from Settings → AI Runner on the
// dashboard) for a long-lived JWT stored at CRED_FILE. POST direct from
// the GUI so the operator never copy/pastes URLs into a terminal.

async function tryPair({ code, dashboard_url }) {
  if (!code || !dashboard_url) throw new Error('Both code and dashboard URL are required.');
  pairingPending = true;
  sendToRenderer('runner_state', { state: 'pairing' });
  try {
    const url = dashboard_url.replace(/\/+$/, '') + '/api/companion/pair';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        machine: { id: getMachineId(), hostname: os.hostname(), platform: os.platform(), node: process.versions.node, app: 'gui' }
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.token) {
      throw new Error(data?.error || `Pairing failed (HTTP ${res.status})`);
    }
    fs.mkdirSync(CRED_DIR, { recursive: true });
    const dashUrl = dashboard_url.replace(/\/+$/, '');
    // Write BOTH `dashboard` (the key the CLI's connect path reads) and
    // `dashboard_url` (the key earlier GUI versions stored). Same payload,
    // two keys — covers any reader without a normalisation step.
    fs.writeFileSync(CRED_FILE, JSON.stringify({
      token: data.token,
      dashboard: dashUrl,
      dashboard_url: dashUrl,
      machine_id: getMachineId(),
      user: data.user || null,
      paired_at: Date.now()
    }, null, 2), { mode: 0o600 });
    pairingPending = false;
    // Restart the runner so it picks up the new creds.
    killRunner();
    setTimeout(spawnRunner, 500);
    return { ok: true };
  } catch (e) {
    pairingPending = false;
    sendToRenderer('runner_state', { state: 'unpaired', error: e.message });
    return { ok: false, error: e.message };
  }
}

function getMachineId() {
  // Stable per-machine identifier — concatenated MAC of the first
  // non-loopback iface, hashed lightly so we don't put a bare MAC on
  // the wire. Matches what the CLI computes.
  const iface = Object.values(os.networkInterfaces()).flat().find((n) => n && !n.internal && n.mac && n.mac !== '00:00:00:00:00:00');
  const raw = (iface?.mac || os.hostname()) + ':' + os.platform();
  // Simple non-crypto digest — stable enough for an audit log entry.
  let h = 5381; for (const c of raw) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  return 'gui-' + (h >>> 0).toString(16).padStart(8, '0');
}

function unpair() {
  killRunner();
  try { fs.unlinkSync(CRED_FILE); } catch {}
  sendToRenderer('runner_state', { state: 'unpaired' });
}

// ---------- Window + tray ----------------------------------------------
/** True when the BrowserWindow reference is still attached to a live
 *  native window. After Electron destroys it (e.g. closed on Windows /
 *  Linux, system memory pressure, or post-update window respawn), the
 *  reference stays in the variable but isDestroyed() flips true and any
 *  method call throws 'Object has been destroyed'. We probe both before
 *  every showMain() / tray click to avoid the crash the user saw. */
function _windowAlive() {
  return !!(mainWindow && !mainWindow.isDestroyed());
}
function createWindow() {
  if (_windowAlive()) { mainWindow.show(); return mainWindow; }
  mainWindow = new BrowserWindow({
    width: 480, height: 600,
    minWidth: 420, minHeight: 540,
    resizable: true,
    show: false,
    backgroundColor: '#f4f1ec',
    title: 'Project THE X Runner',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join('renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // Closing the window hides it to the tray instead of quitting. Operator
  // explicitly chooses Quit from the tray (or menubar on Mac) to fully exit.
  mainWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      if (_windowAlive()) mainWindow.hide();
      if (process.platform === 'darwin') app.dock?.hide();
    }
  });
  // Clear the reference once the native window is gone so the next
  // tray click rebuilds a fresh BrowserWindow instead of trying to
  // method-call into a destroyed object.
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

function setupTray() {
  if (tray) return;
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  // Tray icons on macOS look best at 22x22 (template image). Resizing here
  // avoids a giant menubar entry; Windows / Linux are size-tolerant.
  tray = new Tray(img.resize({ width: 22, height: 22 }));
  refreshTray();
  // Always route through showMain — it re-creates the window when the
  // reference is dead, preventing 'Object has been destroyed' on every
  // subsequent tray click after the window has been closed.
  tray.on('click', () => showMain());
}

function refreshTray() {
  if (!tray) return;
  const status = !runner            ? 'Not running'
              : isConnected         ? 'Connected'
              : pairingPending      ? 'Pairing…'
              : runnerStartedAt     ? 'Reconnecting…'
              :                       'Starting…';
  const dot = isConnected ? '●' : '○';
  tray.setToolTip(`Project THE X Runner — ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${dot} ${status}`, enabled: false },
    { type: 'separator' },
    { label: 'Open window', click: () => showMain() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuiting = true; killRunner(); app.quit(); } }
  ]));
}

function showMain() {
  if (!_windowAlive()) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === 'darwin') app.dock?.show?.();
}

// ---------- IPC --------------------------------------------------------
ipcMain.handle('get_state', () => ({
  creds: !!readCreds(),
  dashboard_url: readCreds()?.dashboard_url || '',
  paired_user: readCreds()?.user || null,
  paired_at: readCreds()?.paired_at || null,
  runner_running: !!runner && !runner.killed,
  is_connected: isConnected,
  jobs: jobsThisSession,
  last_activity: lastActivityAt,
  open_at_login: app.getLoginItemSettings().openAtLogin,
  version: app.getVersion(),
  platform: process.platform
}));
ipcMain.handle('pair',   (_e, args) => tryPair(args || {}));
ipcMain.handle('unpair', () => { unpair(); return { ok: true }; });
ipcMain.handle('start',  () => { spawnRunner(); return { ok: true }; });
ipcMain.handle('stop',   () => { killRunner(); return { ok: true }; });
ipcMain.handle('quit',   () => { app.isQuiting = true; killRunner(); app.quit(); });
ipcMain.handle('open_external', (_e, url) => shell.openExternal(url));
ipcMain.handle('toggle_open_at_login', (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true });
  return { ok: true, open_at_login: app.getLoginItemSettings().openAtLogin };
});

// ---------- App lifecycle ----------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
  app.whenReady().then(() => {
    setupTray();
    createWindow();
    // If we already have credentials, auto-start the runner so the user
    // doesn't have to touch anything on launch. First-run with no creds:
    // explicitly tell the renderer to show the unpaired card — without
    // this nudge the renderer's initial refresh() races with window load
    // and on some machines the user lands on a blank/stuck card.
    if (readCreds()) {
      spawnRunner();
    } else {
      // Wait a tick so the renderer has wired up its onRunnerState listener.
      setTimeout(() => sendToRenderer('runner_state', { state: 'unpaired' }), 200);
    }
    setupAutoUpdate();
  });
  app.on('window-all-closed', () => {
    // Hide-instead-of-quit is handled at the BrowserWindow.close level;
    // we keep the app alive across all platforms so the tray icon stays.
  });
  app.on('before-quit', () => { app.isQuiting = true; killRunner(); });
}

// ---------- Auto-update --------------------------------------------------
//
// Hits GitHub Releases on every launch (via electron-updater), downloads
// the new build silently if one's available, and surfaces a 'restart to
// install' nudge to the user when it's ready. We don't FORCE restart —
// the companion may be mid-AI-job and yanking the process kills the
// claude subprocess too. The user gets:
//   • a runner_state: 'update_ready' event for the renderer to render
//     an inline 'restart to install vX.Y.Z' banner with a button
//   • a fallback macOS / Windows native dialog if the renderer isn't
//     responsive (e.g. window hidden, app running in tray only)
function setupAutoUpdate() {
  if (!autoUpdater) return;            // dep not installed (dev mode)
  if (!app.isPackaged) return;         // never run in `electron .` dev runs
  // Quiet logging — electron-updater is chatty by default and the activity
  // log is for the runner itself, not for boot-time HTTP probes.
  autoUpdater.autoDownload          = true;
  autoUpdater.autoInstallOnAppQuit  = true;
  autoUpdater.allowDowngrade        = false;
  autoUpdater.on('update-available', (info) => {
    sendToRenderer('runner_state', { state: 'update_downloading', version: info?.version || '' });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendToRenderer('runner_state', { state: 'update_ready', version: info?.version || '' });
    // Backup notification path: if the renderer isn't visible the user
    // wouldn't see the in-app banner, so pop a native dialog too. They
    // can click 'Later' to defer until the next quit.
    const ver = info?.version || '?';
    dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      title: 'Update ready',
      message: `Project THE X Runner ${ver} is downloaded and ready to install.`,
      detail: 'Restart now to apply, or it will install automatically next time you quit the app.'
    }).then(({ response }) => {
      if (response === 0) {
        killRunner();
        autoUpdater.quitAndInstall();
      }
    }).catch(() => {});
  });
  autoUpdater.on('error', (err) => {
    // Swallow — auto-update failures should NEVER take the runner down.
    // Common causes: offline, GitHub rate-limit, dev build. The user can
    // still re-download manually from the dashboard.
    try { sendToRenderer('log', { stream: 'stderr', line: `[updater] ${err?.message || err}`, t: Date.now() }); } catch {}
  });
  // Kick the check immediately, then poll every 6 hours so a long-running
  // app eventually picks up new releases without needing a relaunch.
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 6 * 60 * 60 * 1000);
}
// IPC handler the renderer can call from its 'restart now' banner button.
ipcMain.handle('apply_update', () => {
  if (!autoUpdater) return { ok: false, error: 'updater not loaded' };
  try { killRunner(); autoUpdater.quitAndInstall(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
