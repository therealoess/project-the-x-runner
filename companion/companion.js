// Project THE X — Local AI Companion
//
// Runs on the operator's own machine. Spawns the local `claude` CLI (which
// is authenticated via `claude login` to their own Anthropic account) when
// the hosted dashboard requests AI work. The user's Claude subscription pays.
//
// Connection model: this companion initiates an outbound WebSocket to the
// dashboard. The dashboard never opens an inbound connection to the user's
// machine — works behind every NAT / corporate firewall. Auth is via a
// pairing token the user copies from Settings → AI Runner on their dashboard.
//
// What it does:
//   • Connect to wss://<dashboard>/ws/companion?token=<JWT>
//   • Receive `ai_request` jobs, spawn `claude -p`, return `ai_response`
//   • Stream stdout `stream-json` events as `ai_event` so the dashboard
//     can show live progress.
//   • Reconnect with exponential backoff on disconnect.
//   • Persist its credential at ~/.project-the-x-companion/credentials.json
//
// What it deliberately does NOT do:
//   • Read or upload `~/.claude/auth.json` — your Claude credentials never
//     leave your machine. We just spawn the CLI; the CLI uses its own creds.
//   • Make any outbound calls except to the configured dashboard.
//   • Persist any data from the dashboard locally beyond the credential.
import { WebSocket } from 'ws';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, copyFileSync, unlinkSync, readdirSync } from 'node:fs';
import { mkdir as mkdirP, copyFile as copyFileP, rm as rmP } from 'node:fs/promises';
import { homedir, hostname, platform } from 'node:os';
import { dirname, join, resolve as resolvePath, delimiter as PATH_DELIM } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const VERSION = '1.3.1';
const CRED_DIR  = join(homedir(), '.project-the-x-companion');
const CRED_FILE = join(CRED_DIR, 'credentials.json');
const PID_FILE  = join(CRED_DIR, 'companion.pid');

// Resolve `claude` to an absolute path. Why we can't just rely on PATH:
//   • macOS GUI apps (the Electron runner) inherit launchd's stripped
//     PATH — usually only /usr/bin:/bin:/usr/sbin:/sbin. Anything that
//     was added via ~/.zshrc (Homebrew, nvm, volta, Anthropic's installer,
//     npm global prefix) is invisible until a login shell sources rc files.
//   • Users on the same OS pick wildly different installers — npm global,
//     Homebrew, nvm-managed node, Volta, Bun, the curl-bash native
//     installer at ~/.local/bin, or the legacy ~/.claude/local layout.
//
// Resolution order (first hit wins):
//   1. $CLAUDE_BIN override — lets power users force a specific build
//   2. `which claude` against the current PATH (cheap; works for terminal launches)
//   3. The user's login shell — `$SHELL -ilc 'command -v claude'`. Sources
//      rc files so we pick up whatever the user's actual setup uses.
//      Highest-signal fix for macOS GUI launches.
//   4. A walk of every common install dir, including nvm/fnm version folders.
function _existsOrNull(p) {
  if (!p) return null;
  try { return existsSync(p) ? p : null; } catch { return null; }
}

