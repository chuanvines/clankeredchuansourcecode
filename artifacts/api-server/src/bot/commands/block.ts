import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Message } from "discord.js";
import { replyError } from "../lib/embeds.js";

const DATA_DIR = "/home/runner/workspace/data";
const BLOCKS_FILE = join(DATA_DIR, "blocks.json");

const OWNER_USERNAME = "btve436";

interface BlockEntry {
  until: number;
  username: string;
}

type BlockStore = Record<string, BlockEntry>;

function load(): BlockStore {
  if (!existsSync(BLOCKS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(BLOCKS_FILE, "utf-8")) as BlockStore;
  } catch {
    return {};
  }
}

function save(store: BlockStore): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(BLOCKS_FILE, JSON.stringify(store, null, 2), "utf-8");
}

export function isBlocked(userId: string): boolean {
  const store = load();
  const entry = store[userId];
  if (!entry) return false;
  if (Date.now() >= entry.until) {
    delete store[userId];
    save(store);
    return false;
  }
  return true;
}

export function getBlockInfo(userId: string): BlockEntry | null {
  const store = load();
  const entry = store[userId];
  if (!entry) return null;
  if (Date.now() >= entry.until) return null;
  return entry;
}

export async function handleBlockCommand(message: Message): Promise<void> {
  if (message.author.username !== OWNER_USERNAME) {
    await replyError(message, "Only the bot owner can use this command.");
    return;
  }

  const rest = message.content.slice("&block".length).trim();
  const parts = rest.split(/\s+/);

  const targetRaw = parts[0] ?? "";
  const hoursRaw = parts[1] ?? "";
  const hours = parseFloat(hoursRaw);

  if (!targetRaw || isNaN(hours) || hours <= 0) {
    await replyError(message, "Usage: `&block <@mention|userId> <hours>`");
    return;
  }

  const mentionMatch = /^<@!?(\d+)>$/.exec(targetRaw);
  let targetId: string;
  let targetUsername = targetRaw;

  if (mentionMatch) {
    targetId = mentionMatch[1]!;
    const member = message.guild?.members.cache.get(targetId)
      ?? await message.guild?.members.fetch(targetId).catch(() => null);
    targetUsername = member?.user.username ?? targetId;
  } else if (/^\d+$/.test(targetRaw)) {
    targetId = targetRaw;
    const member = message.guild?.members.cache.get(targetId)
      ?? await message.guild?.members.fetch(targetId).catch(() => null);
    targetUsername = member?.user.username ?? targetId;
  } else {
    await replyError(message, "Please specify a user via `@mention` or numeric user ID.");
    return;
  }

  if (targetId === message.author.id) {
    await replyError(message, "You cannot block yourself.");
    return;
  }

  const until = Date.now() + Math.round(hours * 3_600_000);
  const store = load();
  store[targetId] = { until, username: targetUsername };
  save(store);

  const unixSec = Math.floor(until / 1000);
  await message.reply(
    `✅ **${targetUsername}** is blocked from using the bot for **${hours}h** (until <t:${unixSec}:F>).`
  );
}

export async function handleUnblockCommand(message: Message): Promise<void> {
  if (message.author.username !== OWNER_USERNAME) {
    await replyError(message, "Only the bot owner can use this command.");
    return;
  }

  const rest = message.content.slice("&unblock".length).trim();
  const targetRaw = rest.trim();

  if (!targetRaw) {
    await replyError(message, "Usage: `&unblock <@mention|userId>`");
    return;
  }

  const mentionMatch = /^<@!?(\d+)>$/.exec(targetRaw);
  let targetId: string;

  if (mentionMatch) {
    targetId = mentionMatch[1]!;
  } else if (/^\d+$/.test(targetRaw)) {
    targetId = targetRaw;
  } else {
    await replyError(message, "Please specify a user via `@mention` or numeric user ID.");
    return;
  }

  const store = load();
  if (!store[targetId]) {
    await message.reply("ℹ️ That user is not currently blocked.");
    return;
  }
  const name = store[targetId]!.username;
  delete store[targetId];
  save(store);
  await message.reply(`✅ **${name}** has been unblocked.`);
}
