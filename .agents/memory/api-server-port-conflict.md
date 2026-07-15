---
name: API Server port conflict
description: The artifacts/api-server workflow and the Discord Bot workflow both try to bind port 8080 — whichever starts first wins; the other crash-loops.
---

# API Server Port Conflict

**Rule:** Only ONE of these two workflows should be running at a time:
- `Discord Bot` — the manually configured workflow
- `artifacts/api-server: API Server` — the auto-managed artifact workflow

Both run `pnpm --filter @workspace/api-server run dev` and both try to bind port 8080. Whichever starts first wins; the other crash-loops with EADDRINUSE.

**Why:** When the `api-server` artifact was registered, the platform auto-created the artifact workflow. It competed with the pre-existing `Discord Bot` workflow.

**How to apply:** After any restart or deploy, check that only `Discord Bot` is running (stop the artifact workflow if both are active). Alternatively, when prompted to set up or restart the bot, always restart `Discord Bot` and stop `artifacts/api-server: API Server`.