function resolveClaudeBin() {
  const isWin = platform() === 'win32';
  const home  = homedir();
  const exeNames = isWin ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude'];

  const tried = [];
  const record = (label, p) => { if (p) tried.push(`${label}: ${p}`); return p; };

  // 1) Explicit override
  const override = _existsOrNull(process.env.CLAUDE_BIN);
  if (override) return { path: override, tried: [`$CLAUDE_BIN: ${process.env.CLAUDE_BIN}`] };
  if (process.env.CLAUDE_BIN) tried.push(`$CLAUDE_BIN (missing): ${process.env.CLAUDE_BIN}`);

  // 2) Current-PATH probe
  try {
    const probe = isWin ? 'where' : 'which';
    const r = spawnSync(probe, ['claude'], { encoding: 'utf8' });
    if (r.status === 0) {
      const first = String(r.stdout || '').trim().split(/\r?\n/)[0];
      const hit = _existsOrNull(first);
      tried.push(`${probe} claude (process PATH): ${first || '—'}`);
      if (hit) return { path: hit, tried };
    } else {
      tried.push(`${probe} claude (process PATH): not found`);
    }
  } catch (e) {
    tried.push(`which/where probe failed: ${e.message}`);
  }

  // 3) Login-shell PATH probe — most reliable on macOS GUI launches because
  //    launchd doesn't source ~/.zshrc, so PATH at app boot is the bare
  //    /usr/bin:/bin:/usr/sbin:/sbin. -ilc forces an interactive login
  //    shell that sources the user's rc files before running our command.
  if (!isWin) {
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const r = spawnSync(shell, ['-ilc', 'command -v claude || true'], {
        encoding: 'utf8', timeout: 5000
      });
      const lines = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      const hit = _existsOrNull(last);
      tried.push(`$SHELL -ilc 'command -v claude': ${last || '—'}`);
      if (hit) return { path: hit, tried };
    } catch (e) {
      tried.push(`login-shell probe failed: ${e.message}`);
    }
  }

  // 4) Hardcoded candidate directories
  const candidateDirs = isWin
    ? [
        process.env.APPDATA ? join(process.env.APPDATA, 'npm') : null,
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'claude') : null,
        process.env.ProgramFiles ? join(process.env.ProgramFiles, 'nodejs') : null,
        join(home, 'AppData', 'Roaming', 'npm'),
        join(home, '.local', 'bin'),
        join(home, '.bun', 'bin')
      ]
    : [
        join(home, '.claude', 'local'),
        join(home, '.local', 'bin'),
        join(home, '.bun', 'bin'),
        join(home, '.volta', 'bin'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/usr/bin',
        join(home, '.npm-global', 'bin'),
        join(home, '.yarn', 'bin')
      ];

  // Enumerate node version managers' per-version bin dirs (nvm + fnm).
  // claude installed via `npm i -g` lives inside whichever version was
  // active at install time — and that version dir is invisible to a
  // stripped-PATH GUI process.
  if (!isWin) {
    try {
      const nvmDir = process.env.NVM_DIR || join(home, '.nvm');
      const versionsDir = join(nvmDir, 'versions', 'node');
      if (existsSync(versionsDir)) {
        for (const v of readdirSync(versionsDir)) candidateDirs.push(join(versionsDir, v, 'bin'));
      }
    } catch {}
    try {
      const fnmDir = process.env.FNM_DIR || join(home, '.fnm');
      const versionsDir = join(fnmDir, 'node-versions');
      if (existsSync(versionsDir)) {
        for (const v of readdirSync(versionsDir)) candidateDirs.push(join(versionsDir, v, 'installation', 'bin'));
      }
    } catch {}
    // asdf
    try {
      const asdfDir = process.env.ASDF_DATA_DIR || join(home, '.asdf');
      const installs = join(asdfDir, 'installs', 'nodejs');
      if (existsSync(installs)) {
        for (const v of readdirSync(installs)) candidateDirs.push(join(installs, v, 'bin'));
      }
    } catch {}
  }

  for (const dir of candidateDirs.filter(Boolean)) {
    for (const exe of exeNames) {
      const hit = _existsOrNull(join(dir, exe));
      if (hit) {
        tried.push(`scan: ${join(dir, exe)} ✓`);
        return { path: hit, tried };
      }
    }
  }

  tried.push(`scanned ${candidateDirs.filter(Boolean).length} dirs, no claude binary in any of them`);
  return { path: null, tried };
}

const _claudeResolved = resolveClaudeBin();
const CLAUDE_BIN      = _claudeResolved.path || 'claude';
const CLAUDE_TRIED    = _claudeResolved.tried;
const CLAUDE_DIR      = _claudeResolved.path ? dirname(_claudeResolved.path) : null;

// Build an enriched PATH for every claude spawn so the binary can find its
// own subprocess dependencies (ripgrep, bash, etc.) even when the parent
// process inherited a stripped launchd / Task Scheduler PATH.
function _spawnPath() {
  const extra = [
    CLAUDE_DIR,
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin'
  ].filter(Boolean);
  const cur = (process.env.PATH || '').split(PATH_DELIM).filter(Boolean);
  const merged = [...new Set([...extra, ...cur])];
  return merged.join(PATH_DELIM);
}

// ---------- Single-instance lockfile ----------
// The companion is designed for one-per-machine: it spawns the local `claude`
// CLI to serve AI jobs for the user. Two instances would race over jobs and
// duplicate Claude API spend. We enforce this with a PID file in CRED_DIR.
//
// On boot: read companion.pid → if the recorded PID is alive (signal-0 probe),
// log and exit cleanly. Otherwise overwrite with our own PID. On graceful
// shutdown we unlink the file; if the process dies hard, the next start will
// see a stale PID (signal-0 throws ESRCH) and reclaim the lock.

/** Returns true if a process with the given PID is currently alive. We use
 *  `process.kill(pid, 0)` which doesn't actually send a signal — it just
 *  performs the permission/existence check the kernel would do before
 *  delivering one. ESRCH = no such process; EPERM = it exists but we can't
 *  signal it (still counts as alive). */
function _isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/** Acquire the single-instance lock or exit cleanly. Idempotent — safe to
 *  call multiple times (no-op after the first acquisition). */
function ensureSingleInstance() {
  if (globalThis.__companionLockAcquired) return;
  try { mkdirSync(CRED_DIR, { recursive: true }); } catch {}

  if (existsSync(PID_FILE)) {
    let existing = NaN;
    try { existing = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10); } catch {}
    if (Number.isInteger(existing) && existing !== process.pid && _isPidAlive(existing)) {
      console.log(`[companion] another instance is already running (pid ${existing}) — exiting.`);
      console.log(`[companion] use --status to inspect it, or --uninstall to remove the daemon.`);
      process.exit(0);
    }
    // Stale lock from a hard crash — drop it.
  }

  try { writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 }); }
  catch (e) { console.error(`[companion] could not write PID file ${PID_FILE}: ${e.message}`); }

  globalThis.__companionLockAcquired = true;

  // Release the lock on every exit path we can hook. We only unlink if the
  // file still holds *our* PID — never clobber a successor's lock.
  const release = () => {
    try {
      if (!existsSync(PID_FILE)) return;
      const cur = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (cur === process.pid) unlinkSync(PID_FILE);
    } catch {}
  };
  process.on('exit', release);
  process.on('SIGINT',  () => { release(); });
  process.on('SIGTERM', () => { release(); });
  process.on('SIGHUP',  () => { release(); });
  process.on('uncaughtException', (e) => { try { release(); } catch {} console.error(e); process.exit(1); });
}

