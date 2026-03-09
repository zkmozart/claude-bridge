---
id: "add-user-search-endpoint"
title: "Add user search API endpoint"
created: "2026-03-09T00:00:00Z"
created_by: "developer"
priority: "medium"
branch: "feature/user-search"
team:
  - agent: "backend-dev"
    scope: ["backend/**"]
---

## Objective

Add a `GET /api/users/search` endpoint that accepts a `q` query parameter
and returns matching users by name or email.

## Requirements

1. Add route in `backend/routes/users.js`
2. Query should use ILIKE for partial matching
3. Limit results to 20
4. Require authentication (use existing auth middleware)
5. Return `{ users: [{ id, name, email }], total: number }`

## Acceptance Criteria

- `GET /api/users/search?q=john` returns matching users
- Empty `q` returns 400 error
- Results are paginated (default limit 20)
- Existing tests still pass
