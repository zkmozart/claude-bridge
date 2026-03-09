# Claude Bridge Setup Guide

## Prerequisites

- **Node.js** >= 18
- **Claude Code CLI** installed and authenticated (`claude` command available)
- **Git** with a repository you want agents to work on
- **GitHub CLI** (`gh`) for automatic PR creation (optional)

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/YOUR_USERNAME/claude-bridge.git
cd claude-bridge
npm install

# 2. Configure
cp .env.example .env
# Edit .env — set BRIDGE_API_TOKEN and REPO_PATH

# 3. Update bridge.config.json
# Set "repoPath" to your target repository's absolute path

# 4. Start
npm start
# Or for development with auto-reload:
npm run dev

# 5. Verify
curl http://localhost:3100/health
# Open http://localhost:3100/dashboard in your browser
```

## Configuration

### Environment Variables (.env)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BRIDGE_API_TOKEN` | Yes | — | Bearer token for API authentication |
| `REPO_PATH` | No | from config | Absolute path to target git repo |
| `PORT` | No | 3100 | HTTP server port |
| `POLL_INTERVAL_MS` | No | 30000 | How often to check for new plans (ms) |
| `CLAUDE_CLI_PATH` | No | `claude` | Path to Claude Code binary |
| `CLAUDE_API_KEY` | No | — | Anthropic API key (if not using OAuth) |

### bridge.config.json

```json
{
  "repoPath": "/absolute/path/to/your/repo",
  "pollIntervalMs": 30000,
  "maxConcurrentAgents": 5,
  "defaultMaxTurns": 50,
  "plansDir": "plans",
  "resultsDir": "results",
  "stateFile": "state.json",
  "agents": {
    "backend-dev": {
      "description": "Backend API development",
      "scope": ["backend/**"]
    }
  }
}
```

The `agents` map defines known agent roles. Plans can reference any role name — unknown roles get a generic prompt but still work.

## Authentication Setup

Claude Bridge supports two auth methods for spawning agents:

### OAuth (Recommended)
1. Run `claude` interactively once to complete OAuth login
2. Credentials are saved to `~/.claude/.credentials.json`
3. The daemon reads these automatically — no env vars needed
4. Tokens auto-refresh; no manual rotation required

### API Key
1. Set `CLAUDE_API_KEY=sk-ant-...` in `.env`
2. The daemon passes this to spawned agents
3. You must manually rotate when the key expires

The daemon runs a pre-flight auth check on startup and before each agent spawn.

## Running as a System Service

### Linux (systemd)

Create `/etc/systemd/system/claude-bridge.service`:

```ini
[Unit]
Description=Claude Bridge Daemon
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/path/to/claude-bridge
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

# Watchdog (optional — daemon pings systemd every 2min)
WatchdogSec=300

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable claude-bridge
sudo systemctl start claude-bridge
sudo journalctl -u claude-bridge -f  # view logs
```

### WSL2

If running in WSL2 with systemd enabled:

1. Install the service as above
2. Use `scripts/autostart.ps1` to boot WSL on Windows login
3. Use `scripts/portproxy.ps1` to forward traffic from Tailscale/VPN to WSL

Register the autostart script:
```powershell
schtasks /create /tn "Claude Bridge WSL Boot" /tr "powershell -WindowStyle Hidden -File 'C:\path\to\claude-bridge\scripts\autostart.ps1'" /sc onlogon /rl highest
```

### macOS (launchd)

Create `~/Library/LaunchAgents/com.claude-bridge.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-bridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/claude-bridge/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/claude-bridge</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.claude-bridge.plist
```

## Remote Access (Optional)

To access the dashboard remotely via Tailscale:

1. Install Tailscale on your machine
2. Set `BRIDGE_LISTEN_IP` to your Tailscale IP in `.env`
3. Run `scripts/portproxy.ps1` as Administrator (WSL2 only)
4. Access `http://YOUR_TAILSCALE_IP:3100/dashboard`

## Creating Your First Plan

Drop a markdown file in `plans/pending/`:

```bash
cat > plans/pending/hello-world.md << 'EOF'
---
id: "hello-world"
title: "Add hello world endpoint"
created: "2026-03-09T00:00:00Z"
created_by: "developer"
priority: "low"
branch: "feature/hello-world"
team:
  - agent: "backend-dev"
    scope: ["**"]
---

Add a GET /api/hello endpoint that returns { message: "Hello, World!" }.
Create it in a new file at backend/routes/hello.js.
EOF
```

Or submit via API:

```bash
curl -X POST http://localhost:3100/api/plans/submit \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Add hello world endpoint",
    "priority": "low",
    "branch": "feature/hello-world",
    "team": "backend-dev",
    "body": "Add a GET /api/hello endpoint that returns { message: \"Hello, World!\" }."
  }'
```

The daemon will detect the plan, spawn a Claude Code agent, and create a PR when done.

## Troubleshooting

### Auth check fails on startup
- Run `claude` interactively to refresh OAuth tokens
- Or set `CLAUDE_API_KEY` in `.env`
- Check that `ANTHROPIC_API_KEY` is NOT set in your shell (it overrides OAuth)

### Agent hangs with 0 turns
- Normal during startup — the agent loads CLAUDE.md context before beginning work
- If stuck for 5+ minutes, check `journalctl` or the dashboard live log

### Plans not being picked up
- Verify `REPO_PATH` points to the correct directory
- Check that `plans/pending/` exists and contains `.md` files
- Look at `state.json` — plans are tracked permanently once processed
- To retry: delete the plan entry from `state.json` and move the file back to `pending/`

### PR creation fails
- Install `gh` CLI: `brew install gh` or `sudo apt install gh`
- Run `gh auth login` to authenticate
- Verify the agent branch was pushed: `git branch -r | grep agent/`