// ---------- CLI parsing ----------
function parseArgs(argv) {
  const out = { dashboard: null, pair: null, token: null, help: false, version: false, install: false, uninstall: false, reinstall: false, status: false };
  for (const a of argv.slice(2)) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-v') out.version = true;
    else if (a === '--install')       out.install   = true;
    else if (a === '--uninstall')     out.uninstall = true;
    else if (a === '--reinstall')     out.reinstall = true;
    else if (a === '--status')        out.status    = true;
    else if (a.startsWith('--dashboard=')) out.dashboard = a.slice(12);
    else if (a.startsWith('--pair='))      out.pair      = a.slice(7).toUpperCase();
    else if (a.startsWith('--token='))     out.token     = a.slice(8);
  }
  return out;
}

function printHelp() {
  console.log(`Project THE X · Companion v${VERSION}

Usage:
  # First-time setup — pair, install as a background service, start it:
  npx <dashboard>/companion.tgz --dashboard=<URL> --pair=<CODE> --install

  # Foreground mode (terminal must stay open):
  npx <dashboard>/companion.tgz --dashboard=<URL> --pair=<CODE>

  # Subsequent runs (uses saved credentials):
  npx <dashboard>/companion.tgz

Options:
  --dashboard=URL    The dashboard URL (only needed for first pair).
  --pair=CODE        8-character pairing code from Settings → AI Runner.
  --install          Install as a background service that starts on login.
                     Uses launchd on macOS, systemd --user on Linux,
                     Task Scheduler on Windows.
  --reinstall        Uninstall + reinstall (use after dashboard URL change).
  --uninstall        Stop + remove the background service. Credentials are
                     kept; pass --uninstall twice to also wipe them.
  --status           Print the daemon's running state and exit.
  --token=JWT        Direct token (advanced; usually --pair handles it).
  --version          Print version and exit.
  --help             This screen.

What it does:
  Spawns 'claude -p' on your machine when the dashboard asks for AI work.
  Your Claude subscription pays for it. No credentials leave your machine.
`);
}

// ---------- Self-install (background daemon) ----------
// Installs a copy of the companion under ~/.project-the-x-companion/dist/
// and registers a per-user service that auto-starts on login. Three OS paths,
// no admin / sudo required for any of them.
const INSTALL_DIR = join(homedir(), '.project-the-x-companion');
const DIST_DIR    = join(INSTALL_DIR, 'dist');
const LAUNCHD_PLIST = join(homedir(), 'Library', 'LaunchAgents', 'com.projectthex.companion.plist');
const SYSTEMD_UNIT  = join(homedir(), '.config', 'systemd', 'user', 'projectthex-companion.service');
const TASK_NAME     = 'ProjectTheXCompanion';

function nodePath() { return process.execPath; }

/** Resolve the absolute path of an executable on PATH. launchd / systemd
 *  / Task Scheduler all run with sparse default PATHs that often don't
 *  include npm globals or homebrew, so we hard-code the resolved path
 *  into the daemon's ProgramArguments + EnvironmentVariables. */
function which(cmd) {
  const probe = platform() === 'win32' ? 'where' : 'which';
  const r = spawnSync(probe, [cmd], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const first = String(r.stdout || '').trim().split('\n')[0];
  return first || null;
}

/** Build the PATH string the daemon should use. Combines the dirs of node
 *  + claude + the standard system bins so subprocess spawns Just Work. */
function daemonPath(extra = []) {
  const dirs = new Set([
    dirname(nodePath()),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ]);
  for (const e of extra) if (e) dirs.add(e);
  return [...dirs].join(':');
}

async function copyDistFiles() {
  // The companion's source files live next to this script. Copy the ones
  // the daemon needs into ~/.project-the-x-companion/dist/.
  const here = dirname(fileURLToPath(import.meta.url));
  await rmP(DIST_DIR, { recursive: true, force: true });
  await mkdirP(DIST_DIR, { recursive: true });
  for (const f of ['companion.js', 'package.json', 'README.md']) {
    const src = join(here, f);
    if (existsSync(src)) await copyFileP(src, join(DIST_DIR, f));
  }
}

async function npmInstallWs() {
  // Install the only runtime dep (ws) into the dist dir. Uses whatever npm
  // is on PATH — the user already has it because they got here via npx.
  await new Promise((res, rej) => {
    const child = spawn('npm', ['install', '--no-audit', '--no-fund', '--no-progress', '--loglevel=error'], {
      cwd: DIST_DIR, stdio: 'inherit'
    });
    child.on('error', rej);
    child.on('exit', (code) => code === 0 ? res() : rej(new Error(`npm install exit ${code}`)));
  });
}

function logPath(name) { return join(INSTALL_DIR, `${name}.log`); }

async function writeLaunchdPlist({ claudePath }) {
  await mkdirP(dirname(LAUNCHD_PLIST), { recursive: true });
  const claudeDir = claudePath ? dirname(claudePath) : '';
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>com.projectthex.companion</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath()}</string>
    <string>${join(DIST_DIR, 'companion.js')}</string>
  </array>
  <key>WorkingDirectory</key>  <string>${DIST_DIR}</string>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>         <true/>
  <key>ThrottleInterval</key>  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>       <string>${homedir()}</string>
    <key>PATH</key>       <string>${daemonPath([claudeDir])}</string>
    ${claudePath ? `<key>CLAUDE_BIN</key> <string>${claudePath}</string>` : ''}
  </dict>
  <key>StandardOutPath</key>   <string>${logPath('companion-out')}</string>
  <key>StandardErrorPath</key> <string>${logPath('companion-err')}</string>
</dict>
</plist>
`;
  writeFileSync(LAUNCHD_PLIST, plist);
}

async function writeSystemdUnit({ claudePath }) {
  await mkdirP(dirname(SYSTEMD_UNIT), { recursive: true });
  const claudeDir = claudePath ? dirname(claudePath) : '';
  const unit = `[Unit]
Description=Project THE X Companion
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodePath()} ${join(DIST_DIR, 'companion.js')}
WorkingDirectory=${DIST_DIR}
Restart=always
RestartSec=5
StandardOutput=append:${logPath('companion-out')}
StandardError=append:${logPath('companion-err')}
Environment=HOME=${homedir()}
Environment=PATH=${daemonPath([claudeDir])}
${claudePath ? `Environment=CLAUDE_BIN=${claudePath}` : ''}

