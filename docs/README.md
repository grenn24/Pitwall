# Pitwall — design documents

Working documents for the agentic IDE. Source of truth for scope and sequencing.

| File | What it is | Live version |
|---|---|---|
| [spec-v0.2.html](spec-v0.2.html) | Current spec. Supersedes v0.1 | https://claude.ai/code/artifact/e4101683-71e5-43d2-9e50-6c3550a55c82 |
| [build-plan-v0.html](build-plan-v0.html) | Nine risk-ordered milestones to a merged PR | https://claude.ai/code/artifact/8be6116c-f328-40d8-a481-900c8ec77040 |
| [spec-v0.1.md](spec-v0.1.md) | Original brainstorm draft, kept for history | — |

The HTML files are the sources the published pages are built from. Editing one and
republishing it to the URL above updates that page in place.

## Where the decisions live

- Agents share state and never message each other — spec §4, Rules 1 and 4
- Concurrency: sequential within a ticket, parallel across tickets, capped at three — §5
- Skills: per role, vendored from the public registry, hash-pinned — §4
- GitHub auth: device flow, no backend, no self-approval in v0 — §7
- v0 ships the three-role team, not one agent — §11

## Open

- Pricing — deferred until the MVP is in someone else's hands
- Why GitHub or Cursor would not just ship this as a feature
