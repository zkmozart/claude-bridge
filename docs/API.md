# Claude Bridge API Reference

Base URL: `http://localhost:3100`

## Authentication

Protected endpoints require a Bearer token matching `BRIDGE_API_TOKEN` in `.env`:

```
Authorization: Bearer your-token-here
```

Unprotected endpoints: `/health`, `/dashboard`, `/api/events`, `/api/agents`, `/api/agents/cancel`, `/api/agents/cancel-all`

---

## Endpoints

### Health Check

```
GET /health
```

No authentication required.

**Response:**
```json
{
  "service": "claude-bridge",
  "status": "running",
  "uptime": 3600.5,
  "processedPlans": 12,
  "activeAgents": 2,
  "authOk": true,
  "timestamp": "2026-03-09T00:00:00.000Z"
}
```

---

### Bridge Status

```
GET /api/bridge/status
Authorization: Bearer <token>
```

**Response:**
```json
{
  "service": "claude-bridge",
  "config": {
    "repoPath": "/path/to/repo",
    "pollIntervalMs": 30000,
    "maxConcurrentAgents": 5
  },
  "state": {
    "processedPlans": { ... },
    "startedAt": "2026-03-09T00:00:00.000Z"
  },
  "activeAgents": 2,
  "timestamp": "2026-03-09T00:00:00.000Z"
}
```

---

### Submit Plan

```
POST /api/plans/submit
Authorization: Bearer <token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "title": "Add user search endpoint",
  "priority": "medium",
  "branch": "feature/user-search",
  "team": "backend-dev",
  "body": "## Objective\n\nAdd a GET /api/users/search endpoint...",
  "max_turns_per_agent": 50,
  "tags": ["feature", "backend"]
}
```

**Team formats (all valid):**
```json
"backend-dev"
["backend-dev", "frontend-dev"]
[{ "agent": "backend-dev", "scope": ["backend/**"], "depends_on": ["frontend-dev"] }]
```

**Response (201):**
```json
{
  "planId": "add-user-search-endpoint",
  "status": "queued",
  "path": "plans/pending/add-user-search-endpoint.md"
}
```

**Errors:**
- `400` — Missing required fields or validation failure
- `409` — Plan with same ID already exists

---

### List Plans

```
GET /api/plans
GET /api/plans?status=pending
Authorization: Bearer <token>
```

**Response:**
```json
{
  "plans": [
    { "id": "add-user-search", "status": "pending", "file": "add-user-search.md" },
    { "id": "fix-login-bug", "status": "completed", "processedAt": "2026-03-09T00:00:00.000Z" }
  ],
  "total": 2
}
```

---

### List Active Agents

```
GET /api/agents
```

No authentication required.

**Response:**
```json
{
  "agents": [
    {
      "key": "add-user-search/backend-dev",
      "planId": "add-user-search",
      "agent": "backend-dev",
      "pid": 12345,
      "startedAt": "2026-03-09T00:00:00.000Z",
      "turns": 15,
      "uptimeSeconds": 120
    }
  ]
}
```

---

### Cancel Agent

```
POST /api/agents/cancel
Content-Type: application/json
```

**Request Body (either format):**
```json
{ "key": "add-user-search/backend-dev" }
```
```json
{ "planId": "add-user-search", "agent": "backend-dev" }
```

**Response:**
```json
{ "status": "cancelled", "key": "add-user-search/backend-dev" }
```

---

### Cancel All Agents

```
POST /api/agents/cancel-all
```

**Response:**
```json
{ "status": "cancelled", "cancelled": 3, "results": [...] }
```

---

### SSE Event Stream

```
GET /api/events
```

No authentication required. Returns a Server-Sent Events stream.

**Events:**

| Event | Description |
|-------|-------------|
| `init` | Initial payload with buffered logs, plans, active agents |
| `log` | Structured log entry `{ level, tag, message, timestamp }` |
| `plan` | Plan lifecycle `{ action, planId, title, agents, status }` |
| `agent` | Agent lifecycle `{ action, planId, agent, turns, status }` |
| `status` | Daemon status snapshot (every 15s) |

**Agent actions:** `started`, `heartbeat`, `completed`, `failed`, `cancelled`

**Plan actions:** `queued`, `started`, `completed`, `partial`, `failed`

---

### Dashboard

```
GET /dashboard
```

Serves the built-in HTML dashboard with real-time SSE updates.

---

## Plan File Format

Plans are markdown files with YAML frontmatter:

```yaml
---
id: "my-plan"
title: "Human-readable title"
created: "2026-03-09T00:00:00Z"
created_by: "developer"
priority: "medium"          # critical | high | medium | low
branch: "feature/my-feature"
max_turns_per_agent: 50     # optional
tags: ["feature"]           # optional
team:
  - agent: "backend-dev"
    scope: ["backend/**"]
    blocked_files: ["backend/server.js"]   # optional
    depends_on: ["other-agent"]            # optional
---

## Task description in markdown

The agent receives this body as its task instructions.
```

**Required frontmatter:** `id`, `title`, `created`, `created_by`, `priority`, `branch`, `team`

**Priority values:** `critical`, `high`, `medium`, `low`