[Install]
WantedBy=default.target
`;
  writeFileSync(SYSTEMD_UNIT, unit);
}

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  return r.status;
}

/** Returns the existing-installation marker for the current OS, or null if
 *  nothing is installed. Used to refuse a second --install and steer the
 *  user to --reinstall instead of stacking duplicate services. */
function detectExistingInstall() {
  const p = platform();
  if (p === 'darwin') {
    if (existsSync(LAUNCHD_PLIST)) return { kind: 'launchd', detail: LAUNCHD_PLIST };
    const r = spawnSync('launchctl', ['list', 'com.projectthex.companion'], { encoding: 'utf8' });
    if (r.status === 0) return { kind: 'launchd', detail: 'registered with launchctl' };
  } else if (p === 'linux') {
    if (existsSync(SYSTEMD_UNIT)) return { kind: 'systemd', detail: SYSTEMD_UNIT };
  } else if (p === 'win32') {
    const r = spawnSync('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST'], { encoding: 'utf8' });
    if (r.status === 0) return { kind: 'schtasks', detail: TASK_NAME };
  }
  return null;
}

async function installDaemon({ reinstall = false } = {}) {
  const existing = detectExistingInstall();
  if (existing && !reinstall) {
    throw new Error(
      `companion is already installed (${existing.kind}: ${existing.detail}).\n` +
      `   Use --reinstall to replace it, or --uninstall first if you want a clean removal.`
    );
  }
  const p = platform();
  // Resolve absolute paths once. The daemon environment is sparse on every
  // platform (launchd has minimal default PATH, systemd's Environment=
  // doesn't inherit the shell's PATH, schtasks doesn't either) so we hard-
  // code claude's location instead of hoping it's on PATH at boot time.
  // Use the same multi-strategy resolver the runtime uses (login shell,
  // known install dirs, nvm/fnm/asdf version dirs) so --install works on
  // machines where claude is on PATH only after sourcing ~/.zshrc.
  const claudePath = _claudeResolved.path;
  if (!claudePath) {
    const lines = CLAUDE_TRIED.map((t) => `       • ${t}`).join('\n');
    throw new Error(
      `'claude' CLI not found on this machine.\n   Searched:\n${lines}\n` +
      `   Install Claude Code from https://docs.anthropic.com/claude-code, then run 'claude login' before retrying --install.`
    );
  }
  console.log(`[companion] resolved claude → ${claudePath}`);
  console.log(`[companion] resolved node   → ${nodePath()}`);
  console.log(`[companion] copying companion files into ${DIST_DIR}…`);
  await copyDistFiles();
  console.log('[companion] installing dependency (ws)…');
  await npmInstallWs();

  if (p === 'darwin') {
    console.log('[companion] writing launchd plist + loading…');
    runSync('launchctl', ['unload', LAUNCHD_PLIST]);  // ignore if not loaded
    await writeLaunchdPlist({ claudePath });
    if (runSync('launchctl', ['load', LAUNCHD_PLIST]) !== 0) {
      throw new Error('launchctl load failed — check ' + LAUNCHD_PLIST);
    }
    await verifyDaemonStarted('launchd');
    console.log(`[companion] ✓ Installed as a launchd agent. Logs: ${logPath('companion-out')}`);
    return;
  }
  if (p === 'linux') {
    console.log('[companion] writing systemd unit + enabling…');
    await writeSystemdUnit({ claudePath });
    runSync('systemctl', ['--user', 'daemon-reload']);
    runSync('systemctl', ['--user', 'enable', '--now', 'projectthex-companion.service']);
    await verifyDaemonStarted('systemd');
    console.log(`[companion] ✓ Installed as a systemd --user service.`);
    console.log(`[companion]   To survive logout: sudo loginctl enable-linger ${process.env.USER}`);
    console.log(`[companion]   Logs: ${logPath('companion-out')}`);
    return;
  }
  if (p === 'win32') {
    console.log('[companion] registering Task Scheduler entry…');
    // Set CLAUDE_BIN via cmd /C so it's in the daemon's environment.
    const wrapper = `cmd /C "set CLAUDE_BIN=${claudePath}&& \\"${nodePath()}\\" \\"${join(DIST_DIR, 'companion.js')}\\""`;
    runSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);  // ignore if missing
    if (runSync('schtasks', ['/Create', '/TN', TASK_NAME, '/TR', wrapper, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F']) !== 0) {
      throw new Error('schtasks /Create failed');
    }
    runSync('schtasks', ['/Run', '/TN', TASK_NAME]);
    await verifyDaemonStarted('schtasks');
    console.log(`[companion] ✓ Installed as Task Scheduler task "${TASK_NAME}".`);
    return;
  }
  throw new Error(`Auto-install isn't supported on ${p} — set up a daemon manually using the docs.`);
}

