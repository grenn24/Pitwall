# Agentic IDE — Spec v0.1

Draft spec from a brainstorming session. Decisions and open questions.
Date: 2026-08-27

---

## 1. What it is

A desktop app for developers who orchestrate AI agents instead of typing most of the code.

You write tickets. A team of role-based agents plans, writes tests, writes code, and reviews. You approve or send it back.

**Not an editor.** It embeds an existing code editor (Monaco or CodeMirror). We do not build a text editor, language server, or debugger.

**Not no-code.** Code is still the artifact. Review is the interface.

---

## 2. Who it's for

Individual developers first. They install things themselves — no sales team needed.

The team/manager view (fleet of agents, cost per run, approved capabilities, audit) comes later and is where higher pricing lives.

---

## 3. Core loop

1. Connect a repo
2. Pick your agent team (default: 3 agents)
3. Write a ticket
4. Agents produce a plan. User approves the plan
5. Tests are written **first**, from the ticket
6. Coder writes code on its own branch
7. Preview URL + isolated database spin up
8. Reviewer runs the tests and opens the app
9. User reviews: screenshots, test results, diff
10. Approve → merge. Or send back with a comment
11. Branch, containers and preview are torn down

While it runs, the user can: pause an agent, open and edit the code directly, chat with one agent, reorder tickets.

---

## 4. Agents and roles

A **role** is a bundle: instructions + tools + skills + permissions.

Ship a predefined set. Users can edit roles and choose how many agents they run.

Default team of 3:

| Role | Does | Cannot |
|---|---|---|
| Designer | UI decisions, layout, states | Touch backend |
| Coder | Implementation | Approve its own work |
| Reviewer | Runs tests, opens the app, judges against the ticket | Write code |

**Do not make people configure a team before their first result.** Ship the default. Let them edit after they've seen it work.

### Rule 1 — Agents do not message each other

Passing messages between roles loses intent. This is the most common failure of multi-agent setups.

Instead: **one shared document per ticket.** The spec, constraints, and decisions. Every role reads and writes it. Nothing is passed by chat.

### Rule 2 — The reviewer must act, not read

A reviewer that only reads the diff will approve almost anything. Same model, same blind spots.

The reviewer must have independent ground truth:

- Run the test suite
- Open the running app (Playwright)
- Check against the written ticket

### Rule 3 — Tests come before code

If the coder writes code and then tests, the tests describe the bug too. They always pass. Useless.

Tests are generated from the ticket, before implementation.

---

## 5. Architecture decisions

### Runs on the user's laptop

- No server bill for us
- Company code never leaves the machine — a real enterprise selling point
- Known downside: close the laptop, agents stop. Users will complain
- Optional cloud runner is a later addition, same product

### Per-branch isolation

Each ticket gets:

- Its own git branch
- Its own app container
- Its own database container (Docker + seed file)

Why a separate database: parallel agents on a shared DB corrupt each other. Agent A adds a column, Agent B's code breaks. Agent B wipes the users table, Agent A's preview goes blank.

Docker per branch works with any Postgres or MySQL — no vendor lock. Fast paths for Neon and Supabase branching can come later.

Note: 5 agents ≈ 10 containers. This is heavy on a laptop. Cap concurrency, and show the user the cost.

### Testing

Don't build integrations per framework. **Run whatever test command the project already has.** Jest, Vitest, Playwright — all print pass/fail and exit with a code. Read that.

Do not build our own e2e framework. Playwright and Maestro already exist and have years of work in them.

What we build is the **viewer**: screenshots, video on failure, and test output shown in the review screen. Playwright already records all of it.

---

## 6. Git and GitHub

Keep GitHub and GitLab. They are the industry standard and teams will not leave them.

- One branch per ticket
- Agent commits as it works
- On merge, squash into one clean commit named after the ticket — never show the user 30 messy agent commits
- Author = the agent, co-author = the user, so `git blame` still means something

### PR handling

We ship a **GitHub App** (and a GitLab OAuth app):

- Org admins install it and control which repos it can touch
- Fine-grained permissions — enterprises require this
- Higher rate limits than a personal token

Through the API we can: open the PR, read the diff, comment on lines, approve, merge, read CI status.

**Constraint:** GitHub does not let you approve your own PR. So the App opens the PR, and the user approves it with their own account through our UI. Different identities, so it works.

**Never bypass branch protection or CODEOWNERS.** Their existing rules still apply. This is a selling point, not a limitation.

---

## 7. Deployment

Split into two things.

**Preview deploys — we do this.** Per branch, temporary, on the laptop. Required, or the reviewer cannot open the app. Torn down on merge.

**Production deploys — we do NOT do this.** They already have Vercel, GitHub Actions, or similar. PR merges, their pipeline runs.

We read deploy status from the GitHub API and display it. "Merged → Deploying → Live." Read-only. Cheap to build, feels complete.

Explicitly rejected: a "deploy anywhere" abstraction. Every platform differs, the abstraction leaks, and it means competing with Vercel while paying server bills.

---

## 8. UI direction

Futuristic, modern, minimal. Dark and light modes.

Main screen is undecided. Two candidates:

- **Board** — columns are stages (design → code → review), cards are tickets. Works because with roles, the columns mean something.
- **Inbox** — only shows agents that are blocked, failed, or waiting for review. Everything else stays quiet. Scales better past 3 agents.

These can combine: board as the map, inbox as the default view.

---

## 9. Explicitly out of scope

Listed so scope creep has something to bounce off.

- Building a text editor, language server, or debugger
- Building our own e2e test framework
- Mobile app testing (web first; add if customers ask)
- Production deployment
- A universal "deploy anywhere" layer
- Replacing GitHub or GitLab

---

## 10. v0 — the thinnest version

Build only this. If this loop doesn't feel good, nothing else matters.

- One repo
- One ticket
- **One** agent
- Test written first
- Branch + preview URL + seeded database container
- PR opened, approved and merged from inside the app

No team config. No roles. No board. No multi-agent.

---

## 11. Validate before building

One week, no code.

Give the same ticket to 1 agent. Then give it to 3 role-based agents. Compare quality, wall-clock time, and token cost.

Three agents costs roughly 3x and is slower, because they wait on each other. **If the 3-agent version is not clearly better, the role-split premise is wrong and the product changes shape.**

Also: run 5 agents in parallel worktrees manually for a week using existing tools. Write down every moment it annoys you. That list is the real product backlog and it costs nothing.

---

## 12. Open questions

- Main screen: board, inbox, or both?
- Cap on concurrent agents given laptop limits?
- What happens to a run when the laptop sleeps?
- Who resolves merge conflicts between two agents touching the same file?
- Pricing: per seat, per agent run, or per month?
- What is the honest answer to "why doesn't GitHub or Cursor just ship this as a feature?"
