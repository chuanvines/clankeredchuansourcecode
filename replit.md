# ChuanEditBot (Discord bot)

A Discord bot providing media/editing commands (audio/video effects, AI chat, image/canvas tools, tag system, meme downloads) built on Discord.js.

## Run & Operate

- The "Discord Bot" workflow runs `pnpm --filter @workspace/api-server run dev` (builds then starts the bot + health server on port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env/secrets: `DATABASE_URL` (auto-provided by Replit's Postgres), `BOT_TOKEN` (Discord bot token), `CLIENT_ID` (Discord application ID, used to register slash commands), `GROQ_API_KEY` (powers the `/ai` command), `CATBOX_USERHASH` (used for uploading large files via catbox.moe)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Discord bot: discord.js 14, slash commands in `artifacts/api-server/src/bot/commands`
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Some effects (`artifacts/api-server/src/bot/effects/*.py`) are Python scripts invoked as subprocesses for audio/video processing

## Where things live

- `artifacts/api-server/src/bot/index.ts` — bot startup/login
- `artifacts/api-server/src/bot/register.ts` — slash command registration
- `artifacts/api-server/src/bot/commands/` — one file per slash command
- `artifacts/api-server/src/bot/effects/` — Python-based audio/video/image effect scripts
- `lib/db/src/schema` — Drizzle schema (source of truth for DB tables)
- `data/tags.json`, `data/blocks.json` — bot's tag system and blocklist data

## Architecture decisions

- Imported project; kept its existing pnpm-workspace/Express/Discord.js structure as-is rather than restructuring.

## Product

Discord bot ("ChuanEditBot") offering slash commands for AI chat, audio/video/image effects, a custom tag system, and file uploads via catbox.moe.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