/** Wait a few seconds, then check the daemon is actually still running.
 *  If it's not, dump the tail of its error log so the user has something
 *  actionable instead of a silent failure. */
async function verifyDaemonStarted(kind) {
  await new Promise((r) => setTimeout(r, 2500));
  let alive = false;
  if (kind === 'launchd') {
    const r = spawnSync('launchctl', ['list', 'com.projectthex.companion'], { encoding: 'utf8' });
    // launchctl list prints PID >= 0 if the agent is alive; "-" or non-zero status if not.
    alive = r.status === 0 && /"PID"\s*=\s*\d+/.test(r.stdout || '');
  } else if (kind === 'systemd') {
    const r = spawnSync('systemctl', ['--user', 'is-active', 'projectthex-companion.service'], { encoding: 'utf8' });
    alive = (r.stdout || '').trim() === 'active';
  } else if (kind === 'schtasks') {
    const r = spawnSync('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    alive = /Running|Ready/.test(r.stdout || '');
  }
  if (alive) return;

  // Surface the tail of the daemon's stderr so the user sees what went wrong.
  let tail = '';
  try {
    const err = readFileSync(logPath('companion-err'), 'utf8');
    tail = err.split('\n').slice(-30).join('\n');
  } catch {}
  const detail = tail ? `\n\nLast log lines:\n${tail}` : '\n\n(no error log produced — check launchd / systemd / Task Scheduler manually)';
  throw new Error(`Daemon failed to start within 2.5 seconds.${detail}`);
}

async function uninstallDaemon({ wipeCreds = false } = {}) {
  const p = platform();
  if (p === 'darwin') {
    runSync('launchctl', ['unload', LAUNCHD_PLIST]);
    if (existsSync(LAUNCHD_PLIST)) {
      try { (await import('node:fs/promises')).unlink(LAUNCHD_PLIST); } catch {}
    }
  } else if (p === 'linux') {
    runSync('systemctl', ['--user', 'disable', '--now', 'projectthex-companion.service']);
    if (existsSync(SYSTEMD_UNIT)) {
      try { (await import('node:fs/promises')).unlink(SYSTEMD_UNIT); } catch {}
      runSync('systemctl', ['--user', 'daemon-reload']);
    }
  } else if (p === 'win32') {
    runSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
  }
  await rmP(DIST_DIR, { recursive: true, force: true });
  if (wipeCreds) {
    await rmP(INSTALL_DIR, { recursive: true, force: true });
    console.log('[companion] ✓ Uninstalled + credentials wiped.');
  } else {
    console.log('[companion] ✓ Uninstalled. Saved credentials kept (pass --uninstall twice to wipe them).');
  }
}

async function statusDaemon() {
  const p = platform();
  if (p === 'darwin') {
    const r = spawnSync('launchctl', ['list', 'com.projectthex.companion'], { encoding: 'utf8' });
    if (r.status === 0) console.log('[companion] running (launchd)\n' + (r.stdout || '').slice(0, 400));
    else console.log('[companion] not registered with launchd');
  } else if (p === 'linux') {
    runSync('systemctl', ['--user', 'status', 'projectthex-companion.service']);
  } else if (p === 'win32') {
    runSync('schtasks', ['/Query', '/TN', TASK_NAME, '/V', '/FO', 'LIST']);
  } else {
    console.log(`Status check not supported on ${p}`);
  }
}

// ---------- Credentials ----------
function loadCreds() {
  try {
    if (!existsSync(CRED_FILE)) return null;
    const raw = readFileSync(CRED_FILE, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}
function saveCreds(creds) {
  try {
    mkdirSync(CRED_DIR, { recursive: true });
    writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
    try { chmodSync(CRED_FILE, 0o600); } catch {}
  } catch (e) {
    console.error('Could not save credentials:', e.message);
  }
}

// ---------- Pairing exchange ----------
async function exchangePairCode(dashboardUrl, code) {
  const url = new URL('/api/companion/pair', dashboardUrl).toString();
  const machineId = `${hostname()}-${platform()}-${randomUUID().slice(0, 8)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      machine: { id: machineId, hostname: hostname(), platform: platform(), version: VERSION }
    })
  }).catch((e) => { throw new Error(`pairing request failed: ${e.message}`); });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`pairing rejected (${r.status}): ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  if (!data.ok || !data.token) throw new Error(`pairing rejected: ${data.error || 'unknown'}`);
  return {
    dashboard: dashboardUrl,
    token: data.token,
    user: data.user || null,
    machine_id: machineId,
    paired_at: Date.now()
  };
}

// ---------- WebSocket connection ----------
function buildWsUrl(dashboard, token, machineId) {
  if (!dashboard) throw new Error('credentials.json is missing the dashboard URL (looked for `dashboard` and `dashboard_url`). Re-pair from the runner app or run --pair=<CODE> --dashboard=<URL>.');
  const u = new URL(dashboard);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws/companion';
  u.searchParams.set('token', token);
  u.searchParams.set('machine_id', machineId);
  u.searchParams.set('version', VERSION);
  return u.toString();
}

/** Normalise creds across the two pairing flows:
 *   • CLI pairing (--pair=...) writes  { dashboard, token, machine_id, … }
 *   • GUI pairing (Electron app)  writes { dashboard_url, token, user, paired_at, … }
 *
 *  Without this normaliser, a GUI-paired user trips 'Invalid URL' inside
 *  buildWsUrl because creds.dashboard is undefined. We also synthesise
 *  a stable machine_id when the GUI didn't write one — same shape the
 *  CLI's own pair flow uses (host + platform + short random). */
function normaliseCreds(c) {
  if (!c || typeof c !== 'object') return null;
  const dashboard = c.dashboard || c.dashboard_url || null;
  let machine_id  = c.machine_id || null;
  if (!machine_id) {
    machine_id = `${hostname()}-${platform()}-${randomUUID().slice(0, 8)}`;
  }
  return { ...c, dashboard, machine_id };
}

let ws = null;
let backoff = 500;
let serverIsRestarting = false;   // server told us it's bouncing — reconnect immediately
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 8_000;        // cap at 8s so a restart loop never strands us
const inflight = new Map(); // job_id → { child, killed }

function connect(creds) {
  const url = buildWsUrl(creds.dashboard, creds.token, creds.machine_id);
  console.log(`[companion] connecting to ${creds.dashboard}…`);
  ws = new WebSocket(url, { headers: { 'User-Agent': `project-the-x-companion/${VERSION}` } });

  ws.on('open', () => {
    console.log(`[companion] connected · machine ${creds.machine_id} · user ${creds.user?.email || '?'}`);
    backoff = BACKOFF_MIN;
    serverIsRestarting = false;
    safeSend({ type: 'hello', version: VERSION, hostname: hostname(), platform: platform() });
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'ai_request') return handleAiRequest(msg);
    if (msg.type === 'cancel')     return handleCancel(msg);
    if (msg.type === 'ping')       return safeSend({ type: 'pong', t: Date.now() });
    if (msg.type === 'server_restarting') {
      console.log('[companion] dashboard is restarting — will reconnect immediately when it returns');
      serverIsRestarting = true;
      backoff = BACKOFF_MIN;
      return;
    }
    if (msg.type === 'update_available') {
      // GUI runners get their updates from electron-updater (see
      // companion-app/main.js setupAutoUpdate) which pulls signed builds
      // from GitHub Releases, so printing a 'run npx --reinstall' nudge
      // to those users is misleading — they can't act on it and the
      // activity log fills up with a banner the actual update mechanism
      // is already handling silently. Detect Electron via
      // process.versions.electron and stay quiet there.
      if (process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === '1') return;
      // Standalone CLI runners (npx-installed daemon) still need the
      // human-readable upgrade hint. Suppress repeated prints within
      // the same hour so the activity log doesn't get spammed.
      const last = Number(globalThis.__lastUpdatePrint || 0);
      if (Date.now() - last < 60 * 60 * 1000) return;
      globalThis.__lastUpdatePrint = Date.now();
      const url = `${creds.dashboard.replace(/\/+$/, '')}${msg.reinstall_url || '/companion.tgz'}`;
      console.log('\n  ⚡ A newer companion is available.');
      console.log(`     Your version:  ${msg.your_version || VERSION}`);
      console.log(`     Latest:        ${msg.latest_version || '?'}`);
      console.log(`     To upgrade:    npx '${url}' --reinstall\n`);
      return;
    }
  });

  ws.on('close', (code, reason) => {
    // Abort every inflight claude subprocess. The dashboard has lost its
    // tracking of these jobs (server's inflightJobs map is per-process and
    // doesn't survive a restart), so finishing them just burns the user's
    // CPU + Claude quota on a result no one will receive. The dashboard
    // will dispatch a fresh request on the new connection.
    for (const [job_id, entry] of inflight.entries()) {
      try {
        entry.killed = true;
        entry.child.kill('SIGTERM');
        setTimeout(() => { try { entry.child.kill('SIGKILL'); } catch {} }, 1500);
        console.log(`[companion] aborting orphaned job ${job_id.slice(0, 8)} — server dropped the connection`);
      } catch {}
    }
    inflight.clear();
    // If the server told us it was restarting, retry fast (250ms) and don't
    // let backoff escalate. Otherwise normal exponential backoff.
    const delay = serverIsRestarting ? 250 : backoff;
    console.log(`[companion] disconnected (${code}) ${reason || ''} — reconnecting in ${(delay/1000).toFixed(2)}s`);
    setTimeout(() => connect(creds), delay);
    if (!serverIsRestarting) backoff = Math.min(Math.round(backoff * 1.5), BACKOFF_MAX);
  });
  ws.on('error', (e) => { /* surfaced via close */ });

  // Heartbeat — server kicks idle sockets; this keeps it alive.
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) safeSend({ type: 'ping', t: Date.now() });
  }, 30_000);
  ws.once('close', () => clearInterval(ping));
}

