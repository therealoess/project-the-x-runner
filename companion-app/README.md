# Project THE X Runner (desktop app)

Branded Mac / Windows / Linux desktop app that runs the Project THE X
"AI runner" in a friendly window — no terminal required.

The CLI version of the companion still ships (`/companion.tgz` from the
dashboard); this is the same companion logic wrapped in an Electron
shell so non-technical operators can install it like any other app,
pair it once, and forget about it.

## What it looks like

Single window with four states:

| State | UI |
|---|---|
| Unpaired | Paste-the-pairing-code form. Dashboard URL is prefilled. |
| Pairing  | Centered spinner + "Talking to your dashboard". |
| Connected | Green pill, key-value table (paired with / signed in as / jobs handled / last activity), open-at-login toggle, hide / restart / unpair buttons. |
| Offline  | Orange pill, "Lost connection — reconnecting" copy, manual reconnect button. |

Closing the window hides it to the system tray (macOS menu bar /
Windows notification area). Right-click the tray icon → **Quit** to
fully exit. The tray tooltip shows live connection status.

## Run from source (dev)

```bash
cd companion-app
npm install
npm start
```

`npm start` runs Electron against the sources in this directory. The
companion CLI it spawns lives at `../companion/companion.js`.

## Build installers

The installer build must happen on the **target OS** for proper
codesigning (Apple wants the build to happen on macOS to use your
Developer ID, Windows wants Authenticode on a Windows box). The
GitHub Actions workflow at `.github/workflows/companion-build.yml`
runs all three platforms on tag pushes.

Locally:

```bash
# On macOS
npm run build:mac      # → dist/Project THE X Runner-<v>.dmg + .zip

# On Windows
npm run build:win      # → dist/Project THE X Runner Setup <v>.exe (NSIS)
                       #    + dist/Project THE X Runner <v>.exe   (portable)

# On Linux
npm run build:linux    # → dist/Project THE X Runner-<v>.AppImage + .deb
```

Outputs land in `companion-app/dist/`. The Mac DMG is universal
(arm64 + x64). The Windows installer is 64-bit only.

## Codesigning (optional but recommended)

Out of the box the installers are unsigned. On macOS users will see
"unidentified developer" and need to right-click → Open. On Windows
SmartScreen will warn until enough installs build the cert reputation.

To sign properly:

* **macOS** — set the env vars `CSC_LINK` (path or base64 of your
  Developer ID .p12) and `CSC_KEY_PASSWORD` before `npm run build:mac`,
  then pass `--config.mac.notarize.appBundleId=com.projectthex.runner`
  with your `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`
  envs for notarisation.
* **Windows** — set `CSC_LINK` (path or base64 of your Authenticode
  .pfx) and `CSC_KEY_PASSWORD` before `npm run build:win`.

electron-builder handles the rest.

## How the pairing flow works

1. User opens the dashboard, signs in, goes to **Settings → AI Runner**.
2. Dashboard renders a fresh 10-minute pairing code via
   `POST /api/companion/code`.
3. User pastes the code into this app's pairing screen.
4. App POSTs to `/api/companion/pair` — receives a long-lived JWT.
5. JWT is saved to `~/.project-the-x-companion/credentials.json`.
6. App spawns the existing companion CLI (using Electron's bundled
   Node binary, via `process.execPath` + `ELECTRON_RUN_AS_NODE=1`).
7. CLI opens an outbound WebSocket to the dashboard, authenticated
   with the JWT.
8. Dashboard routes AI jobs through the WS; CLI spawns `claude -p`
   locally (using the user's own Claude subscription).

No firewall holes are needed — every connection is outbound from the
user's machine.

## Distribution

Until a CDN-backed download link is in place, the easiest distribution
is GitHub Releases: tag a commit, the CI builds for all three OSes,
the dashboard's **Settings → AI Runner** panel links to the latest
release artifacts.
