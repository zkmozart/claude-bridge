# Plan Writing Guide

How to write effective plan files that produce high-quality agent output.

## Prompt Structure

All plan task descriptions benefit from this structure:

```xml
<task>
  <objective>[One sentence: what OUTCOME, not activity]</objective>
  <context>
    <required>[Files/info the agent MUST read first]</required>
    <optional>[Nice-to-have context]</optional>
  </context>
  <constraints>
    <do_not>[What NOT to touch/change]</do_not>
    <must>[Hard requirements]</must>
  </constraints>
  <execution_plan>
    <phase name="analysis">[What to examine]</phase>
    <phase name="planning">[Plan to propose]</phase>
    <phase name="implementation">[How to execute]</phase>
    <phase name="verification">[How to confirm done]</phase>
  </execution_plan>
  <acceptance_criteria>
    <criterion>[Testable condition]</criterion>
  </acceptance_criteria>
  <escalation_rules>
    <on_failure>[Recovery steps]</on_failure>
    <on_ambiguity>[When to pause and commit what you have]</on_ambiguity>
    <max_iterations>[Number]</max_iterations>
  </escalation_rules>
</task>
```

You don't need to use XML literally — the structure matters more than the format. Markdown headers work just as well. The key is covering all six sections.

## Design Principles

- **Outcome-focused** — Define success, not process. "Users can search by email" not "add a search function"
- **Constraint-driven** — Encode what NOT to do explicitly. Agents are eager to help and will over-engineer without guardrails
- **Specific context** — "Read `src/auth/middleware.js`" not "look at the auth code"
- **Testable criteria** — "Endpoint returns 200 with `{ users: [] }` for empty query" not "works correctly"
- **Resumable** — Include checkpoint instructions that survive session interruptions

## PRD-to-Plan Conversion

If you're starting from a product requirements document, structure it as:

1. **Overview** — Problem and solution in 2-3 sentences
2. **Goals** — Measurable objectives
3. **User Stories** — "As a [user], I want [feature] so that [benefit]" with acceptance criteria
4. **Functional Requirements** — Numbered, unambiguous
5. **Non-Goals** — What's explicitly out of scope
6. **Technical Considerations** — Constraints, integration points

Then convert each user story group into a plan file.

## Phased vs One-Shot

For any non-trivial feature, decide between:

| Approach | When to Use | Pros | Cons |
|----------|------------|------|------|
| **Phased** | 5+ user stories, 8+ files | Safer, easier to debug, incremental PRs | More plans to manage |
| **One-shot** | Under 5 stories, under 8 files | Single PR, less overhead | Riskier, harder to debug |

Phased order: **Schema/migrations -> Backend API -> Frontend UI -> Tests**

Be honest with yourself: if it's complex, use phased. Don't waste a one-shot attempt on something likely to fail halfway through.

## Multi-Agent Plans

When splitting work across agents:

1. **Backend first** — Define data contracts (API shapes, DB schema)
2. **Frontend second** — Consumes the backend API
3. **Tests last** — Targets both layers

Use `depends_on` to enforce ordering:

```yaml
team:
  - agent: "backend-dev"
    scope: ["backend/**", "migrations/**"]
  - agent: "frontend-dev"
    scope: ["frontend/**"]
    depends_on: ["backend-dev"]
  - agent: "qa-tester"
    scope: ["tests/**"]
    depends_on: ["backend-dev", "frontend-dev"]
```

### File Ownership

If two agents might edit the same file, **don't parallelize them**. Use `depends_on` to serialize, or split the file's concerns across agents using `scope` and `blocked_files`:

```yaml
- agent: "backend-dev"
  scope: ["backend/**"]
  blocked_files: ["backend/server.js"]  # another agent owns route registration
```

## Anti-Patterns

| Don't | Do Instead |
|-------|-----------|
| "Read all files in the project" | "Read `src/auth/middleware.js` and `src/routes/users.js`" |
| "Update all 15 components" | Split into 3-4 phased plans |
| "Keep trying until it works" | Set `max_turns_per_agent: 30` with clear failure criteria |
| No rollback plan | "If migration fails, run `down()` and commit the revert" |
| Vague done conditions | "GET /api/users returns 200 with JSON array" |
| Huge scope with one agent | Split into focused agents with `depends_on` |

## Example: Converting an Idea to a Plan

**Idea:** "Add user search to the dashboard"

**Bad plan body:**
> Add search functionality to the app. Make it work with the existing user system.

**Good plan body:**
> ## Objective
> Add a search endpoint that lets dashboard users find other users by name or email.
>
> ## Context
> - Read `backend/routes/users.js` for existing user endpoints
> - Read `frontend/js/dashboard.js` for the current user list rendering
> - The users table has columns: id, name, email, role, company_id
>
> ## Constraints
> - Do NOT modify the auth middleware
> - Search must respect company_id scoping (users only see their own company)
> - Use parameterized queries (no string interpolation in SQL)
>
> ## Acceptance Criteria
> - `GET /api/users/search?q=john` returns matching users (name OR email ILIKE)
> - Empty query returns 400, not all users
> - Results are scoped to the requesting user's company_id
> - Frontend search input triggers on Enter key, debounced 300ms

## Tips

- **Start small.** Your first plan should be a single-agent, 20-turn task. Get a feel for how agents interpret instructions before scaling up.
- **Be explicit about what exists.** Agents don't know your codebase. Tell them which files to read and what patterns to follow.
- **Set `max_turns_per_agent`.** Default is 50. Research tasks need 10-20. Complex features need 40-60. Anything over 80 usually means the task is too big.
- **Use `scope` aggressively.** It's injected into the agent's prompt and prevents accidental edits outside the agent's lane.
- **Check the dashboard.** Watch turn counts and logs in real time at `/dashboard`. If an agent is spinning (high turns, no commits), cancel and refine the plan.
