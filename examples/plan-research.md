---
id: "research-auth-options"
title: "Research authentication upgrade options"
created: "2026-03-09T00:00:00Z"
created_by: "developer"
priority: "low"
branch: "research/auth-upgrade"
max_turns_per_agent: 30
tags: ["research"]
team:
  - agent: "debug"
    scope: ["**"]
---

## Objective

Research and document options for upgrading the authentication system
from simple JWT to support OAuth2/OIDC providers (Google, GitHub, Microsoft).

## Deliverables

Write a research report as `docs/auth-upgrade-research.md` covering:

1. **Current State** — Document the existing JWT auth flow
   - Read `backend/middleware/auth.js` and related files
   - Map the token lifecycle (creation, validation, refresh)

2. **Options Analysis** — Compare at least 3 approaches:
   - Passport.js with OAuth2 strategies
   - Auth0 / Clerk / other hosted auth
   - Custom OAuth2 implementation
   - For each: pros, cons, migration effort, cost

3. **Recommendation** — Pick one approach with rationale

4. **Migration Plan** — Step-by-step plan that doesn't break existing JWT users

## Notes

- This is a research task — do NOT modify any source code
- The output is a markdown document, not code changes
- Focus on practical implementation details, not theoretical comparisons
