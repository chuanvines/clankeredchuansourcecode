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

| Secret | Purpose | Status |
|---|---|---|
| `BOT_TOKEN` | Discord bot token | ✅ Set |
| `CLIENT_ID` | Discord application client ID (needed for slash command registration) | ⚠️ Missing |
| `GROQ_API_KEY` | AI commands | ✅ Set |
| `GOOGLE_API_KEY` | Google image search command | Optional |
| `GOOGLE_CSE_ID` | Google Custom Search Engine ID | Optional |
| `CATBOX_USER` | Catbox file uploads | Optional |
| `CATBOX_USERHASH` | Catbox file uploads | Optional |

`DATABASE_URL` is automatically provided by Replit's built-in PostgreSQL.

## Bot Commands

Audio/signal processing: `cqt`, `cwt`, `cq`, `fft`, `viz`, `waveform`, `audiotoimage`, `imagetoaudio`, `bytebeat`, `tts`  
Media: `ytdl`, `catboxupload`, `effectsgif`, `nparison`  
Utility: `ping`, `status`, `tag`, `block`, `unblock`, `addsource`, `lastexport`, `canvas`, `worldnumbers`, `veb`, `ai`, `googlesearchimage`, `ihtx`

## User Preferences

_None recorded yet._
