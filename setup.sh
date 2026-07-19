#!/usr/bin/env bash
# setup.sh — run once after cloning / importing to Replit
# Installs all JS/TS and Python dependencies needed to run the Discord bot.

set -e

echo "==> Installing JS/TS dependencies (pnpm workspaces)..."
pnpm install

echo "==> Installing Python dependencies..."
pip install -r artifacts/api-server/requirements.txt

echo ""
echo "Done. Required secrets before starting the bot:"
echo "  BOT_TOKEN      — Discord bot token"
echo "  CLIENT_ID      — Discord application ID (for slash-command registration)"
echo "  GROQ_API_KEY   — Groq API key (for the &ai command)"
echo ""
echo "Optional secrets:"
echo "  GOOGLE_API_KEY / GOOGLE_CSE_ID  — for &googlesearchimage"
echo "  CATBOX_USER / CATBOX_USERHASH   — for &catboxupload"
echo ""
echo "DATABASE_URL is provided automatically by Replit PostgreSQL."
echo ""
echo "Start the bot with:  pnpm --filter @workspace/api-server run dev"
