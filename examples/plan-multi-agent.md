---
id: "notification-system"
title: "Add in-app notification system"
created: "2026-03-09T00:00:00Z"
created_by: "tech-lead"
priority: "high"
branch: "feature/notifications"
max_turns_per_agent: 40
tags: ["feature", "full-stack"]
team:
  - agent: "backend-dev"
    scope: ["backend/**"]
    blocked_files: ["backend/server.js"]
  - agent: "frontend-dev"
    scope: ["frontend/**", "src/**"]
    depends_on: ["backend-dev"]
  - agent: "qa-tester"
    scope: ["tests/**"]
    depends_on: ["backend-dev", "frontend-dev"]
---

## Objective

Build an in-app notification system with real-time delivery via SSE.

## Backend (backend-dev)

1. Create `notifications` table: `id, user_id, type, title, body, read, created_at`
2. Add migration in `backend/migrations/`
3. Endpoints:
   - `GET /api/notifications` — list for current user (paginated)
   - `PUT /api/notifications/:id/read` — mark as read
   - `POST /api/notifications/read-all` — mark all as read
   - `GET /api/notifications/stream` — SSE endpoint for real-time delivery
4. Add helper: `createNotification(userId, type, title, body)`

## Frontend (frontend-dev)

1. Add notification bell icon to header (badge with unread count)
2. Dropdown panel showing recent notifications
3. Connect to SSE stream for real-time updates
4. Mark as read on click
5. "Mark all read" button

## Tests (qa-tester)

1. API tests for all notification endpoints
2. Test SSE connection and event delivery
3. Test read/unread state transitions
4. Test pagination
