# Project THE X · Companion

Tiny local AI runner. Connects your machine to your hosted Project THE X
dashboard so the dashboard can run Claude Code on your machine using your
own Claude subscription.

**Your Claude credentials never leave your machine.** This companion just
spawns the local `claude` CLI when the dashboard requests AI work; the CLI
authenticates with your account, the work runs locally, and only the
final output is streamed back to the dashboard.

## Prerequisites

1. **Node.js 20 or newer** — [download](https://nodejs.org)
2. **Claude Code CLI** — [install instructions](https://docs.anthropic.com/claude-code)
3. Run `claude login` once so the CLI knows your account

## Pairing & first run

1. In your dashboard, go to **Settings → AI Runner**, click **Generate pairing code** — copy the 8-character code.
2. On your machine, run:

```bash
npx project-the-x-companion --dashboard=https://your.dashboard.com --pair=ABCD2345
```

The first run pairs your machine; subsequent runs just need:

```bash
npx project-the-x-companion
```

Credentials are saved to `~/.project-the-x-companion/credentials.json` (chmod 0600).

## Keep it running

The companion needs to be online for the dashboard's AI features to work. Options:

### macOS — launchd

```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.projectthex.companion.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>             <string>com.projectthex.companion</string>
    <key>ProgramArguments</key>  <array><string>/usr/local/bin/npx</string><string>project-the-x-companion</string></array>
    <key>RunAtLoad</key>         <true/>
    <key>KeepAlive</key>         <true/>
    <key>StandardOutPath</key>   <string>/tmp/projectthex-companion.log</string>
    <key>StandardErrorPath</key> <string>/tmp/projectthex-companion.err</string>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/com.projectthex.companion.plist
```

### Linux — systemd

```bash
sudo tee /etc/systemd/system/projectthex-companion.service <<EOF
[Unit]
Description=Project THE X Companion
After=network-online.target
[Service]
Type=simple
User=$USER
ExecStart=/usr/bin/npx project-the-x-companion
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now projectthex-companion
```

### Windows — Task Scheduler

Create a task that runs `npx project-the-x-companion` at logon, restart on failure.

## CLI flags

| Flag | Purpose |
|---|---|
| `--dashboard=URL` | Dashboard URL (only needed for first pair) |
| `--pair=CODE` | 8-character pairing code from Settings → AI Runner |
| `--token=JWT` | Direct token (advanced) |
| `--version` | Print version |
| `--help` | Print help |

## Privacy

- The companion makes outbound WebSocket connections only — no inbound port is opened.
- Only data sent to the dashboard: AI prompts the dashboard sent you, claude CLI stdout in response, plus heartbeat / pairing.
- Claude credentials at `~/.claude/` are never read or transmitted.
- One credential file is created at `~/.project-the-x-companion/credentials.json` (the dashboard auth token only).

## Troubleshooting

**`claude` not found** — install [Claude Code](https://docs.anthropic.com/claude-code) and ensure `claude --version` works in your shell.

**Pairing fails with 401** — the code expires after 10 minutes. Generate a fresh one in Settings → AI Runner.

**Stays "disconnected" in the dashboard** — verify the companion logs show "connected"; check that your firewall doesn't block outbound `wss://`.