function safeSend(msg) {
  try { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); } catch {}
}

// ---------- AI execution ----------
function handleAiRequest(msg) {
  const { job_id, prompt, model, effort, thinking_tokens, schema, add_dirs, label, timeout_ms } = msg;
  if (!job_id || !prompt) return safeSend({ type: 'ai_response', job_id, ok: false, error: 'missing job_id or prompt' });

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model || 'claude-haiku-4-5-20251001',
    '--max-thinking-tokens', String(thinking_tokens ?? 0),
    '--permission-mode', 'bypassPermissions'
  ];
  // Same-task continuity. When the dashboard chains calls within one
  // orchestrator task (research → reference → architect → …), every call
  // after the first arrives with `resume_session_id` so the CLI re-loads
  // the prior turn's context. New task = no resume id = fresh session.
  if (msg.resume_session_id) {
    args.push('--resume', String(msg.resume_session_id));
  }
  if (effort && effort !== 'none' && effort !== 'off') args.splice(args.indexOf('--max-thinking-tokens'), 0, '--effort', effort);
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  // --add-dir paths come from the dashboard server (e.g. '/app',
  // '/app/assets/...'). Those exist on the Linux server but NOT on the
  // user's machine — passing them through made claude expand its working
  // set into directories that don't exist, which on macOS sometimes ends
  // with the OS prompting the user to grant Desktop / Documents access
  // because claude walks up looking for a real cwd. Filter to paths that
  // genuinely exist on this machine.
  for (const d of (Array.isArray(add_dirs) ? add_dirs : [])) {
    if (typeof d !== 'string' || !d) continue;
    try { if (!existsSync(d)) continue; } catch { continue; }
    args.push('--add-dir', d);
  }
  if (msg.system_prompt) args.push('--append-system-prompt', msg.system_prompt);

  console.log(`[companion] AI request ${job_id.slice(0, 8)} · ${label || 'task'} · ${args[args.indexOf('--model') + 1]}`);

  const timeoutMs = Number(timeout_ms) || 600_000;
  // cwd = CRED_DIR forces claude to start inside ~/.project-the-x-companion/
  // (our own sandboxed directory) instead of inheriting the Electron app's
  // cwd, which on macOS GUI launches is `/`. When claude starts at `/` it
  // walks the filesystem looking for project markers (.git, package.json)
  // and crosses into ~/Desktop / ~/Documents / ~/Downloads — each of
  // those triggers a macOS TCC prompt ("Allow X to access Desktop"). By
  // anchoring claude inside our own directory we never touch user-protected
  // folders, and the prompts stop.
  const child = spawn(CLAUDE_BIN, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd:   CRED_DIR,
    env:   { ...process.env, PATH: _spawnPath() }
  });
  inflight.set(job_id, { child, killed: false });

  let stdout = '';
  let stderr = '';
  let buf = '';
  // Capture the CLI's session id as we see it stream by — first the system
  // init event, finally the result event. We report it back in ai_response
  // so the dashboard can chain the next call with --resume <id>.
  let capturedSessionId = null;
  const killTimer = setTimeout(() => {
    const e = inflight.get(job_id);
    if (e) { e.killed = true; try { child.kill('SIGKILL'); } catch {} }
  }, timeoutMs);

  child.stdout.on('data', (chunk) => {
    const s = chunk.toString('utf8');
    stdout += s;
    buf += s;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      // Forward each stream-json event so the dashboard can show progress.
      try {
        const ev = JSON.parse(line);
        if (ev?.session_id && !capturedSessionId) capturedSessionId = ev.session_id;
        safeSend({ type: 'ai_event', job_id, event: ev });
      } catch { /* skip non-json lines */ }
    }
  });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });

  child.on('close', (code) => {
    clearTimeout(killTimer);
    const entry = inflight.get(job_id);
    inflight.delete(job_id);
    if (entry?.killed) {
      return safeSend({ type: 'ai_response', job_id, ok: false, error: `timeout (${timeoutMs}ms)` });
    }
    if (code !== 0) {
      const wasCancelled = code === null || code === 137 || code === 143;
      console.log(`[companion] AI request done · ${job_id.slice(0, 8)} · ${wasCancelled ? 'cancelled' : 'failed'} (exit ${code})`);
      return safeSend({
        type: 'ai_response', job_id,
        ok: false,
        session_id: capturedSessionId,
        error: wasCancelled ? 'cancelled' : `claude exit ${code}: ${stderr.slice(-300)}`
      });
    }
    console.log(`[companion] AI request done · ${job_id.slice(0, 8)} · ok`);
    safeSend({ type: 'ai_response', job_id, ok: true, raw: stdout, session_id: capturedSessionId });
  });

  child.on('error', (e) => {
    clearTimeout(killTimer);
    inflight.delete(job_id);
    const hint = e.code === 'ENOENT'
      ? `claude CLI not found. Install it (https://docs.anthropic.com/claude-code) and run 'claude login' first.`
      : e.message;
    safeSend({ type: 'ai_response', job_id, ok: false, error: hint });
  });

  child.stdin.write(prompt);
  child.stdin.end();
}

