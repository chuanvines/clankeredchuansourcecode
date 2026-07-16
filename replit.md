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

| Secret | Purpose |
|---|---|
| `DISCORD_TOKEN` | Discord bot token |
| `CLIENT_ID` | Discord application client ID |
| `GROQ_API_KEY` | AI commands |
| `GOOGLE_API_KEY` | Google image search command |
| `GOOGLE_CSE_ID` | Google Custom Search Engine ID |
| `CATBOX_USER` | Catbox file uploads |
| `CATBOX_USERHASH` | Catbox file uploads |

`DATABASE_URL` is automatically provided by Replit's built-in PostgreSQL.

## Bot Commands

Audio/signal processing: `cqt`, `cwt`, `cq`, `fft`, `viz`, `waveform`, `audiotoimage`, `imagetoaudio`, `bytebeat`, `tts`  
Media: `ytdl`, `catboxupload`, `effectsgif`, `nparison`  
Utility: `ping`, `status`, `tag`, `block`, `unblock`, `addsource`, `lastexport`, `canvas`, `worldnumbers`, `veb`, `ai`, `googlesearchimage`, `ihtx`

## User Preferences

_None recorded yet._
