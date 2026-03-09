# Claude Bridge

Multi-agent orchestration daemon for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Drop a plan file, get a pull request.

Claude Bridge watches a directory for plan files (markdown with YAML frontmatter), spawns Claude Code agents on isolated git worktrees, and creates PRs when they finish. It handles DAG-based execution ordering, concurrent agent limits, safety-net auto-commits, and provides a real-time SSE dashboard.

## How It Works

```
                        +------------------+
  Plan File (.md)  ---> |  Claude Bridge   | ---> PR on GitHub
  or POST /api    ---> |    (daemon)      | ---> Result file
                        +------------------+
                              |    |    |
                         spawn agents on
                         git worktrees
                              |    |    |
                        +-----+  +-----+  +------+
                        | L0  |  | L1  |  | L2   |
                        |back |  |front|  |tests |
                        +-----+  +-----+  +------+
                        (parallel) (waits)  (waits)
```

1. You write a **plan file** — a markdown document with YAML frontmatter describing what to build, which agents to use, and their dependencies.
2. Drop it in `plans/pending/` or submit via the REST API.
3. The daemon picks it up, creates git worktrees for each agent, and spawns Claude Code CLI processes.
4. Agents with `depends_on` wait for earlier agents to finish (DAG execution layers).
5. When done, the daemon auto-creates a PR via `gh` and writes a result report.

## Quick Start

```bash
git clone https://github.com/YOUR_USERNAME/claude-bridge.git
cd claude-bridge
npm install
cp .env.example .env
# Edit .env: set BRIDGE_API_TOKEN, REPO_PATH
npm start
```

Open `http://localhost:3100/dashboard` to see the real-time ops view.

## Plan File Format

Plans are markdown files with YAML frontmatter:

```yaml
---
id: "add-search-feature"
title: "Add search API endpoint"
created: "2026-03-09T00:00:00Z"
created_by: "developer"
priority: "medium"
branch: "feature/search"
team:
  - agent: "backend-dev"
    scope: ["backend/**"]
  - agent: "frontend-dev"
    scope: ["frontend/**"]
    depends_on: ["backend-dev"]
---

## Objective

Build a search endpoint and wire it to the frontend...
```

The body (below the `---`) becomes the task instructions sent to each agent.

See `examples/` for complete plan examples:
- **[plan-single-agent.md](examples/plan-single-agent.md)** — Simple one-agent task
- **[plan-multi-agent.md](examples/plan-multi-agent.md)** — Multi-agent with dependencies and scopes
- **[plan-research.md](examples/plan-research.md)** — Research task (no code changes)

## Key Features

### DAG Execution
Agents declare `depends_on` to form a dependency graph. Claude Bridge computes execution layers — agents in the same layer run in parallel, while dependent layers wait.

### Git Worktree Isolation
Each agent gets its own git worktree, so multiple agents can edit files concurrently without conflicts. Worktrees are cleaned up after the plan completes.

### Safety Net
If an agent exits without committing, the daemon auto-commits and pushes any uncommitted changes. Work is never lost.

### Agent Scoping
Each agent can be restricted to specific file paths (`scope`) and blocked from editing certain files (`blocked_files`). The scope is injected into the agent's prompt.

### Real-Time Dashboard
Built-in SSE-powered dashboard at `/dashboard` shows:
- Active agents with turn counts and uptime
- Plan status (pending/in-progress/completed/failed)
- Live log stream
- Auth status

### REST API
Submit plans, list status, and cancel agents programmatically. See [docs/API.md](docs/API.md).

## Agent Roles

Default roles with prompt templates in `prompts/`:

| Role | Prompt File | Default Scope |
|------|------------|---------------|
| `backend-dev` | `prompts/backend-dev.md` | `backend/**`, `services/**` |
| `frontend-dev` | `prompts/frontend-dev.md` | `frontend/**`, `src/**` |
| `ai-engineer` | `prompts/ai-engineer.md` | `ai/**`, `services/**` |
| `qa-tester` | `prompts/qa-tester.md` | `tests/**` |
| `debug` | `prompts/debug.md` | `**` |

Add custom roles by creating a new `.md` file in `prompts/`. Plans can reference any role name — unknown roles get a generic fallback prompt.

## Configuration

### bridge.config.json

```json
{
  "repoPath": "/path/to/your/repo",
  "pollIntervalMs": 30000,
  "maxConcurrentAgents": 5,
  "defaultMaxTurns": 50,
  "plansDir": "plans",
  "resultsDir": "results",
  "stateFile": "state.json"
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_API_TOKEN` | — | Bearer token for API auth (required) |
| `REPO_PATH` | from config | Target git repository path |
| `PORT` | 3100 | HTTP server port |
| `CLAUDE_CLI_PATH` | `claude` | Path to Claude Code CLI |
| `CLAUDE_API_KEY` | — | API key (if not using OAuth) |

## Project Structure

```
claude-bridge/
├── server.js              # Main daemon server
├── bridge.config.json     # Configuration
├── lib/
│   ├── agent-spawner.js   # Claude Code CLI process management
│   ├── auth-middleware.js  # Bearer token auth
│   ├── event-bus.js       # SSE event broadcasting
│   ├── plan-parser.js     # YAML frontmatter parsing + validation
│   ├── plan-watcher.js    # Filesystem polling for new plans
│   ├── result-writer.js   # Markdown result file generation
│   ├── state-manager.js   # Persistent plan tracking (state.json)
│   └── worktree-manager.js # Git worktree lifecycle
├── public/
│   └── dashboard.html     # Real-time ops dashboard
├── prompts/               # Agent role templates
├── scripts/               # Utility scripts (worktree, WSL, portproxy)
├── plans/                 # Plan lifecycle directories
│   ├── pending/           # New plans (daemon watches this)
│   ├── in-progress/       # Currently executing
│   ├── done/              # Successfully completed
│   └── failed/            # Failed plans
├── results/               # Agent output reports
├── examples/              # Example plan files
└── docs/                  # Setup guide and API reference
```

## Documentation

- **[docs/SETUP.md](docs/SETUP.md)** — Installation, systemd/launchd service, WSL2 setup, remote access
- **[docs/API.md](docs/API.md)** — REST API endpoint reference
- **[docs/PLAN-WRITING-GUIDE.md](docs/PLAN-WRITING-GUIDE.md)** — How to write effective plan files

## Requirements

- Node.js >= 18
- Claude Code CLI (`claude`) installed and authenticated
- Git
- GitHub CLI (`gh`) for automatic PR creation (optional)

## License

MIT
