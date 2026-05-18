# Project THE X Runner

Branded desktop app that connects your dashboard to the local Claude CLI on your computer, so AI work runs on **your own** Claude subscription instead of going through a shared key.

Download the latest installer for your OS from the dashboard's **Settings → AI Runner** panel (auto-detects your platform), or grab one directly from this repo's [Releases page](https://github.com/Project-THE-X/Project-THE-X-runner/releases/latest):

| OS | Installer |
|---|---|
| macOS (Apple Silicon) | `Project-THE-X-Runner-mac-arm64.dmg` |
| macOS (Intel) | `Project-THE-X-Runner-mac-x64.dmg` |
| Windows 10 / 11 (installer) | `Project-THE-X-Runner-win-x64.exe` |
| Windows 10 / 11 (portable) | `Project-THE-X-Runner-Portable-win-x64.exe` |
| Linux (AppImage) | `Project-THE-X-Runner-linux-x64.AppImage` |
| Linux (.deb) | `Project-THE-X-Runner-linux-amd64.deb` |

After install:

1. Open the dashboard at **<https://project-the-x.com>** → Settings → AI Runner.
2. Click *Generate pairing code*.
3. Paste the code into the app, hit *Connect*.

You're done. The runner stays running in the system tray; closing the window minimises it. *Open at login* is one toggle inside the app if you want it to start silently with your machine.

## What this repo contains

- **`companion-app/`** — Electron shell (the branded window + system tray + IPC bridge).
- **`companion/`** — Headless Node.js CLI that does the actual WebSocket connection to the dashboard and spawns `claude -p` for every AI job.
- **`.github/workflows/build.yml`** — Builds the installers on every `runner-v*` tag push and attaches them to the matching GitHub Release.

The Electron shell spawns the CLI as a child process so the same logic powers both. Bug fixes in `companion/` ship to the GUI automatically.

The full platform source (campaigns, lead feedback, reports, alerts, etc.) lives in a separate private repo at <https://project-the-x.com> — this repo only ships the desktop runner.

## Run from source (dev)

```bash
cd companion-app
npm install
npm start
```

## Building installers locally

```bash
cd companion-app
npm install
npm run build:mac     # Mac DMG (run on macOS)
npm run build:win     # Windows installer (run on Windows)
npm run build:linux   # AppImage + .deb (run on Linux)
```

Outputs land in `companion-app/dist/`.

## Cutting a release

```bash
git tag runner-v1.0.0
git push origin runner-v1.0.0
```

CI builds for all three OSes in parallel and attaches the artefacts to the GitHub Release. The dashboard's `/downloads/runner/<filename>` proxy fetches from the latest release on first click and caches locally.

## Codesigning (optional)

Out of the box the installers are unsigned. On macOS users right-click → *Open* on first launch. On Windows SmartScreen warns until enough installs build the cert reputation. To sign:

- **macOS** — set repo secrets `MAC_CSC_LINK` (base64 of your Developer ID .p12) and `MAC_CSC_KEY_PASSWORD`.
- **Windows** — set `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`.

The workflow forwards these when present, falls back to unsigned otherwise.

## License

**Proprietary.** © 2026 Project THE X. All rights reserved.

This source repository is public only so the runner installer binaries can be delivered to authorised users. The source itself is **not** open-source — no permission is granted to copy, distribute, modify, fork, mirror, or re-publish it in any form. See [`LICENSE`](LICENSE) for the full terms.

For licensing enquiries: <support@project-the-x.com>.