function handleCancel(msg) {
  const e = inflight.get(msg.job_id);
  if (!e) return;
  e.killed = true;
  try { e.child.kill('SIGTERM'); setTimeout(() => { try { e.child.kill('SIGKILL'); } catch {} }, 1500); } catch {}
}

// ---------- Boot ----------
// Track previous --uninstall calls so a second call wipes credentials too.
let _uninstallSeen = 0;

async function main() {
  const args = parseArgs(process.argv);
  if (args.help)    return printHelp();
  if (args.version) return console.log(VERSION);
  if (args.status)  return statusDaemon();

  // ---- Uninstall mode -------------------------------------------------
  if (args.uninstall) {
    _uninstallSeen++;
    await uninstallDaemon({ wipeCreds: _uninstallSeen >= 2 });
    return;
  }

  // Verify the claude CLI is installed up-front so users see a clear error
  // before any pairing or websocket dance. Uses the resolver's pre-computed
  // path so a `claude` that exists in the user's login-shell PATH (but not
  // launchd's stripped PATH) still satisfies the probe.
  if (_claudeResolved.path) {
    console.log(`[companion] using claude at ${_claudeResolved.path}`);
  }
  await new Promise((resolve) => {
    const probe = spawn(CLAUDE_BIN, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: _spawnPath() }
    });
    probe.on('error', () => {
      console.error(`\n  ⚠  Could not find the 'claude' CLI on this machine.\n`);
      console.error(`     Searched:`);
      for (const t of CLAUDE_TRIED) console.error(`       • ${t}`);
      console.error(`\n     Install Claude Code from https://docs.anthropic.com/claude-code`);
      console.error(`     then run 'claude login' once. If it's already installed in an`);
      console.error(`     unusual location, set the CLAUDE_BIN env var to its absolute path`);
      console.error(`     and restart this companion.\n`);
      process.exit(1);
    });
    probe.on('close', () => resolve());
  });

  let creds = normaliseCreds(loadCreds());
  // If normaliseCreds had to synthesise a dashboard or machine_id from a
  // GUI-paired credentials.json, persist the canonical shape so we never
  // re-do the work and so future versions read the file cleanly.
  if (creds) {
    const original = loadCreds() || {};
    if (creds.dashboard !== original.dashboard || creds.machine_id !== original.machine_id) {
      try { saveCreds(creds); } catch {}
    }
  }

  // First-run pairing.
  if (args.pair) {
    if (!args.dashboard) {
      console.error('  ⚠  --pair requires --dashboard=<your dashboard URL>');
      process.exit(1);
    }
    console.log(`[companion] pairing with ${args.dashboard} using code ${args.pair}…`);
    try {
      creds = await exchangePairCode(args.dashboard, args.pair);
      saveCreds(creds);
      console.log(`[companion] paired ✓ as ${creds.user?.email || '?'} — credentials saved to ${CRED_FILE}`);
    } catch (e) {
      console.error(`[companion] pairing failed: ${e.message}`);
      process.exit(1);
    }
  }

  if (args.token && args.dashboard) {
    creds = { dashboard: args.dashboard, token: args.token, machine_id: `${hostname()}-${randomUUID().slice(0, 8)}`, paired_at: Date.now() };
    saveCreds(creds);
  }

  if (!creds) {
    console.error(`\n  No credentials yet. Run with --pair=<CODE> --dashboard=<URL> first:\n`);
    console.error(`    npx project-the-x-companion --dashboard=https://your.dashboard.com --pair=ABCD2345 --install\n`);
    console.error(`  Get your pairing code from Settings → AI Runner on the dashboard.\n`);
    process.exit(1);
  }

  // ---- Install mode: pair (above) then deploy as background daemon ---
  if (args.install || args.reinstall) {
    try {
      if (args.reinstall) {
        console.log('[companion] reinstalling — uninstalling any existing service first…');
        await uninstallDaemon({ wipeCreds: false });
      }
      await installDaemon({ reinstall: args.reinstall });
      console.log(`\n  ✓ Companion is running in the background — your terminal is free to close.\n`);
      console.log(`    Status:    npx ${creds.dashboard}/companion.tgz --status`);
      console.log(`    Uninstall: npx ${creds.dashboard}/companion.tgz --uninstall\n`);
      // Don't connect from this foreground process — the daemon is doing it.
      return;
    } catch (e) {
      console.error(`[companion] install failed: ${e.message}`);
      console.error(`[companion] falling back to foreground mode — keep this terminal open.`);
      // Fall through to foreground connect below so the user isn't stranded.
    }
  }

  // Acquire the single-instance lock right before we open the WS. We don't
  // do this any earlier — `--help`, `--version`, `--status`, `--install`,
  // and `--uninstall` are all read-only or one-shot and shouldn't be blocked
  // by an already-running daemon.
  ensureSingleInstance();

  connect(creds);

  // Graceful shutdown — kill any in-flight subprocesses, close the WS.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log('[companion] shutting down…');
      for (const e of inflight.values()) { try { e.child.kill('SIGTERM'); } catch {} }
      try { ws?.close(); } catch {}
      setTimeout(() => process.exit(0), 200);
    });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
