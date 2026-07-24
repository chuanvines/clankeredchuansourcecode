# Discord Bot — Project Overview

A feature-rich Discord bot with an Express API backend, built with TypeScript in a pnpm monorepo.

## Stack

- **Runtime:** Node.js (ESM), TypeScript
- **Framework:** Express v5
- **Discord:** discord.js v14
- **Database:** PostgreSQL via Drizzle ORM (Replit built-in DB)
- **AI:** Groq SDK, Anthropic SDK
- **Monorepo:** pnpm workspaces

## Structure

```
artifacts/api-server/   # Main bot + Express API server
lib/db/                 # Drizzle ORM schema & DB client
lib/api-spec/           # OpenAPI spec + code generation
lib/api-zod/            # Zod schemas (generated)
lib/api-client-react/   # React API client (generated)
data/                   # JSON data files (blocks, tags)
```

## How to Run

The **Discord Bot** workflow runs the server:

```
PORT=8080 pnpm --filter @workspace/api-server run dev
```

This builds the TypeScript (via esbuild) then starts the server with auto-restart on crash.

## Required Secrets

| Variable | Purpose | Status |
|---|---|---|
| `BOT_TOKEN` | Discord bot token | ✅ Secret configured |
| `CLIENT_ID` | Discord application ID for global slash-command registration | ✅ Environment variable configured |
| `GROQ_API_KEY` | AI commands | Optional; `&ai` is unavailable until configured |
| `GOOGLE_API_KEY` / `GOOGLE_CSE_ID` | Google image search command | Optional |
| `CATBOX_USER` / `CATBOX_USERHASH` | Catbox file uploads | Optional |

`DATABASE_URL` is automatically provided by Replit's built-in PostgreSQL.

The verified workflow is **Discord Bot**. It runs the API and bot on port 8080:

```
PORT=8080 pnpm --filter @workspace/api-server run dev
```

The server's status page is available at `/`. The imported project currently has
pre-existing TypeScript typecheck errors in media-effect and mediascript command
types, but its esbuild-based development workflow builds and starts successfully.

## Bot Commands

Audio/signal processing: `cqt`, `cwt`, `cq`, `fft`, `viz`, `waveform`, `audiotoimage`, `imagetoaudio`, `bytebeat`, `tts`  
Media: `ytdl`, `catboxupload`, `effectsgif`, `nparison`  
Utility: `ping`, `status`, `tag`, `block`, `unblock`, `addsource`, `lastexport`, `canvas`, `worldnumbers`, `veb`, `ai`, `googlesearchimage`, `ihtx`

## User Preferences

_None recorded yet._
