import {
  AttachmentBuilder,
  Message,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from "discord.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { readdir, readFile, writeFile, rm, mkdir, mkdtemp } from "node:fs/promises";
import { join, extname, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import vm from "node:vm";
import axios from "axios";

const RUN_TS_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "run-ts.mjs");

import { parseEffectsString } from "../effects/parser.js";
import { processMedia, detectMediaType } from "../effects/processor.js";
import { toCdnUrl } from "./catboxupload.js";
import { logger } from "../lib/logger.js";

const execFileAsync = promisify(execFile);

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── Storage ──────────────────────────────────────────────────────────────────

const DATA_DIR = "/home/runner/workspace/data";
const TAGS_FILE = join(DATA_DIR, "tags.json");

interface TagEntry {
  script: string;
  ownerId: string;
  ownerUsername: string;
  createdAt: string;
  updatedAt: string;
}
type TagStore = Record<string, TagEntry>;

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

const TAGS_BAK_FILE = TAGS_FILE + ".bak";

function parseTags(raw: string): TagStore {
  const obj = JSON.parse(raw) as Record<string, unknown>;
  const result: TagStore = {};
  for (const [name, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      result[name] = {
        script: value,
        ownerId: "unknown",
        ownerUsername: "unknown",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } else {
      result[name] = value as TagEntry;
    }
  }
  return result;
}

export function loadTags(): TagStore {
  ensureDataDir();
  // Try the main file first, then fall back to the backup.
  for (const path of [TAGS_FILE, TAGS_BAK_FILE]) {
    try {
      if (!existsSync(path)) continue;
      return parseTags(readFileSync(path, "utf-8"));
    } catch {
      // corrupt — try next
    }
  }
  return {};
}

function saveTags(tags: TagStore, allowDeletion = false): void {
  ensureDataDir();
  const newContent = JSON.stringify(tags, null, 2);

  // Safety guard: never overwrite with fewer tags than already stored,
  // unless the caller explicitly confirms this is an intentional deletion.
  if (existsSync(TAGS_FILE)) {
    try {
      const existing = parseTags(readFileSync(TAGS_FILE, "utf-8"));
      if (!allowDeletion && Object.keys(tags).length < Object.keys(existing).length) {
        // Something is wrong — keep old file, do not overwrite
        return;
      }
      // Back up the current good file before writing the new one
      writeFileSync(TAGS_BAK_FILE, readFileSync(TAGS_FILE));
    } catch {
      // existing file is corrupt — skip backup, just overwrite
    }
  }

  // Atomic write: write to a temp file then rename so a crash mid-write
  // can't leave the file half-written.
  const tmp = TAGS_FILE + ".tmp";
  writeFileSync(tmp, newContent);
  renameSync(tmp, TAGS_FILE);
}

/** Returns true if the member has Manage Messages (server mod/admin) in the channel. */
function isPrivileged(message: Message): boolean {
  const member = message.member;
  if (!member) return false;
  return member.permissions.has(PermissionFlagsBits.ManageMessages);
}

const RESERVED = new Set(["add", "del", "delete", "remove", "forceremove", "list", "info", "help", "random", "search", "alias"]);
const BOT_OWNER_USERNAME = "btve436";

// ── Tagscript Engine ─────────────────────────────────────────────────────────

export type MediaResult = { type: "media"; buffer: Buffer; ext: string };
export type CombinedResult = { type: "combined"; text: string; buffer: Buffer; ext: string };
export type ScriptResult = string | MediaResult | CombinedResult;

const EXEC_TIMEOUT_MS = 10_000;
const SHELL_TIMEOUT_MS = 60_000;

async function runSubprocess(cmd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      env: env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 512 * 1024) proc.kill();
    });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    if (input !== undefined) {
      proc.stdin.write(input, "utf8");
    }
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill();
      resolve(`[Error: subprocess timed out after ${EXEC_TIMEOUT_MS}ms]`);
    }, EXEC_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        const detail = (stderr || stdout).trim();
        resolve(`[Error: ${detail.slice(0, 500)}]`);
      } else {
        resolve((stdout || stderr).trim());
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve(`[Error: ${err.message.slice(0, 500)}]`);
    });
  });
}

/** Download attachment URLs to temp files; returns FILE_N env vars and a cleanup fn. */
async function downloadAttachmentsToEnv(urls: string[]): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const tmpDir = await mkdtemp(join(tmpdir(), "tagfiles-"));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    try {
      const resp = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 30_000, headers: { "User-Agent": BROWSER_UA } });
      const rawName = (url.split("?")[0] ?? "file").split("/").pop() ?? "file";
      const ext = extname(rawName) || ".bin";
      const localPath = join(tmpDir, `file${i + 1}${ext}`);
      await writeFile(localPath, Buffer.from(resp.data));
      env[`FILE_${i + 1}`] = localPath;
    } catch { /* skip failed downloads */ }
  }
  return { env, cleanup: () => rm(tmpDir, { recursive: true, force: true }).catch(() => {}) };
}

/**
 * Enhanced shell runner used by {sh:...} tagscript.
 *
 * Special syntax inside the script (processed before execution):
 *   load <url>   — downloads the URL to a temp file, sets $FILE_1, $FILE_2, …
 *
 * The script's working directory contains an `output/` folder.
 * Any files written there are returned as a media attachment.
 * stdout/stderr is returned as message text alongside the file.
 */
export async function runShellWithFiles(code: string): Promise<ScriptResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), "tagsh-"));
  try {
    await mkdir(join(tmpDir, "output"), { recursive: true });

    const env: NodeJS.ProcessEnv = { ...process.env };
    const scriptLines: string[] = ["#!/bin/bash", "set -e"];
    let fileIdx = 0;

    for (const line of code.split("\n")) {
      const loadMatch = /^\s*load\s+(\S+)/.exec(line);
      if (loadMatch) {
        const url = loadMatch[1]!;
        if (/^https?:\/\//.test(url)) {
          fileIdx++;
          const rawName = (url.split("?")[0] ?? "file").split("/").pop() ?? "file";
          const ext = extname(rawName) || ".mp4";
          const localPath = join(tmpDir, `file${fileIdx}${ext}`);
          try {
            const resp = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 30_000, headers: { "User-Agent": BROWSER_UA } });
            await writeFile(localPath, Buffer.from(resp.data));
            env[`FILE_${fileIdx}`] = localPath;
          } catch {
            scriptLines.push(`echo "[load: failed to download ${url}]"`);
          }
        }
      } else {
        scriptLines.push(line);
      }
    }

    const scriptPath = join(tmpDir, "script.sh");
    await writeFile(scriptPath, scriptLines.join("\n"));

    let stdout = "";
    let stderr = "";
    let exitOk = true;
    try {
      const result = await execFileAsync("bash", [scriptPath], {
        env,
        cwd: tmpDir,
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: unknown) {
      exitOk = false;
      stdout = (err as NodeJS.ErrnoException & { stdout?: string }).stdout ?? "";
      stderr = (err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? "";
      if (!stdout && !stderr) {
        const msg = err instanceof Error ? err.message : String(err);
        stderr = `[shell error: ${msg.slice(0, 200)}]`;
      }
    }

    // Check for output files
    const outFiles = await readdir(join(tmpDir, "output")).catch(() => [] as string[]);
    const outFile = outFiles[0];

    if (outFile) {
      const outPath = join(tmpDir, "output", outFile);
      const buffer = await readFile(outPath);
      const ext = extname(outFile) || ".mp4";
      // Success: only include stdout as text (stderr is ffmpeg progress noise)
      const text = stdout.trim();
      if (text) return { type: "combined", text, buffer, ext };
      return { type: "media", buffer, ext };
    }

    // No output file — build a useful error message
    let text = stdout.trim();
    if (!exitOk || !text) {
      // Filter only the verbose ffmpeg version/config header lines.
      // Do NOT filter nix store paths — those can appear in wine/bash errors too.
      const errLines = stderr.trim().split("\n").filter((line) =>
        !/^\s*(configuration:|built with|ffmpeg version \d|\s*--(?:en|dis)able|lib\w+\s+\d+\.\s*\d+\.\s*\d+)/.test(line)
      );
      const tail = errLines.slice(-40).join("\n").trim();
      if (tail) text = text ? `${text}\n${tail}` : tail;
    }
    if (!text) text = exitOk ? "(no output)" : "[script exited with error — no output file produced]";
    return text;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Python runner used by {py:...} tagscript.
 * Runs the script with cwd set to a temp directory. Any image/media file
 * saved there (e.g. plt.savefig("graph.png")) is returned as an attachment.
 */
export async function runPythonWithFiles(code: string, extraEnv?: NodeJS.ProcessEnv): Promise<ScriptResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), "tagpy-"));
  try {
    const scriptPath = join(tmpDir, "script.py");
    await writeFile(scriptPath, code);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...extraEnv,
      MPLBACKEND: "Agg",
    };

    let stdout = "";
    let stderr = "";
    let exitOk = true;
    try {
      const result = await execFileAsync("python3", [scriptPath], {
        env,
        cwd: tmpDir,
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      }) as { stdout: string; stderr: string };
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: unknown) {
      exitOk = false;
      stdout = (err as NodeJS.ErrnoException & { stdout?: string }).stdout ?? "";
      stderr = (err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? "";
      if (!stdout && !stderr) {
        stderr = `[python error: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}]`;
      }
    }

    const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".mp4", ".webm", ".pdf"]);
    const allFiles = await readdir(tmpDir).catch(() => [] as string[]);
    const outFile = allFiles.find((f) => f !== "script.py" && IMAGE_EXTS.has(extname(f).toLowerCase()));

    if (outFile) {
      const buffer = await readFile(join(tmpDir, outFile));
      const ext = extname(outFile).toLowerCase() || ".png";
      const text = stdout.trim();
      if (text) return { type: "combined", text, buffer, ext };
      return { type: "media", buffer, ext };
    }

    let text = stdout.trim();
    if (!exitOk || !text) {
      const tail = stderr.trim().split("\n").slice(-20).join("\n").trim();
      if (tail) text = text ? `${text}\n${tail}` : tail;
    }
    if (!text) text = exitOk ? "(no output)" : "[python script exited with error — no output file produced]";
    return text;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Math sandbox ─────────────────────────────────────────────────────────────

function _gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a)); b = Math.abs(Math.round(b));
  while (b) { const t = b; b = a % b; a = t; }
  return a;
}

const MATH_SANDBOX = {
  // Constants
  e: Math.E, pi: Math.PI, PI: Math.PI,
  tau: 2 * Math.PI,
  phi: (1 + Math.sqrt(5)) / 2,
  // Basics
  Math, abs: Math.abs, sqrt: Math.sqrt, cbrt: Math.cbrt,
  pow: Math.pow, exp: Math.exp, sign: Math.sign,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max,
  // Logarithms (log = log10, ln = natural)
  log: Math.log10, log2: Math.log2, ln: Math.log,
  // Trig
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  // Reciprocal trig
  csc: (x: number) => 1 / Math.sin(x),
  sec: (x: number) => 1 / Math.cos(x),
  cot: (x: number) => Math.cos(x) / Math.sin(x),
  // Inverse reciprocal trig
  acsc: (x: number) => Math.asin(1 / x),
  asec: (x: number) => Math.acos(1 / x),
  acot: (x: number) => Math.atan(1 / x),
  // Hyperbolic
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  // Reciprocal hyperbolic
  csch: (x: number) => 1 / Math.sinh(x),
  sech: (x: number) => 1 / Math.cosh(x),
  coth: (x: number) => 1 / Math.tanh(x),
  // Utility
  gcd: _gcd,
  lcm: (a: number, b: number) => { const g = _gcd(a, b); return g === 0 ? 0 : Math.abs(Math.round(a) * Math.round(b)) / g; },
  mod: (a: number, b: number) => a % b,
  // JS helpers
  Number, parseInt, parseFloat, isNaN, isFinite,
};

/** Replace ^ with ** so users can write 2^8 instead of 2**8. */
function prepMath(expr: string): string {
  return expr.replace(/\^/g, "**");
}

function evalInVm(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return "";
  try {
    const result = vm.runInNewContext(`(${prepMath(trimmed)})`, MATH_SANDBOX, { timeout: 2000 });
    if (result === undefined || result === null) return "";
    return String(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[math error: ${msg.slice(0, 150)}]`;
  }
}

function evalCondition(condition: string): boolean {
  const trimmed = condition.trim();
  if (!trimmed) return false;
  try {
    const result = vm.runInNewContext(`(${prepMath(trimmed)})`, MATH_SANDBOX, { timeout: 500 });
    return Boolean(result);
  } catch {
    return trimmed !== "" && trimmed !== "0" && trimmed.toLowerCase() !== "false";
  }
}

/** Matches the innermost tag — content must not contain { or }. */
const INNERMOST_TAG_RE = /\{(arg|math|imagescript|iscript|mediascript|attach|js|ts|py|sh|runcodetxt|ihtx|ihtxffmpeg|veb|set|get|if|replace|upper|lower|len|choose|or|repeat|range|foreach|substring|indexof|tag):([^{}]*)\}/;

/**
 * Expand block-style {if:cond}...{elif:cond}...{else}...{/if} constructs.
 *
 * Only the OUTERMOST {if:} is matched when its condition has no { or } characters
 * (meaning all {get:}/{arg:}/etc. in the condition have already been resolved by
 * INNERMOST_TAG_RE in a previous loop iteration). Nested {if:}...{/if} are
 * tracked by brace depth so they don't confuse the scanner.
 *
 * {elif:cond} and {else} at depth 1 are recorded as branches; the first whose
 * condition evaluates truthy (or the {else}) wins. Branch content is returned
 * verbatim so that tags inside it are processed in subsequent iterations.
 */
function expandBlockIf(text: string): { text: string; changed: boolean } {
  const ifRe = /\{if:([^{}]*)\}/g;
  ifRe.lastIndex = 0;
  const m = ifRe.exec(text);
  if (!m) return { text, changed: false };

  const blockStart = m.index;
  const afterOpenTag = blockStart + m[0].length;
  const firstCond = m[1]!;

  interface Branch { cond: string | null; contentStart: number; contentEnd: number; }
  const branches: Branch[] = [];
  let currentCond: string | null = firstCond;
  let currentContentStart = afterOpenTag;
  let depth = 1;
  let i = afterOpenTag;
  let blockEnd = -1;

  while (i < text.length) {
    if (text[i] !== "{") { i++; continue; }

    // {/if} → decrease depth
    if (text.startsWith("{/if}", i)) {
      depth--;
      if (depth === 0) {
        branches.push({ cond: currentCond, contentStart: currentContentStart, contentEnd: i });
        blockEnd = i + 5;
        break;
      }
      i += 5;
      continue;
    }

    // Any {if:...} → increase depth (use brace counting to skip past its closing })
    if (text.startsWith("{if:", i)) {
      let j = i + 1; let bd = 1;
      while (j < text.length && bd > 0) { if (text[j] === "{") bd++; else if (text[j] === "}") bd--; j++; }
      depth++;
      i = j;
      continue;
    }

    // At depth 1: record branch boundaries
    if (depth === 1) {
      if (text.startsWith("{else}", i)) {
        branches.push({ cond: currentCond, contentStart: currentContentStart, contentEnd: i });
        currentCond = null;
        currentContentStart = i + 6;
        i += 6;
        continue;
      }
      if (text.startsWith("{elif:", i)) {
        let j = i + 1; let bd = 1;
        while (j < text.length && bd > 0) { if (text[j] === "{") bd++; else if (text[j] === "}") bd--; j++; }
        const elifCond = text.slice(i + 6, j - 1);
        branches.push({ cond: currentCond, contentStart: currentContentStart, contentEnd: i });
        currentCond = elifCond;
        currentContentStart = j;
        i = j;
        continue;
      }
    }
    i++;
  }

  if (blockEnd === -1) return { text, changed: false };

  let chosenContent = "";
  for (const branch of branches) {
    if (branch.cond === null || evalCondition(branch.cond.trim())) {
      chosenContent = text.slice(branch.contentStart, branch.contentEnd);
      break;
    }
  }

  return { text: text.slice(0, blockStart) + chosenContent + text.slice(blockEnd), changed: true };
}

/**
 * Tags whose content may legally contain { and } (shell scripts, JS, Python, etc.).
 * For these we use balanced-brace extraction instead of INNERMOST_TAG_RE so that
 * inner braces (e.g. ${var}, awk BEGIN{...}, JS objects) don't break parsing.
 */
const CODE_BLOCK_TAGS = new Set(["sh", "js", "ts", "py", "eval", "ignore", "imagescript", "iscript", "mediascript", "ihtxffmpeg", "runcodetxt", "attach"]);

/**
 * Find the first {tagName:...} block in `text` using balanced-brace counting.
 * Unlike INNERMOST_TAG_RE this handles content with nested { } correctly.
 */
function extractCodeBlock(text: string): {
  full: string; tag: string; content: string; startIdx: number; endIdx: number;
} | null {
  for (const tagName of CODE_BLOCK_TAGS) {
    const prefix = `{${tagName}:`;
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const start = text.indexOf(prefix, searchFrom);
      if (start === -1) break;
      let depth = 0;
      let end = -1;
      for (let i = start; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) { searchFrom = start + 1; continue; }
      return {
        full: text.slice(start, end + 1),
        tag: tagName,
        content: text.slice(start + prefix.length, end),
        startIdx: start,
        endIdx: end,
      };
    }
  }
  return null;
}

/** Matches a bare {tagname} shorthand — only letters/digits/underscores/hyphens, no colon. */
const BARE_TAG_RE = /\{([a-z0-9_-]+)\}/i;

/**
 * Expand {foreach:N|template} count-based blocks BEFORE the innermost engine
 * processes any tags inside them. Uses balanced-brace matching so the full
 * template (even with deeply nested tags) is captured and repeated N times.
 * Only fires when the N segment is a plain integer (no braces).
 */
function expandCountForeach(text: string): { text: string; changed: boolean } {
  // Match {foreach:<digits>| — the N is already a plain integer
  const numForeachRe = /\{foreach:(\d+)\|/g;
  let result = text;
  let changed = false;
  numForeachRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = numForeachRe.exec(result)) !== null) {
    const n = Math.min(parseInt(m[1]!, 10), 500);
    const openBrace = m.index;
    let depth = 0;
    let closeIdx = -1;
    for (let j = openBrace; j < result.length; j++) {
      if (result[j] === "{") depth++;
      else if (result[j] === "}") {
        depth--;
        if (depth === 0) { closeIdx = j; break; }
      }
    }
    if (closeIdx === -1) break;
    // pipeStart is the position of '|' after the digit(s)
    const pipeStart = openBrace + "{foreach:".length + m[1]!.length;
    const template = result.slice(pipeStart + 1, closeIdx);
    const expanded = Array.from({ length: n }, () => template).join("");
    result = result.slice(0, openBrace) + expanded + result.slice(closeIdx + 1);
    changed = true;
    numForeachRe.lastIndex = 0;
  }
  return { text: result, changed };
}

// ── {iv} helper ──────────────────────────────────────────────────────────────

/**
 * Extract all media URLs from a message's embeds (video > image > thumbnail).
 * Returns direct URLs; Discord CDN replacements are not needed for embed URLs.
 */
function embedMediaUrls(msg: Message): string[] {
  const urls: string[] = [];
  for (const embed of msg.embeds) {
    const src =
      embed.video?.proxyURL ?? embed.video?.url ??
      embed.image?.proxyURL ?? embed.image?.url ??
      embed.thumbnail?.proxyURL ?? embed.thumbnail?.url ??
      null;
    if (src) urls.push(src);
  }
  return urls;
}

/** Walk back up to 50 messages in the channel to find the most recent attachment or embed. */
async function findLastChannelAttachment(message: Message): Promise<string> {
  const channel = message.channel;
  if (!("messages" in channel)) return "";
  try {
    const fetched = await (channel as import("discord.js").TextChannel).messages.fetch({ limit: 50, before: message.id });
    for (const [, msg] of fetched) {
      const att = [...msg.attachments.values()][0];
      if (att?.url) return toCdnUrl(att.url);
      const embedSrc = embedMediaUrls(msg)[0];
      if (embedSrc) return embedSrc;
    }
  } catch { /* fall through */ }
  return "";
}

export async function resolveIv(message: Message): Promise<string> {
  // 1. Attachment on this message
  const allAttachments = [...message.attachments.values()];
  if (allAttachments[0]?.url) return toCdnUrl(allAttachments[0].url);
  // 2. Embed on this message
  const ownEmbedSrc = embedMediaUrls(message)[0];
  if (ownEmbedSrc) return ownEmbedSrc;
  // 3. Replied-to message: attachment then embed
  if (message.reference?.messageId) {
    try {
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
      const refAttach = [...refMsg.attachments.values()][0] ?? null;
      if (refAttach?.url) return toCdnUrl(refAttach.url);
      const refEmbedSrc = embedMediaUrls(refMsg)[0];
      if (refEmbedSrc) return refEmbedSrc;
    } catch { /* fall through */ }
  }
  // 4. Last attachment or embed in channel history
  return findLastChannelAttachment(message);
}

/** Resolve ALL media URLs: current message → reply → channel history fallback. Includes embeds. */
export async function resolveAllIvUrls(message: Message): Promise<string[]> {
  const urls: string[] = [];
  for (const a of message.attachments.values()) {
    if (a.url) urls.push(toCdnUrl(a.url));
  }
  for (const u of embedMediaUrls(message)) urls.push(u);

  if (message.reference?.messageId) {
    try {
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
      for (const a of refMsg.attachments.values()) {
        if (a.url) urls.push(toCdnUrl(a.url));
      }
      for (const u of embedMediaUrls(refMsg)) urls.push(u);
    } catch { /* fall through */ }
  }
  // If nothing found yet, fall back to last attachment/embed in channel history
  if (urls.length === 0) {
    const fallback = await findLastChannelAttachment(message);
    if (fallback) urls.push(fallback);
  }
  return urls;
}

// ── {imagescript:...} interpreter ────────────────────────────────────────────

// ── join helper ───────────────────────────────────────────────────────────────

async function joinMediaHStack(
  buf1: Buffer,
  ext1: string,
  buf2: Buffer,
  ext2: string,
): Promise<{ buffer: Buffer; ext: string }> {
  const tmpDir = await mkdtemp(join(tmpdir(), "isjoin-"));
  try {
    const p1 = join(tmpDir, `a${ext1}`);
    const p2 = join(tmpDir, `b${ext2}`);
    const isVideo = [".mp4", ".mov", ".webm", ".mkv"].some(
      (e) => ext1 === e || ext2 === e,
    );
    const outExt = isVideo ? ".mp4" : ext1;
    const out = join(tmpDir, `out${outExt}`);
    await writeFile(p1, buf1);
    await writeFile(p2, buf2);

    const args: string[] = [
      "-y", "-i", p1, "-i", p2,
      "-filter_complex",
      "[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[_jv0];" +
      "[1:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[_jv1];" +
      "[_jv0][_jv1]hstack[vout]",
      "-map", "[vout]",
    ];

    if (isVideo) {
      args.push(
        "-map", "0:a?",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-movflags", "+faststart",
      );
    } else {
      args.push("-frames:v", "1");
    }

    args.push(out);
    await execFileAsync("ffmpeg", args, { timeout: 120_000, maxBuffer: 100 * 1024 * 1024 });
    return { buffer: await readFile(out), ext: outExt };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Line-based media scripting language for {imagescript:...} tagscript.
 *
 * Syntax:
 *   load <url> <var>                    — download URL into variable (use {iv} for attached media)
 *   copy <var> <dest>                   — copy a variable to another name (no processing)
 *   join <var1> <var2> [dest]           — hstack two variables side by side
 *   <effect>[=<p>;<p>] <var> [<dest>]  — apply &ihtx effect; optional positional numeric params
 *                                         become subparams: `hueshifthsv i 180` → hueshifthsv=180
 *   pitch / audiopitch <var> <s1> [s2] — multipitch overlay (e.g. `audiopitch i 3 0`)
 *   volume <var> <amount>              — adjust volume
 *   vibrato / audiovibrato <var> <freq> [<depth>]
 *   audiodestroy <var>                 — extreme audio distortion (11× acontrast=100)
 *   4ormulator=<dial> <var>            — formant shift via rubberband (dial = formant value, e.g. 712923000)
 */
export async function runImagescript(code: string): Promise<ScriptResult> {
  type IVar =
    | { kind: "url"; url: string; name: string; ct: string }
    | { kind: "buf"; buffer: Buffer; ext: string; mediaType: import("../effects/processor.js").MediaType };

  const vars: Record<string, IVar> = {};
  let lastMedia: MediaResult | null = null;

  async function applyEffect(effectsStr: string, srcVarName: string, destVarName: string): Promise<string | null> {
    const src = vars[srcVarName];
    if (!src) return `[imagescript: undefined variable "${srcVarName}"]`;
    try {
      const effects = parseEffectsString(effectsStr);
      let result: import("../effects/processor.js").ProcessResult;
      if (src.kind === "url") {
        const inputExt = extname(src.name) || ".mp4";
        const mediaType = detectMediaType(src.name, src.ct);
        result = await processMedia({ effects, rep: 1, dur: null, inputUrl: src.url, inputExt, mediaType });
        vars[destVarName] = { kind: "buf", buffer: result.buffer, ext: result.ext, mediaType };
      } else {
        result = await processMedia({
          effects, rep: 1, dur: null,
          inputUrl: "", inputExt: src.ext, mediaType: src.mediaType,
          inputBuffer: src.buffer,
        });
        vars[destVarName] = { kind: "buf", buffer: result.buffer, ext: result.ext, mediaType: src.mediaType };
      }
      lastMedia = { type: "media", buffer: result.buffer, ext: result.ext };
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `[imagescript error on "${effectsStr}": ${msg.slice(0, 400)}]`;
    }
  }

  const lines = code
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("#"));

  for (const line of lines) {
    const tokens = line.match(/\S+/g) ?? [];
    if (tokens.length === 0) continue;
    const cmd = tokens[0]!.toLowerCase();

    // ── load <url> <varname> ────────────────────────────────────────────────
    if (cmd === "load") {
      const url = tokens[1] ?? "";
      const varName = tokens[2] ?? "i";
      if (!url) continue;
      const rawName = url.split("?")[0]!.split("/").pop() ?? "file";
      vars[varName] = { kind: "url", url, name: rawName, ct: "" };
      continue;
    }

    // ── pitch <var> <s1> [s2 ...] — multipitch overlay ──────────────────────
    if (cmd === "pitch") {
      const srcVar = tokens[1] ?? "i";
      const semiTokens = tokens.slice(2).filter((t) => /^-?\d+(\.\d+)?$/.test(t));
      const effectsStr = semiTokens.length > 0 ? `pitch=${semiTokens.join(";")}` : "pitch=0";
      const err = await applyEffect(effectsStr, srcVar, srcVar);
      if (err) return err;
      continue;
    }

    // ── volume <var> <amount> ────────────────────────────────────────────────
    if (cmd === "volume") {
      const srcVar = tokens[1] ?? "i";
      const amount = tokens[2] ?? "1";
      const err = await applyEffect(`volume=${amount}`, srcVar, srcVar);
      if (err) return err;
      continue;
    }

    // ── vibrato <var> <freq> [<depth>] ───────────────────────────────────────
    if (cmd === "vibrato") {
      const srcVar = tokens[1] ?? "i";
      const freq = tokens[2] ?? "5";
      const depth = tokens[3] && /^-?\d+(\.\d+)?$/.test(tokens[3]) ? tokens[3] : null;
      const effectsStr = depth ? `vibrato=${freq};${depth}` : `vibrato=${freq}`;
      const err = await applyEffect(effectsStr, srcVar, srcVar);
      if (err) return err;
      continue;
    }

    // ── speed <var> <rate> ───────────────────────────────────────────────────
    if (cmd === "speed") {
      const srcVar = tokens[1] ?? "i";
      const rate = tokens[2] ?? "1";
      const err = await applyEffect(`speed=${rate}`, srcVar, srcVar);
      if (err) return err;
      continue;
    }

    // ── copy <var> <dest> ─────────────────────────────────────────────────────
    if (cmd === "copy") {
      const srcVar = tokens[1] ?? "i";
      const destVar = tokens[2] ?? srcVar;
      const src = vars[srcVar];
      if (!src) return `[imagescript: undefined variable "${srcVar}"]`;
      vars[destVar] = { ...src };
      continue;
    }

    // ── concatmultiple <var1> <var2> ... ─────────────────────────────────────
    // Supports: video, audio, image, GIF. Stores result back in var1.
    // - all audio  → concat into .mp3
    // - otherwise  → normalize each input to a consistent .mp4 then concat
    //   image      → 3-second still frame with silence
    //   audio-only → black 640×360 frame + audio
    //   gif/video  → re-encode; silence added if no audio stream present
    if (cmd === "concatmultiple") {
      const varNames = tokens.slice(1);
      if (varNames.length < 2) {
        return `[imagescript: concatmultiple needs at least 2 variables]`;
      }

      // Collect inputs with media type info
      const inputs: Array<{ buffer: Buffer; ext: string; mediaType: import("../effects/processor.js").MediaType }> = [];
      for (const v of varNames) {
        const src = vars[v];
        if (!src) return `[imagescript: concatmultiple — undefined variable "${v}"]`;
        if (src.kind === "buf") {
          inputs.push({ buffer: src.buffer, ext: src.ext, mediaType: src.mediaType });
        } else {
          try {
            const resp = await axios.get<ArrayBuffer>(src.url, { responseType: "arraybuffer", timeout: 30_000, headers: { "User-Agent": BROWSER_UA } });
            const ext = extname(src.name) || ".mp4";
            const mediaType = detectMediaType(src.name, src.ct);
            inputs.push({ buffer: Buffer.from(resp.data), ext, mediaType });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return `[imagescript: concatmultiple — failed to fetch "${v}": ${msg.slice(0, 200)}]`;
          }
        }
      }

      const concatTmpDir = await mkdtemp(join(tmpdir(), "isconcat-"));
      try {
        const allAudio = inputs.every((inp) => inp.mediaType === "audio");
        const n = inputs.length;

        // Write raw files
        const rawPaths = await Promise.all(
          inputs.map(async (inp, i) => {
            const p = join(concatTmpDir, `raw${i}${inp.ext}`);
            await writeFile(p, inp.buffer);
            return p;
          }),
        );

        /** Check whether a file has at least one audio stream. */
        async function fileHasAudio(filePath: string): Promise<boolean> {
          try {
            const { stdout } = await execFileAsync(
              "ffprobe", ["-v", "error", "-select_streams", "a",
                "-show_entries", "stream=index", "-of", "csv=p=0", filePath],
              { timeout: 10_000 },
            );
            return stdout.trim().length > 0;
          } catch { return false; }
        }

        if (allAudio) {
          // ── Audio-only concat ──────────────────────────────────────────────
          // Normalize each stream to 44100 Hz stereo before concat so that
          // files with different sample rates / channel counts don't fail.
          const outPath = join(concatTmpDir, "out.mp3");
          const args = ["-y"];
          for (const p of rawPaths) args.push("-i", p);
          const normParts = inputs.map(
            (_, i) => `[${i}:a]aresample=44100,aformat=sample_fmts=s16:channel_layouts=stereo[a${i}]`,
          ).join(";");
          const concatInputs = inputs.map((_, i) => `[a${i}]`).join("");
          args.push(
            "-filter_complex", `${normParts};${concatInputs}concat=n=${n}:v=0:a=1[outa]`,
            "-map", "[outa]", outPath,
          );
          await execFileAsync("ffmpeg", args, { timeout: 300_000, maxBuffer: 200 * 1024 * 1024 });
          const buffer = await readFile(outPath);
          const destVar = varNames[0]!;
          vars[destVar] = { kind: "buf", buffer, ext: ".mp3", mediaType: "audio" };
          lastMedia = { type: "media", buffer, ext: ".mp3" };
        } else {
          // ── Video/Image/GIF/Audio mixed → normalize each to .mp4 ──────────
          const normPaths: string[] = [];

          for (let i = 0; i < inputs.length; i++) {
            const inp = inputs[i]!;
            const raw = rawPaths[i]!;
            const norm = join(concatTmpDir, `norm${i}.mp4`);
            const vscale = "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p,fps=30";
            const venc = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-movflags", "+faststart"];
            const aenc = ["-c:a", "aac", "-ar", "44100", "-ac", "2"];

            if (inp.mediaType === "image") {
              // Still image → 3-second video with silence
              await execFileAsync("ffmpeg", [
                "-y", "-loop", "1", "-i", raw,
                "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                "-t", "3",
                "-map", "0:v", "-map", "1:a",
                "-vf", vscale, ...venc, ...aenc, norm,
              ], { timeout: 60_000, maxBuffer: 100 * 1024 * 1024 });
            } else if (inp.mediaType === "audio") {
              // Audio → black 640×360 frame + audio
              await execFileAsync("ffmpeg", [
                "-y",
                "-f", "lavfi", "-i", "color=black:size=640x360:rate=30",
                "-i", raw,
                "-shortest",
                "-map", "0:v", "-map", "1:a",
                "-vf", "format=yuv420p", ...venc, ...aenc, norm,
              ], { timeout: 120_000, maxBuffer: 200 * 1024 * 1024 });
            } else {
              // Video or GIF — normalize; add silence if no audio stream
              const hasAudio = await fileHasAudio(raw);
              if (hasAudio) {
                await execFileAsync("ffmpeg", [
                  "-y", "-i", raw,
                  "-map", "0:v:0", "-map", "0:a:0",
                  "-shortest",
                  "-vf", vscale, ...venc, ...aenc, norm,
                ], { timeout: 120_000, maxBuffer: 200 * 1024 * 1024 });
              } else {
                // No audio track — mix in silence
                await execFileAsync("ffmpeg", [
                  "-y", "-i", raw,
                  "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                  "-shortest",
                  "-map", "0:v:0", "-map", "1:a",
                  "-vf", vscale, ...venc, ...aenc, norm,
                ], { timeout: 120_000, maxBuffer: 200 * 1024 * 1024 });
              }
            }
            normPaths.push(norm);
          }

          // Write filelist and concat.
          // Video: stream-copy (fast). Audio: re-encode to AAC so that
          // encoder-delay metadata and codec extradata are consistent across
          // all segments — stream-copying AAC from multiple MP4 files causes
          // silent/broken audio at segment boundaries.
          const filelistPath = join(concatTmpDir, "filelist.txt");
          await writeFile(filelistPath, normPaths.map((p) => `file '${p}'`).join("\n"));
          const outPath = join(concatTmpDir, "out.mp4");
          await execFileAsync("ffmpeg", [
            "-y", "-f", "concat", "-safe", "0", "-i", filelistPath,
            "-c:v", "copy",
            "-c:a", "aac", "-ar", "44100", "-ac", "2",
            "-movflags", "+faststart",
            outPath,
          ], { timeout: 600_000, maxBuffer: 500 * 1024 * 1024 });

          const buffer = await readFile(outPath);
          const destVar = varNames[0]!;
          vars[destVar] = { kind: "buf", buffer, ext: ".mp4", mediaType: "video" };
          lastMedia = { type: "media", buffer, ext: ".mp4" };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `[imagescript concatmultiple error: ${msg.slice(0, 400)}]`;
      } finally {
        await rm(concatTmpDir, { recursive: true, force: true }).catch(() => {});
      }
      continue;
    }

    // ── join <var1> <var2> [dest] ─────────────────────────────────────────────
    if (cmd === "join") {
      const var1 = tokens[1] ?? "i";
      const var2 = tokens[2] ?? "i2";
      const destVar = tokens[3] ?? var1;
      const src1 = vars[var1];
      const src2 = vars[var2];
      if (!src1) return `[imagescript: undefined variable "${var1}"]`;
      if (!src2) return `[imagescript: undefined variable "${var2}"]`;
      try {
        let buf1: Buffer, ext1: string;
        if (src1.kind === "buf") {
          buf1 = src1.buffer; ext1 = src1.ext;
        } else {
          const resp = await axios.get<ArrayBuffer>(src1.url, { responseType: "arraybuffer", timeout: 30_000, headers: { "User-Agent": BROWSER_UA } });
          buf1 = Buffer.from(resp.data);
          ext1 = extname(src1.name) || ".mp4";
        }
        let buf2: Buffer, ext2: string;
        if (src2.kind === "buf") {
          buf2 = src2.buffer; ext2 = src2.ext;
        } else {
          const resp = await axios.get<ArrayBuffer>(src2.url, { responseType: "arraybuffer", timeout: 30_000, headers: { "User-Agent": BROWSER_UA } });
          buf2 = Buffer.from(resp.data);
          ext2 = extname(src2.name) || ".mp4";
        }
        const joined = await joinMediaHStack(buf1, ext1, buf2, ext2);
        const mediaType: import("../effects/processor.js").MediaType =
          [".mp4", ".mov", ".webm", ".mkv"].includes(joined.ext) ? "video" : "image";
        vars[destVar] = { kind: "buf", buffer: joined.buffer, ext: joined.ext, mediaType };
        lastMedia = { type: "media", buffer: joined.buffer, ext: joined.ext };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `[imagescript join error: ${msg.slice(0, 400)}]`;
      }
      continue;
    }

    // ── <effect>[=<params>] <var> [<numparams...>] [<dest>] ─────────────────
    // If the effect name already contains '=' it's the full effects string.
    // Otherwise, trailing numeric tokens become semicolon-joined subparams,
    // and the first non-numeric trailing token (if any) is the destination var.
    {
      let effectsStr = cmd;
      const srcVar = tokens[1] ?? "i";
      let destVar = srcVar;

      if (!effectsStr.includes("=")) {
        const rest = tokens.slice(2);
        const numericParams: string[] = [];
        let destFound = false;
        for (const t of rest) {
          if (/^-?\d+(\.\d+)?$/.test(t)) {
            numericParams.push(t);
          } else {
            destVar = t;
            destFound = true;
            break;
          }
        }
        if (!destFound) destVar = srcVar;
        if (numericParams.length > 0) effectsStr = `${effectsStr}=${numericParams.join(";")}`;
      } else {
        destVar = tokens[2] ?? srcVar;
      }

      const err = await applyEffect(effectsStr, srcVar, destVar);
      if (err) return err;
    }
  }

  return lastMedia ?? "";
}

/**
 * Line-based ImageMagick scripting language for {mediascript:...} tagscript.
 *
 * Syntax:
 *   load <url> <var>              — download URL into variable (use {iv} for attached media)
 *   <effect> <var> [<args...>]    — apply an effect to the variable in place, e.g. `explode image 1`
 *   render <var>                  — output the variable's current file as the final attachment
 *
 * Supported effects:
 *   invert                        → -negate
 *   swirl <deg>                   → -swirl <deg>
 *   explode <n>                   → -implode -<n>
 *   implode <n>                   → -implode <n>
 *   magik                         → -liquid-rescale 50%x50%
 *   hueshifthsv <h> <s> <l>       → -modulate <100+l>,<100+s>,<100+h*200/360>
 *
 * Example:
 *   load {iv} image
 *   explode image 1
 *   hueshifthsv image -130 0 0
 *   render image
 */
export async function runMediascript(code: string): Promise<ScriptResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), "mediascript-"));
  try {
    const vars: Record<string, string> = {};
    let lastVar: string | null = null;
    let opCounter = 0;

    const lines = code
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("#"));

    for (const line of lines) {
      const tokens = line.match(/\S+/g) ?? [];
      if (tokens.length === 0) continue;
      const cmd = tokens[0]!.toLowerCase();

      // ── load <url> <var> ─────────────────────────────────────────────────
      if (cmd === "load") {
        const url = tokens[1] ?? "";
        const varName = tokens[2] ?? "image";
        if (!/^https?:\/\//.test(url)) return `[mediascript: "load" requires a URL, e.g. "load {iv} ${varName}"]`;
        try {
          const resp = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 30_000, headers: { "User-Agent": BROWSER_UA } });
          const ct = String(resp.headers["content-type"] ?? "");
          const rawName = (url.split("?")[0] ?? "").split("/").pop() ?? "";
          let ext = extname(rawName);
          if (!ext) {
            if (ct.includes("png")) ext = ".png";
            else if (ct.includes("gif")) ext = ".gif";
            else if (ct.includes("webp")) ext = ".webp";
            else if (ct.includes("jpeg") || ct.includes("jpg")) ext = ".jpg";
            else ext = ".png";
          }
          const filePath = join(tmpDir, `${varName}${ext}`);
          await writeFile(filePath, Buffer.from(resp.data));
          vars[varName] = filePath;
          lastVar = varName;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `[mediascript: failed to load "${url}": ${msg.slice(0, 200)}]`;
        }
        continue;
      }

      // ── render <var> ──────────────────────────────────────────────────────
      if (cmd === "render") {
        const renderVar = tokens[1] ?? lastVar ?? "";
        const renderPath = vars[renderVar];
        if (!renderPath) return `[mediascript: undefined variable "${renderVar}" — use "load <url> <var>" first]`;
        const buffer = await readFile(renderPath);
        return { type: "media", buffer, ext: extname(renderPath) || ".png" };
      }

      // ── effect commands: <effect> <var> [<args...>] ─────────────────────
      const effVar: string = tokens[1] ?? lastVar ?? "";
      const filePath = vars[effVar];
      if (!filePath) return `[mediascript: undefined variable "${effVar}" — use "load <url> <var>" first]`;
      const args = tokens.slice(2);

      let imArgs: string[];
      switch (cmd) {
        case "invert":
          imArgs = ["-negate"];
          break;
        case "swirl":
          imArgs = ["-swirl", args[0] ?? "50"];
          break;
        case "explode": {
          const n = parseFloat(args[0] ?? "1");
          imArgs = ["-implode", String(-(Number.isFinite(n) ? n : 1))];
          break;
        }
        case "implode":
          imArgs = ["-implode", args[0] ?? "0.5"];
          break;
        case "magik":
          imArgs = ["-liquid-rescale", "50%x50%"];
          break;
        case "hueshifthsv": {
          const h = parseFloat(args[0] ?? "0") || 0;
          const s = parseFloat(args[1] ?? "0") || 0;
          const l = parseFloat(args[2] ?? "0") || 0;
          const hue = Math.trunc(100 + (h * 200) / 360);
          imArgs = ["-modulate", `${100 + l},${100 + s},${hue}`];
          break;
        }
        default:
          return `[mediascript: unknown command "${cmd}"]`;
      }

      try {
        const outPath = join(tmpDir, `out${opCounter++}${extname(filePath)}`);
        await execFileAsync("magick", [filePath, ...imArgs, outPath], { timeout: 60_000, maxBuffer: 100 * 1024 * 1024 });
        vars[effVar] = outPath;
        lastVar = effVar;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `[mediascript error on "${line}": ${msg.slice(0, 400)}]`;
      }
    }

    if (lastVar && vars[lastVar]) {
      const buffer = await readFile(vars[lastVar]);
      return { type: "media", buffer, ext: extname(vars[lastVar]) || ".png" };
    }
    return `[mediascript: nothing to render — add a "render <var>" line]`;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Tagscript engine ──────────────────────────────────────────────────────────

export async function processTagscript(
  script: string,
  args: string[],
  message: Message,
  rawArgs?: string,
): Promise<ScriptResult> {
  let text = script;
  let mediaResult: MediaResult | CombinedResult | null = null;
  const tagVars: Record<string, string> = {};

  // Cached {iv} / {iv1} / {iv2} … resolver — fetches all attachment URLs once and reuses them.
  // Re-applied each loop iteration so {ivN} introduced by arg/set substitutions is resolved.
  let cachedIvUrls: string[] | null = null;
  async function getAllIvUrls(): Promise<string[]> {
    if (cachedIvUrls === null) cachedIvUrls = await resolveAllIvUrls(message);
    return cachedIvUrls;
  }
  async function getIvUrl(): Promise<string> {
    return (await getAllIvUrls())[0] ?? "";
  }

  if (/\{i[va]\d*\}/i.test(text)) {
    const ivUrls = await getAllIvUrls();
    if (/\{i[va](?:1)?\}/i.test(text) && !ivUrls[0]) return "[tag error: {iv}/{av} requires an attached file — attach a file to your message or reply to one with an attachment]";
    text = text.replace(/\{i[va](\d*)\}/gi, (_, n) => {
      const idx = n === "" || n === "1" ? 0 : parseInt(n, 10) - 1;
      return ivUrls[idx] ?? "";
    });
  }

  if (/\{argslen\}/i.test(text)) {
    text = text.replace(/\{argslen\}/gi, String(args.length));
  }

  if (/\{args\}/i.test(text)) {
    text = text.replace(/\{args\}/gi, rawArgs ?? args.join(" "));
  }

  let iterations = 0;
  while (iterations++ < 500) {
    // Re-resolve {iv}/{av}/{iv1}/{iv2}/… in case an arg/set substitution introduced them mid-loop.
    if (/\{i[va]\d*\}/i.test(text)) {
      const ivUrls = await getAllIvUrls();
      if (/\{i[va](?:1)?\}/i.test(text) && !ivUrls[0]) return "[tag error: {iv}/{av} requires an attached file — attach a file to your message or reply to one with an attachment]";
      text = text.replace(/\{i[va](\d*)\}/gi, (_, n) => {
        const idx = n === "" || n === "1" ? 0 : parseInt(n, 10) - 1;
        return ivUrls[idx] ?? "";
      });
    }

    if (/\{argslen\}/i.test(text)) {
      text = text.replace(/\{argslen\}/gi, String(args.length));
    }

    if (/\{args\}/i.test(text)) {
      text = text.replace(/\{args\}/gi, rawArgs ?? args.join(" "));
    }

    // Expand {foreach:N|template} count-based blocks before inner tags are consumed.
    const expanded = expandCountForeach(text);
    if (expanded.changed) {
      text = expanded.text;
      continue;
    }

    // Expand block-style {if:cond}...{elif:cond}...{else}...{/if} constructs.
    // Runs before code blocks so a false branch's code never executes.
    // Conditions with unresolved {get:}/{arg:} etc. contain braces and are
    // skipped here; INNERMOST_TAG_RE resolves them first, then we retry.
    const blockIfResult = expandBlockIf(text);
    if (blockIfResult.changed) {
      text = blockIfResult.text;
      continue;
    }

    // ── Innermost tag resolution (runs BEFORE code block extraction) ──────────
    // INNERMOST_TAG_RE matches tags with no nested braces inside, e.g. {arg:0},
    // {or:|27.5}, {math:2+2}.  Running this first means substitution tags inside
    // code blocks like {sh:...{or:{arg:0}|27.5}...} are fully resolved to plain
    // values before the code block is extracted and executed.
    const match = INNERMOST_TAG_RE.exec(text);
    if (match) {
      const [full, tag, content] = match as unknown as [string, string, string];
      let replacement = "";

      switch (tag) {
        case "arg": {
          const pipeIdx = content.indexOf("|");
          const key = (pipeIdx === -1 ? content : content.slice(0, pipeIdx)).trim();
          const fallback = pipeIdx === -1 ? null : content.slice(pipeIdx + 1);
          if (key === "*") {
            const sep = fallback ?? null;
            replacement = sep !== null
              ? (args.length > 0 ? args.join(sep) : "")
              : (rawArgs ?? args.join(" "));
          } else if (key.endsWith("+")) {
            const idx = parseInt(key.slice(0, -1), 10);
            const slice = isNaN(idx) ? [] : args.slice(idx);
            replacement = slice.length > 0 ? slice.join(" ") : (fallback ?? "");
          } else {
            const idx = parseInt(key, 10);
            const val = isNaN(idx) ? "" : (args[idx] ?? "");
            replacement = val !== "" ? val : (fallback ?? "");
          }
          break;
        }
        case "math": {
          replacement = evalInVm(content.trim());
          break;
        }
        case "set": {
          const pipeIdx = content.indexOf("|");
          if (pipeIdx !== -1) {
            const varName = content.slice(0, pipeIdx).trim();
            const varValue = content.slice(pipeIdx + 1);
            if (varName) tagVars[varName] = varValue;
          }
          replacement = "";
          break;
        }
        case "get": {
          replacement = tagVars[content.trim()] ?? "";
          break;
        }
        case "if": {
          const thenKw = content.indexOf("|then:");
          if (thenKw !== -1) {
            const condPart = content.slice(0, thenKw);
            const condParts = condPart.split("|");
            let ifA: string, ifOp: string, ifB: string;
            if (condParts[0] === "" && condParts.length >= 3) {
              // Leading | syntax: {if:|VALUE|TARGET|then:...} → equality check
              ifA = condParts[1] ?? "";
              ifOp = "=";
              ifB = condParts[2] ?? "";
            } else {
              ifA = condParts[0] ?? "";
              ifOp = (condParts[1] ?? "=").trim();
              ifB = condParts[2] ?? "";
            }
            const afterThen = content.slice(thenKw + "|then:".length);
            const elseKw = afterThen.indexOf("|else:");
            const thenVal = elseKw === -1 ? afterThen : afterThen.slice(0, elseKw);
            const elseVal = elseKw === -1 ? "" : afterThen.slice(elseKw + "|else:".length);
            let condResult: boolean;
            const numA = parseFloat(ifA), numB = parseFloat(ifB);
            switch (ifOp) {
              case "=": case "==": condResult = ifA === ifB; break;
              case "!=": case "!==": condResult = ifA !== ifB; break;
              case ">": condResult = numA > numB; break;
              case "<": condResult = numA < numB; break;
              case ">=": condResult = numA >= numB; break;
              case "<=": condResult = numA <= numB; break;
              default: condResult = ifA === ifB;
            }
            replacement = condResult ? thenVal : elseVal;
          } else {
            const firstPipe = content.indexOf("|");
            if (firstPipe === -1) { replacement = ""; break; }
            const condition = content.slice(0, firstPipe);
            const ifRest = content.slice(firstPipe + 1);
            const secondPipe = ifRest.indexOf("|");
            const thenVal = secondPipe === -1 ? ifRest : ifRest.slice(0, secondPipe);
            const elseVal = secondPipe === -1 ? "" : ifRest.slice(secondPipe + 1);
            replacement = evalCondition(condition) ? thenVal : elseVal;
          }
          break;
        }
        case "replace": {
          const parts = content.split("|");
          const find = parts[0] ?? "";
          const rep  = parts[1] ?? "";
          const src  = parts[2] ?? "";
          replacement = find ? src.split(find).join(rep) : src;
          break;
        }
        case "upper": replacement = content.toUpperCase(); break;
        case "lower": replacement = content.toLowerCase(); break;
        case "len":   replacement = String(content.length); break;
        case "choose": {
          const options = content.split("|");
          replacement = options[Math.floor(Math.random() * options.length)] ?? "";
          break;
        }
        case "or": {
          const pipeIdx = content.indexOf("|");
          if (pipeIdx === -1) { replacement = content; break; }
          const val = content.slice(0, pipeIdx);
          const fallback = content.slice(pipeIdx + 1);
          replacement = val.trim() !== "" ? val : fallback;
          break;
        }
        case "repeat": {
          const colonIdx = content.indexOf(":");
          if (colonIdx === -1) { replacement = ""; break; }
          const n = Math.min(Math.max(parseInt(content.slice(0, colonIdx).trim(), 10) || 0, 0), 500);
          const repeatText = content.slice(colonIdx + 1);
          replacement = repeatText.repeat(n);
          break;
        }
        case "range": {
          const rangeParts = content.split("|");
          const rMin = parseFloat(rangeParts[0]?.trim() ?? "0");
          const rMax = parseFloat(rangeParts[1]?.trim() ?? "1");
          if (isNaN(rMin) || isNaN(rMax)) { replacement = "[range error: invalid numbers]"; break; }
          const lo = Math.min(rMin, rMax);
          const hi = Math.max(rMin, rMax);
          const isInt = Number.isInteger(rMin) && Number.isInteger(rMax);
          replacement = isInt
            ? String(Math.floor(Math.random() * (hi - lo + 1)) + lo)
            : String((Math.random() * (hi - lo) + lo).toFixed(4));
          break;
        }
        case "foreach": {
          const pipeIdx = content.indexOf("|");
          if (pipeIdx === -1) { replacement = ""; break; }
          let template = content.slice(0, pipeIdx);
          const items = content.slice(pipeIdx + 1).split("|");
          let sep = "\n";
          const tildeIdx = template.indexOf("~");
          if (tildeIdx !== -1) {
            sep = template.slice(0, tildeIdx).replace(/\\n/g, "\n").replace(/\\t/g, "\t");
            template = template.slice(tildeIdx + 1);
          }
          replacement = items.map((item) => template.replace(/@/g, item)).join(sep);
          break;
        }
        case "substring": {
          const parts = content.split("|");
          const src = parts[0] ?? "";
          const start = parseInt(parts[1] ?? "0", 10) || 0;
          const end = parts[2] !== undefined ? parseInt(parts[2], 10) : undefined;
          replacement = end !== undefined ? src.substring(start, end) : src.substring(start);
          break;
        }
        case "indexof": {
          const pipeIdx2 = content.indexOf("|");
          if (pipeIdx2 === -1) { replacement = "-1"; break; }
          const needle = content.slice(0, pipeIdx2);
          const haystack = content.slice(pipeIdx2 + 1);
          replacement = String(haystack.indexOf(needle));
          break;
        }
        case "tag": {
          const tname = content.trim().toLowerCase();
          const tentry = loadTags()[tname];
          if (!tentry) { replacement = `[tag: "${tname}" not found]`; break; }
          const subTagResult = await processTagscript(tentry.script, args, message, rawArgs);
          if (typeof subTagResult !== "string") { mediaResult = subTagResult; replacement = ""; }
          else replacement = subTagResult;
          break;
        }
        case "imagescript":
        case "iscript": {
          const result = await runImagescript(content);
          if (typeof result !== "string") { mediaResult = result; replacement = ""; }
          else replacement = result;
          break;
        }
        case "mediascript": {
          const msResult = await runMediascript(content);
          if (typeof msResult !== "string") { mediaResult = msResult; replacement = ""; }
          else replacement = msResult;
          break;
        }
        case "attach": {
          const url = content.trim();
          if (/^https?:\/\//.test(url)) {
            try {
              const resp = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 30_000, headers: { "User-Agent": BROWSER_UA } });
              const rawName = (url.split("?")[0] ?? "file").split("/").pop() ?? "file";
              const ext = extname(rawName) || ".mp4";
              mediaResult = { type: "media", buffer: Buffer.from(resp.data), ext };
              replacement = "";
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              replacement = `[attach: failed to download — ${msg.slice(0, 200)}]`;
            }
          } else {
            replacement = "[attach: invalid URL]";
          }
          break;
        }
        case "js": {
          const jsUrls = await getAllIvUrls();
          if (jsUrls.length > 0) {
            const { env: jsEnv, cleanup: jsCleanup } = await downloadAttachmentsToEnv(jsUrls);
            try { replacement = await runSubprocess("node", ["--input-type=module"], content, jsEnv); }
            finally { await jsCleanup(); }
          } else {
            replacement = await runSubprocess("node", ["--input-type=module"], content);
          }
          break;
        }
        case "ts": {
          const tsUrls = await getAllIvUrls();
          if (tsUrls.length > 0) {
            const { env: tsEnv, cleanup: tsCleanup } = await downloadAttachmentsToEnv(tsUrls);
            try { replacement = await runSubprocess("node", [RUN_TS_SCRIPT], content, tsEnv); }
            finally { await tsCleanup(); }
          } else {
            replacement = await runSubprocess("node", [RUN_TS_SCRIPT], content);
          }
          break;
        }
        case "py": {
          const pyUrls = await getAllIvUrls();
          if (pyUrls.length > 0) {
            const { env: pyEnvExtra, cleanup: pyCleanup } = await downloadAttachmentsToEnv(pyUrls);
            let pyResult: ScriptResult;
            try { pyResult = await runPythonWithFiles(content, pyEnvExtra); }
            finally { await pyCleanup(); }
            if (typeof pyResult! === "string") replacement = pyResult!;
            else { mediaResult = pyResult!; replacement = ""; }
          } else {
            const pyResult = await runPythonWithFiles(content);
            if (typeof pyResult === "string") replacement = pyResult;
            else { mediaResult = pyResult; replacement = ""; }
          }
          break;
        }
        case "sh": {
          const shAttachUrls = await getAllIvUrls();
          const loadLines = shAttachUrls.map((u) => `load ${u}`).join("\n");
          const shScript = loadLines ? `${loadLines}\n${content}` : content;
          const shResult = await runShellWithFiles(shScript);
          if (typeof shResult === "string") replacement = shResult;
          else { mediaResult = shResult; replacement = ""; }
          break;
        }
        case "runcodetxt": {
          const rcUrl = content.trim();
          if (/^https?:\/\//.test(rcUrl)) {
            try {
              const rcResp = await axios.get<string>(rcUrl, { responseType: "text", timeout: 15_000, headers: { "User-Agent": BROWSER_UA } });
              const rcRaw = typeof rcResp.data === "string" ? rcResp.data : String(rcResp.data);
              const rcProcessed = await processTagscript(rcRaw, args, message, rawArgs);
              if (typeof rcProcessed === "string") replacement = rcProcessed;
              else if (rcProcessed.type === "combined") { mediaResult = { type: "media", buffer: rcProcessed.buffer, ext: rcProcessed.ext }; replacement = rcProcessed.text; }
              else { mediaResult = rcProcessed; replacement = ""; }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              replacement = `[runcodetxt: failed to fetch — ${msg.slice(0, 200)}]`;
            }
          } else {
            replacement = "[runcodetxt: invalid URL]";
          }
          break;
        }
        case "ihtx": {
          const [effectsStr = "", repStr = "1", durStr = ""] = content.split("|");
          const rep = Math.min(Math.max(parseInt(repStr.trim(), 10) || 1, 1), 200);
          const dur = durStr.trim() ? parseFloat(durStr.trim()) || null : null;

          const allAttachments = [...message.attachments.values()];
          let inputUrl: string | null = allAttachments[0]?.url ? toCdnUrl(allAttachments[0].url) : null;
          let inputName: string = allAttachments[0]?.name ?? "";
          let inputCT: string = allAttachments[0]?.contentType ?? "";

          if (!inputUrl && message.reference?.messageId) {
            try {
              const refMsg = await message.channel.messages.fetch(message.reference.messageId);
              const refAttach = [...refMsg.attachments.values()][0] ?? null;
              inputUrl = refAttach?.url ? toCdnUrl(refAttach.url) : null;
              inputName = refAttach?.name ?? "";
              inputCT = refAttach?.contentType ?? "";
            } catch { /* fall through */ }
          }

          if (!inputUrl) { replacement = "[ihtx: no media attached — attach a file to your message or reply to one]"; break; }

          const inputExt = extname(inputName) || ".jpg";
          const mediaType = detectMediaType(inputName, inputCT);
          const effects = parseEffectsString(effectsStr.trim());
          const result = await processMedia({ effects, rep, dur, inputUrl, inputExt, mediaType });
          mediaResult = { type: "media", buffer: result.buffer, ext: result.ext };
          replacement = "";
          break;
        }
        case "ihtxffmpeg": {
          const p1 = content.indexOf("|");
          if (p1 === -1) { replacement = "[ihtxffmpeg: missing parameters]"; break; }
          const p2 = content.indexOf("|", p1 + 1);
          if (p2 === -1) { replacement = "[ihtxffmpeg: missing effect parameter]"; break; }
          const powersStr = content.slice(0, p1).trim();
          const durStr2   = content.slice(p1 + 1, p2).trim();
          const effect    = content.slice(p2 + 1).trim();
          const powers = Math.min(Math.max(parseInt(powersStr, 10) || 1, 1), 50);
          const durNum = durStr2 && durStr2 !== "vidlen" ? parseFloat(durStr2) : NaN;
          const durFlag = !isNaN(durNum) && durNum > 0 ? `-t ${durNum}` : "";
          const loopFlag = durFlag ? "-stream_loop -1" : "";
          const normArgs = `-c:v libx264 -preset ultrafast -crf 23 -c:a aac -ar 44100 -ac 2 -movflags +faststart`;
          const ivUrlFf = await getIvUrl();
          if (!ivUrlFf) { replacement = "[ihtxffmpeg: no media attached]"; break; }
          const scriptLines2: string[] = [`load ${ivUrlFf}`];
          scriptLines2.push(`sr=$(ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate -of default=nokey=1:noprint_wrappers=1 "$FILE_1")`);
          scriptLines2.push(`fr=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=nokey=1:noprint_wrappers=1 "$FILE_1")`);
          scriptLines2.push(`d=$(ffprobe -i "$FILE_1" -show_entries format=duration -v quiet -of csv="p=0")`);
          scriptLines2.push(`w=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of default=nw=1:nk=1 "$FILE_1")`);
          scriptLines2.push(`h=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=nw=1:nk=1 "$FILE_1")`);
          scriptLines2.push(`fc=$(ffprobe -v error -select_streams v:0 -show_entries stream=nb_frames -of default=nokey=1:noprint_wrappers=1 "$FILE_1")`);
          scriptLines2.push(`ffmpeg -y ${loopFlag} -i "$FILE_1" ${durFlag} ${effect} ${normArgs} 1.mp4`);
          for (let i = 2; i <= powers; i++) scriptLines2.push(`ffmpeg -y ${loopFlag} -i "${i - 1}.mp4" ${durFlag} ${effect} ${normArgs} ${i}.mp4`);
          for (let i = 1; i <= powers; i++) scriptLines2.push(`echo "file '${i}.mp4'" ${i === 1 ? ">" : ">>"} filelist.txt`);
          scriptLines2.push(`ffmpeg -y -f concat -safe 0 -i filelist.txt -c:v copy -c:a aac -ar 44100 -ac 2 -movflags +faststart ./output/ihtx_custom.mp4`);
          const ihtxR = await runShellWithFiles(scriptLines2.join("\n"));
          if (typeof ihtxR === "string") replacement = ihtxR;
          else { mediaResult = ihtxR; replacement = ""; }
          break;
        }
        case "veb": {
          const vebEffects = content.trim();
          const vebIvUrl = await getIvUrl();
          if (!vebIvUrl) { replacement = "[veb: no media attached — attach a file or reply to one]"; break; }
          const vebTmpDir = await mkdtemp(join(tmpdir(), "tagveb-"));
          try {
            const rawName = (vebIvUrl.split("?")[0] ?? "file").split("/").pop() ?? "file";
            const vebExt = extname(rawName) || ".mp4";
            const inputPath = join(vebTmpDir, `input${vebExt}`);
            const vebResp = await axios.get<ArrayBuffer>(vebIvUrl, { responseType: "arraybuffer", timeout: 60_000, headers: { "User-Agent": BROWSER_UA } });
            await writeFile(inputPath, Buffer.from(vebResp.data));
            const vebPyScript = join(dirname(fileURLToPath(import.meta.url)), "videoEdit.py");
            let vebOut = "";
            let vebErr = "";
            try {
              const vebResult = await execFileAsync(
                "python3", [vebPyScript, vebEffects, inputPath, vebTmpDir],
                { timeout: 5 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
              );
              vebOut = vebResult.stdout.trim();
              vebErr = vebResult.stderr.trim();
            } catch (vebExecErr) {
              const e = vebExecErr as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
              vebOut = (e.stdout ?? "").trim();
              vebErr = (e.stderr ?? "").trim();
              const errMsg = vebErr || vebOut || (vebExecErr instanceof Error ? vebExecErr.message : String(vebExecErr));
              replacement = `[veb: failed — ${errMsg.slice(0, 300)}]`;
              break;
            }
            const vebOutPath = (vebOut.split("\n").pop() ?? "").trim();
            if (!vebOutPath) { replacement = `[veb: no output — ${(vebErr || "(no stderr)").slice(0, 200)}]`; break; }
            const vebBuf = await readFile(vebOutPath);
            mediaResult = { type: "media", buffer: vebBuf, ext: extname(vebOutPath) || ".mp4" };
            replacement = "";
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            replacement = `[veb: error — ${msg.slice(0, 300)}]`;
          } finally {
            await rm(vebTmpDir, { recursive: true, force: true }).catch(() => {});
          }
          break;
        }
      }

      text = text.slice(0, match.index) + replacement + text.slice(match.index + full.length);
      continue;
    }

    // ── Balanced-brace extraction for code blocks ─────────────────────────────
    // Runs only when INNERMOST_TAG_RE found nothing — meaning any remaining
    // substitution tags have already been resolved, but the code block content
    // still contains literal bash/JS/Python braces (e.g. ${var}, if []; then {}).
    const codeBlock = extractCodeBlock(text);
    if (codeBlock) {
      const { tag: cbTag, content: cbContent, startIdx: cbStart, endIdx: cbEnd } = codeBlock;
      let cbReplacement = "";
      switch (cbTag) {
        case "imagescript":
        case "iscript": {
          const r = await runImagescript(cbContent);
          if (typeof r !== "string") { mediaResult = r; cbReplacement = ""; }
          else cbReplacement = r;
          break;
        }
        case "mediascript": {
          const msResult = await runMediascript(cbContent);
          if (typeof msResult !== "string") { mediaResult = msResult; cbReplacement = ""; }
          else cbReplacement = msResult;
          break;
        }
        case "attach": {
          const url = cbContent.trim();
          if (/^https?:\/\//.test(url)) {
            try {
              const resp = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 30_000, headers: { "User-Agent": BROWSER_UA } });
              const rawName = (url.split("?")[0] ?? "file").split("/").pop() ?? "file";
              const ext = extname(rawName) || ".mp4";
              mediaResult = { type: "media", buffer: Buffer.from(resp.data), ext };
              cbReplacement = "";
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              cbReplacement = `[attach: failed to download — ${msg.slice(0, 200)}]`;
            }
          } else {
            cbReplacement = "[attach: invalid URL]";
          }
          break;
        }
        case "js": {
          const jsUrls = await getAllIvUrls();
          if (jsUrls.length > 0) {
            const { env: jsEnv, cleanup: jsCleanup } = await downloadAttachmentsToEnv(jsUrls);
            try { cbReplacement = await runSubprocess("node", ["--input-type=module"], cbContent, jsEnv); }
            finally { await jsCleanup(); }
          } else {
            cbReplacement = await runSubprocess("node", ["--input-type=module"], cbContent);
          }
          break;
        }
        case "ts": {
          const tsUrls2 = await getAllIvUrls();
          if (tsUrls2.length > 0) {
            const { env: tsEnv2, cleanup: tsCleanup2 } = await downloadAttachmentsToEnv(tsUrls2);
            try { cbReplacement = await runSubprocess("node", [RUN_TS_SCRIPT], cbContent, tsEnv2); }
            finally { await tsCleanup2(); }
          } else {
            cbReplacement = await runSubprocess("node", [RUN_TS_SCRIPT], cbContent);
          }
          break;
        }
        case "py": {
          const pyUrls = await getAllIvUrls();
          if (pyUrls.length > 0) {
            const { env: pyEnvExtra2, cleanup: pyCleanup2 } = await downloadAttachmentsToEnv(pyUrls);
            let pyResult2: ScriptResult;
            try { pyResult2 = await runPythonWithFiles(cbContent, pyEnvExtra2); }
            finally { await pyCleanup2(); }
            if (typeof pyResult2! === "string") cbReplacement = pyResult2!;
            else { mediaResult = pyResult2!; cbReplacement = ""; }
          } else {
            const pyResult2 = await runPythonWithFiles(cbContent);
            if (typeof pyResult2 === "string") cbReplacement = pyResult2;
            else { mediaResult = pyResult2; cbReplacement = ""; }
          }
          break;
        }
        case "sh": {
          const shAttachUrls = await getAllIvUrls();
          const loadLines = shAttachUrls.map((u) => `load ${u}`).join("\n");
          const shScript = loadLines ? `${loadLines}\n${cbContent}` : cbContent;
          const shResult = await runShellWithFiles(shScript);
          if (typeof shResult === "string") cbReplacement = shResult;
          else { mediaResult = shResult; cbReplacement = ""; }
          break;
        }
        case "ihtxffmpeg": {
          const p1 = cbContent.indexOf("|");
          if (p1 === -1) { cbReplacement = "[ihtxffmpeg: missing parameters]"; break; }
          const p2 = cbContent.indexOf("|", p1 + 1);
          if (p2 === -1) { cbReplacement = "[ihtxffmpeg: missing effect parameter]"; break; }
          const powersStr = cbContent.slice(0, p1).trim();
          const durStr = cbContent.slice(p1 + 1, p2).trim();
          const effect = cbContent.slice(p2 + 1).trim();
          const powers = Math.min(Math.max(parseInt(powersStr, 10) || 1, 1), 50);
          const durNum = durStr && durStr !== "vidlen" ? parseFloat(durStr) : NaN;
          const durFlag = !isNaN(durNum) && durNum > 0 ? `-t ${durNum}` : "";
          const loopFlag = durFlag ? "-stream_loop -1" : "";
          const normArgs = `-c:v libx264 -preset ultrafast -crf 23 -c:a aac -ar 44100 -ac 2 -movflags +faststart`;
          const ivUrl2 = await getIvUrl();
          if (!ivUrl2) { cbReplacement = "[ihtxffmpeg: no media attached]"; break; }
          const scriptLines2: string[] = [`load ${ivUrl2}`];
          scriptLines2.push(`sr=$(ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate -of default=nokey=1:noprint_wrappers=1 "$FILE_1")`);
          scriptLines2.push(`fr=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=nokey=1:noprint_wrappers=1 "$FILE_1")`);
          scriptLines2.push(`d=$(ffprobe -i "$FILE_1" -show_entries format=duration -v quiet -of csv="p=0")`);
          scriptLines2.push(`w=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of default=nw=1:nk=1 "$FILE_1")`);
          scriptLines2.push(`h=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=nw=1:nk=1 "$FILE_1")`);
          scriptLines2.push(`fc=$(ffprobe -v error -select_streams v:0 -show_entries stream=nb_frames -of default=nokey=1:noprint_wrappers=1 "$FILE_1")`);
          scriptLines2.push(`ffmpeg -y ${loopFlag} -i "$FILE_1" ${durFlag} ${effect} ${normArgs} 1.mp4`);
          for (let i = 2; i <= powers; i++) scriptLines2.push(`ffmpeg -y ${loopFlag} -i "${i - 1}.mp4" ${durFlag} ${effect} ${normArgs} ${i}.mp4`);
          for (let i = 1; i <= powers; i++) scriptLines2.push(`echo "file '${i}.mp4'" ${i === 1 ? ">" : ">>"} filelist.txt`);
          scriptLines2.push(`ffmpeg -y -f concat -safe 0 -i filelist.txt -c:v copy -c:a aac -ar 44100 -ac 2 -movflags +faststart ./output/ihtx_custom.mp4`);
          const ihtxR = await runShellWithFiles(scriptLines2.join("\n"));
          if (typeof ihtxR === "string") cbReplacement = ihtxR;
          else { mediaResult = ihtxR; cbReplacement = ""; }
          break;
        }
        case "eval":
        case "ignore": {
          const evalCbResult = await processTagscript(cbContent, args, message, rawArgs);
          if (typeof evalCbResult !== "string") { mediaResult = evalCbResult; cbReplacement = ""; }
          else cbReplacement = evalCbResult;
          break;
        }
        case "runcodetxt": {
          const rcUrl = cbContent.trim();
          if (/^https?:\/\//.test(rcUrl)) {
            try {
              const rcResp = await axios.get<string>(rcUrl, { responseType: "text", timeout: 15_000, headers: { "User-Agent": BROWSER_UA } });
              const rcRaw = typeof rcResp.data === "string" ? rcResp.data : String(rcResp.data);
              const rcProcessed = await processTagscript(rcRaw, args, message, rawArgs);
              if (typeof rcProcessed === "string") cbReplacement = rcProcessed;
              else if (rcProcessed.type === "combined") { mediaResult = { type: "media", buffer: rcProcessed.buffer, ext: rcProcessed.ext }; cbReplacement = rcProcessed.text; }
              else { mediaResult = rcProcessed; cbReplacement = ""; }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              cbReplacement = `[runcodetxt: failed to fetch — ${msg.slice(0, 200)}]`;
            }
          } else {
            cbReplacement = "[runcodetxt: invalid URL]";
          }
          break;
        }
        default:
          cbReplacement = "";
      }
      text = text.slice(0, cbStart) + cbReplacement + text.slice(cbEnd + 1);
      continue;
    }

    // Neither INNERMOST_TAG_RE nor extractCodeBlock matched — done.
    break;
  }

  // Resolve bare {tagname} references — any remaining {word} treated as a tag call.
  {
    const allTags = loadTags();
    let bareScan = 0;
    let bareIter = 0;
    while (bareIter++ < 200) {
      BARE_TAG_RE.lastIndex = bareScan;
      const bm = BARE_TAG_RE.exec(text);
      if (!bm) break;
      const bareName = bm[1]!.toLowerCase();
      const bareEntry = allTags[bareName];
      if (!bareEntry) {
        bareScan = bm.index + bm[0].length;
        continue;
      }
      const bareSub = await processTagscript(bareEntry.script, args, message, rawArgs);
      if (typeof bareSub !== "string") {
        mediaResult = bareSub;
        text = text.slice(0, bm.index) + text.slice(bm.index + bm[0].length);
      } else {
        text = text.slice(0, bm.index) + bareSub + text.slice(bm.index + bm[0].length);
      }
      bareScan = 0;
    }
  }

  // If both text and media exist, combine them into a single reply.
  const trimmedText = text.trim();
  if (mediaResult && trimmedText) {
    if (mediaResult.type === "media") {
      return { type: "combined", text: trimmedText, buffer: mediaResult.buffer, ext: mediaResult.ext };
    }
    // Already combined — prepend our text
    return { type: "combined", text: trimmedText + "\n" + mediaResult.text, buffer: mediaResult.buffer, ext: mediaResult.ext };
  }

  return mediaResult ?? trimmedText;
}

// ── Discord URL → Catbox mirror ───────────────────────────────────────────────
// Replaces Discord CDN URLs in a tag script with permanent Catbox URLs so that
// deleting the original Discord message never breaks the tag.

const DISCORD_URL_RE = /https?:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/[^\s"')>]+/g;

async function mirrorDiscordUrls(
  script: string,
  uploadToCatbox: (buf: Buffer, name: string) => Promise<string>,
): Promise<{ script: string; replaced: number; failed: number }> {
  const matches = [...new Set(script.match(DISCORD_URL_RE) ?? [])];
  if (matches.length === 0) return { script, replaced: 0, failed: 0 };

  let replaced = 0;
  let failed = 0;

  for (const url of matches) {
    try {
      const resp = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 30_000 });
      const rawName = (url.split("?")[0] ?? "file").split("/").pop() ?? "file";
      const ext = extname(rawName) || ".mp4";
      const catboxUrl = await uploadToCatbox(Buffer.from(resp.data), `tag_mirror${ext}`);
      script = script.split(url).join(catboxUrl);
      replaced++;
    } catch {
      failed++;
    }
  }

  return { script, replaced, failed };
}

// ── Command Handler ───────────────────────────────────────────────────────────

export async function handleTagCommand(
  message: Message,
  uploadToCatbox: (buf: Buffer, name: string) => Promise<string>,
): Promise<void> {
  if (message.author.bot) return;

  const raw = message.content.trim();
  const prefixMatch = /^&(?:tag|t)(?:\s+(.*))?$/s.exec(raw);
  if (!prefixMatch) return;

  const rest = (prefixMatch[1] ?? "").trim();
  const tags = loadTags();
  const now = new Date().toISOString();

  // ── &tag add <name> <script> ──────────────────────────────────────────────
  if (/^add\s/i.test(rest)) {
    const addRest = rest.slice(4).trim();
    const spaceIdx = addRest.search(/\s/);
    if (spaceIdx === -1) {
      await message.reply("❌ Usage: `&tag add <name> <script>`\nExample: `&tag add testcode {eval:{arg:0}}`");
      return;
    }
    const name = addRest.slice(0, spaceIdx).toLowerCase().trim();
    const script = addRest.slice(spaceIdx + 1).trim();

    if (!name || !script) {
      await message.reply("❌ Usage: `&tag add <name> <script>`");
      return;
    }
    if (RESERVED.has(name)) {
      await message.reply(`❌ \`${name}\` is a reserved keyword and cannot be used as a tag name.`);
      return;
    }

    // Mirror any Discord CDN URLs to Catbox so they survive message deletion.
    const mirrorStatus = await message.reply(`⏳ Saving tag \`${name}\`…`);
    const mirrored = await mirrorDiscordUrls(script, uploadToCatbox);
    const finalScript = mirrored.script;
    const mirrorNote = mirrored.replaced > 0
      ? ` (${mirrored.replaced} Discord URL${mirrored.replaced !== 1 ? "s" : ""} permanently archived)`
      : mirrored.failed > 0
        ? ` ⚠️ ${mirrored.failed} Discord URL${mirrored.failed !== 1 ? "s" : ""} could not be archived — they may stop working if the source message is deleted`
        : "";

    const existing = tags[name];
    if (existing) {
      const isOwner = existing.ownerId === message.author.id;
      if (!isOwner && !isPrivileged(message)) {
        await mirrorStatus.edit(
          `❌ Tag \`${name}\` already exists and is owned by **${existing.ownerUsername}**.\nOnly the owner or a server moderator can edit it.`,
        );
        return;
      }
      tags[name] = { ...existing, script: finalScript, updatedAt: now };
      saveTags(tags);
      await mirrorStatus.edit(`✅ Tag \`${name}\` updated.${mirrorNote}`);
    } else {
      tags[name] = {
        script: finalScript,
        ownerId: message.author.id,
        ownerUsername: message.author.username,
        createdAt: now,
        updatedAt: now,
      };
      saveTags(tags);
      await mirrorStatus.edit(`✅ Tag \`${name}\` created by **${message.author.username}**.${mirrorNote}`);
    }
    return;
  }

  // ── &tag alias <newname> <existingname> ───────────────────────────────────
  if (/^alias\s/i.test(rest)) {
    const parts = rest.trim().split(/\s+/);
    const newName = parts[1]?.toLowerCase();
    const srcName = parts[2]?.toLowerCase();

    if (!newName || !srcName) {
      await message.reply("❌ Usage: `&tag alias <newname> <existingname>`\nExample: `&tag alias inv invert`");
      return;
    }
    if (RESERVED.has(newName)) {
      await message.reply(`❌ \`${newName}\` is a reserved keyword and cannot be used as a tag name.`);
      return;
    }
    const srcEntry = tags[srcName];
    if (!srcEntry) {
      await message.reply(`❌ Source tag \`${srcName}\` not found. Use \`&tag list\` to see all tags.`);
      return;
    }
    const existing = tags[newName];
    if (existing) {
      const isOwner = existing.ownerId === message.author.id;
      if (!isOwner && !isPrivileged(message)) {
        await message.reply(
          `❌ Tag \`${newName}\` already exists and is owned by **${existing.ownerUsername}**.\nOnly the owner or a server moderator can overwrite it.`,
        );
        return;
      }
    }
    const now = new Date().toISOString();
    tags[newName] = {
      script: `{tag:${srcName}}`,
      ownerId: message.author.id,
      ownerUsername: message.author.username,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    saveTags(tags);
    await message.reply(`✅ Alias \`${newName}\` → \`${srcName}\` created by **${message.author.username}**.`);
    return;
  }

  // ── &tag del/delete/remove <name> ─────────────────────────────────────────
  if (/^(?:del|delete|remove)\s/i.test(rest)) {
    const name = rest.split(/\s+/)[1]?.toLowerCase();
    const existing = name ? tags[name] : undefined;

    if (!name || !existing) {
      await message.reply(`❌ Tag \`${name ?? "(none)"}\` not found. Use \`&tag list\` to see all tags.`);
      return;
    }

    const isOwner = existing.ownerId === message.author.id;
    if (!isOwner && !isPrivileged(message)) {
      await message.reply(
        `❌ Tag \`${name}\` is owned by **${existing.ownerUsername}**.\nOnly the owner or a server moderator can delete it.`,
      );
      return;
    }

    delete tags[name];
    saveTags(tags, true);
    await message.reply(`✅ Tag \`${name}\` deleted.`);
    return;
  }

  // ── &tag forceremove <name> (bot owner only) ──────────────────────────────
  if (/^forceremove\s/i.test(rest)) {
    if (message.author.username !== BOT_OWNER_USERNAME) {
      await message.reply("❌ Only the bot owner can use `forceremove`.");
      return;
    }
    const name = rest.split(/\s+/)[1]?.toLowerCase();
    const existing = name ? tags[name] : undefined;
    if (!name || !existing) {
      await message.reply(`❌ Tag \`${name ?? "(none)"}\` not found.`);
      return;
    }
    delete tags[name];
    saveTags(tags, true);
    await message.reply(`✅ Tag \`${name}\` force-removed (was owned by **${existing.ownerUsername}**).`);
    return;
  }

  // ── &tag list [page] ──────────────────────────────────────────────────────
  if (/^list/i.test(rest) || rest === "") {
    const names = Object.keys(tags).sort((a, b) =>
      new Date(tags[b]!.createdAt).getTime() - new Date(tags[a]!.createdAt).getTime()
    );
    if (names.length === 0) {
      await message.reply("No tags yet. Use `&tag add <name> <script>` to create one.");
      return;
    }

    const PAGE_SIZE = 10;
    const totalPages = Math.ceil(names.length / PAGE_SIZE);

    // Allow &tag list <page>
    const pageArg = parseInt(rest.split(/\s+/)[1] ?? "1", 10);
    let page = isNaN(pageArg) ? 1 : Math.min(Math.max(pageArg, 1), totalPages);

    const buildContent = (p: number) => {
      const slice = names.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
      return [
        `**Tags (${names.length}):**`,
        ...slice.map((n) => `\`${n}\``),
        ``,
        `Page ${p}/${totalPages}`,
      ].join("\n");
    };

    const buildRow = (p: number) =>
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("tag_list_prev")
          .setLabel("◀ Previous")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(p <= 1),
        new ButtonBuilder()
          .setCustomId("tag_list_next")
          .setLabel("Next ▶")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(p >= totalPages),
      );

    const reply = await message.reply({
      content: buildContent(page),
      components: totalPages > 1 ? [buildRow(page)] : [],
    });

    if (totalPages <= 1) return;

    // Listen for button clicks for 2 minutes
    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === message.author.id,
      time: 120_000,
    });

    collector.on("collect", async (i) => {
      if (i.customId === "tag_list_prev") page = Math.max(1, page - 1);
      else if (i.customId === "tag_list_next") page = Math.min(totalPages, page + 1);

      // Reload tags in case they changed
      const freshTags = loadTags();
      const freshNames = Object.keys(freshTags).sort((a, b) =>
        new Date(freshTags[b]!.createdAt).getTime() - new Date(freshTags[a]!.createdAt).getTime()
      );
      const freshTotal = Math.ceil(freshNames.length / PAGE_SIZE);
      page = Math.min(page, freshTotal);

      const freshContent = [
        `**Tags (${freshNames.length}):**`,
        ...freshNames.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((n) => `\`${n}\``),
        ``,
        `Page ${page}/${freshTotal}`,
      ].join("\n");

      await i.update({
        content: freshContent,
        components: [buildRow(page)],
      });
    });

    collector.on("end", async () => {
      await reply.edit({ components: [] }).catch(() => {});
    });

    return;
  }

  // ── &tag search <query> ───────────────────────────────────────────────────
  if (/^search(\s|$)/i.test(rest)) {
    const query = rest.replace(/^search\s*/i, "").toLowerCase().trim();
    if (!query) {
      await message.reply("❌ Provide a search query: `&tag search <query>`");
      return;
    }

    const matches = Object.keys(tags)
      .filter((n) => n.includes(query))
      .sort((a, b) => new Date(tags[b]!.createdAt).getTime() - new Date(tags[a]!.createdAt).getTime());

    if (matches.length === 0) {
      await message.reply(`No tags found matching \`${query}\`.`);
      return;
    }

    const PAGE_SIZE = 10;
    const totalPages = Math.ceil(matches.length / PAGE_SIZE);
    let page = 1;

    const buildSearchContent = (p: number, names: string[]) => {
      const slice = names.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE);
      return [
        `**Search results for \`${query}\` (${names.length}):**`,
        ...slice.map((n) => `\`${n}\``),
        ``,
        `Page ${p}/${Math.ceil(names.length / PAGE_SIZE)}`,
      ].join("\n");
    };

    const buildSearchRow = (p: number, total: number) =>
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("tag_search_prev")
          .setLabel("◀ Previous")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(p <= 1),
        new ButtonBuilder()
          .setCustomId("tag_search_next")
          .setLabel("Next ▶")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(p >= total),
      );

    const reply = await message.reply({
      content: buildSearchContent(page, matches),
      components: totalPages > 1 ? [buildSearchRow(page, totalPages)] : [],
    });

    if (totalPages <= 1) return;

    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === message.author.id,
      time: 120_000,
    });

    collector.on("collect", async (i) => {
      if (i.customId === "tag_search_prev") page = Math.max(1, page - 1);
      else if (i.customId === "tag_search_next") page = Math.min(totalPages, page + 1);
      await i.update({
        content: buildSearchContent(page, matches),
        components: [buildSearchRow(page, totalPages)],
      });
    });

    collector.on("end", async () => {
      await reply.edit({ components: [] }).catch(() => {});
    });

    return;
  }

  // ── &tag info <name> ──────────────────────────────────────────────────────
  if (/^info\s/i.test(rest)) {
    const name = rest.split(/\s+/)[1]?.toLowerCase();
    const entry = name ? tags[name] : undefined;

    if (!name || !entry) {
      await message.reply(`❌ Tag \`${name ?? "(none)"}\` not found.`);
      return;
    }

    const createdDate = new Date(entry.createdAt).toUTCString();
    const updatedDate = new Date(entry.updatedAt).toUTCString();
    const lines = [
      `**Tag \`${name}\`**`,
      `**Owner:** ${entry.ownerUsername} (\`${entry.ownerId}\`)`,
      `**Created:** ${createdDate}`,
      ...(entry.updatedAt !== entry.createdAt ? [`**Updated:** ${updatedDate}`] : []),
      `**Script:**\`\`\`\n${entry.script.slice(0, 1800)}\n\`\`\``,
    ];
    await message.reply(lines.join("\n"));
    return;
  }

  // ── &tag help ─────────────────────────────────────────────────────────────
  if (/^help$/i.test(rest)) {
    const helpText = [
      "&tag / &t — Tag Command",
      "",
      "Management:",
      "&tag add <name> <script>  — create a tag (or edit your own)",
      "&tag del <name>           — delete your tag (mods can delete any)",
      "&tag forceremove <name>   — force-delete any tag (bot owner only)",
      "&tag alias <new> <existing> — create a shorthand alias for an existing tag",
      "&tag info <name>          — show script, owner, and timestamps",
      "&tag list                 — list all tags (paginated, buttons with 10+ tags)",
      "&tag search <query>       — find tags whose names contain the query",
      "",
      "Running:",
      "&tag <name> [arg0] [arg1] ...  — run a tag (attach a file in the same message or reply to one)",
      "&t <name> [args...]            — shorthand alias",
      "&tag random                    — run a randomly picked tag and show its name",
      "",
      "Supported tagscripts:",
      "{arg:n}                   — nth argument (0-indexed)",
      "{arg:n|default}           — nth argument, or 'default' if missing/empty  e.g. {arg:0|0} → 0 when no arg given",
      "{arg:*}                   — all arguments joined by spaces",
      "{arg:*|sep}               — all arguments joined by sep  e.g. {arg:*|*} → '3*4*5' (useful in {math:})",
      "{args}                    — all arguments as a single string (alias for {arg:*})",
      "{argslen}                 — number of arguments  e.g. &t mytag hi hello world -> 3",
      "{set:var|value}           — store value in named variable",
      "{get:var}                 — retrieve named variable",
      "{if:a|op|b|then:x|else:y} — compare a and b with op (=, !=, >, <, >=, <=)",
      "{substring:text|start}    — text.substring(start)  e.g. {substring:hello world|6} -> world",
      "{substring:text|start|end}— text.substring(start, end)",
      "{indexof:needle|haystack} — char index of needle in haystack  e.g. {indexof:lo|hello} -> 3",
      "{foreach:N|template}      — repeat template N times (tagscript in template runs each iteration)",
      "  e.g. {set:#|0}{foreach:3|{set:#|{math:{get:#}+1}}[a{get:#}]} -> [a1][a2][a3]",
      "{math:<expr>}             — evaluate math  e.g. {math:7*2} -> 14",
      "{eval:<tagscript>}        — evaluate content as tagscript and insert the result  e.g. {eval:{arg:0}}",
      "{imagescript:<code>}      — media scripting language: load + ihtx effects + multipitch + speed",
      "  load <url> <var>        — download URL into variable",
      "  copy <var> <dest>       — copy a variable",
      "  join <var1> <var2> [dest] — hstack two variables side by side",
      "  <effect> <var> [param...] — apply &ihtx effect",
      "  pitch/audiopitch <var> <s1> [s2...]",
      "  speed <var> <rate>",
      "  volume <var> <amt>",
      "  vibrato/audiovibrato <var> <freq> [depth]",
      "  audiodestroy <var>",
      "  swaprgba <var> <order>",
      "  tunnel/detunnel <var>",
      "  slide <var> [speed]",
      "  e.g.  load {iv} i / copy i i2 / invert i2 / join i i2 / audiopitch i 3 0",
      "{mediascript:<code>}      — ImageMagick scripting language: load + apply effects + render",
      "  load <url> <var>        — download URL into variable",
      "  render <var>            — output the variable as the final attachment",
      "  invert <var>            — negate colors (-negate)",
      "  swirl <var> <deg>       — swirl distortion (-swirl deg)",
      "  explode <var> <n>       — outward implode (-implode -n)",
      "  implode <var> <n>       — inward implode (-implode n)",
      "  magik <var>             — content-aware liquid rescale (-liquid-rescale 50%x50%)",
      "  hueshifthsv <var> <h> <s> <l> — hue/sat/brightness shift (-modulate)",
      "  e.g.  load {iv} image / explode image 1 / hueshifthsv image -130 0 0 / render image",
      "{tag:<name>}              — inline-run another tag and insert its output  e.g. {tag:invert}",
      "{tagname}                 — shorthand for {tag:tagname}  e.g. {invert}",
      "{attach:<url>}            — download a URL and send it as a Discord file attachment",
      "{js:<code>}               — run Node.js code, returns stdout",
      "{py:<code>}               — run Python 3 code, returns stdout",
      "{sh:<script>}             — run bash; load <url> downloads to $FILE_1; write output to ./output/ to attach",
      "  ffmpeg example:  load https://example.com/clip.mp4  then  ffmpeg -i \"$FILE_1\" -vf negate output/out.mp4",
      "{ihtx:<effects>|<rep>|<dur>} — apply ihtx effects to attached/replied media",
      "{iv} / {iv1}              — URL of the 1st attached or replied-to media file",
      "{iv2}, {iv3}, …           — URL of the 2nd, 3rd, … attachment (works in ALL tagscripts)",
      "{repeat:N:text}           — repeat text N times  e.g. {repeat:3:ha} -> hahaha",
      "{range:min|max}           — random integer between min and max  e.g. {range:1|100} -> 42",
      "                            use decimals for float range  e.g. {range:0.0|1.0} -> 0.7341",
      "{foreach:template|i1|i2|i3} — apply template to each item, join with newline",
      "  @ in template = current item  e.g. {foreach:pitch=@|0|3|7} -> pitch=0 / pitch=3 / pitch=7",
      "  custom separator: prefix with sep~ e.g. {foreach:;~pitch=@|0|3|7} -> pitch=0;pitch=3;pitch=7",
      "",
      "Tags can be nested: {eval:{arg:0}} with arg {math:3+4} -> 7",
    ].join("\n");
    const buf = Buffer.from(helpText, "utf-8");
    const file = new AttachmentBuilder(buf, { name: "tag help.txt" });
    await message.reply({ files: [file] });
    return;
  }

  // ── &tag random ───────────────────────────────────────────────────────────
  let effectiveRest = rest;
  if (/^random$/i.test(rest)) {
    const tagNames = Object.keys(tags);
    if (tagNames.length === 0) {
      await message.reply("No tags yet. Use `&tag add <name> <script>` to create one.");
      return;
    }
    const pick = tagNames[Math.floor(Math.random() * tagNames.length)]!;
    effectiveRest = pick;
    await message.reply(`🎲 Random tag: \`${pick}\``);
  }

  // ── &tag <name> [arg0] [arg1] ... ─────────────────────────────────────────
  const nameMatch = /^(\S+)([\s\S]*)$/.exec(effectiveRest);
  const name = nameMatch?.[1]?.toLowerCase() ?? "";
  const rawArgs = nameMatch?.[2]?.replace(/^\s/, "") ?? "";
  const args = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
  const entry = name ? tags[name] : undefined;

  if (!name || !entry) {
    await message.reply(`❌ Tag \`${name ?? "(none)"}\` not found. Use \`&tag list\` to see all tags.`);
    return;
  }
  // Scripts that start with &ihtx (after arg/math substitution they become ihtx commands)
  // are also slow — show the ⏳ status message for them.
  // Also check rawArgs in case slow tags are passed as arguments (e.g. &t testcode {imagescript:...}).
  const combinedForSlowCheck = entry.script + " " + rawArgs;
  const hasSlowTag = /\{(imagescript|mediascript|ihtx|py|js|sh):/.test(combinedForSlowCheck)
    || /^&ihtx\b/i.test(entry.script.trim());
  let statusMsg: Message | null = null;

  try {
    if (hasSlowTag) {
      statusMsg = await message.reply(`⏳ Running tag \`${name}\`…`);
    }

    const result = await processTagscript(entry.script, args, message, rawArgs);

    // If the tag resolved to a bare `&ihtx <effectsStr> [rep] [dur]` string,
    // execute it as an actual ihtx effect rather than echoing the text back.
    if (typeof result === "string" && /^&ihtx\s/i.test(result.trim())) {
      const ihtxRest = result.trim().slice(5).trim(); // strip "&ihtx"
      const ihtxParts = ihtxRest.split(/\s+/);
      const effectsStr = ihtxParts[0] ?? "";
      const ihtxRep = Math.min(Math.max(parseInt(ihtxParts[1] ?? "1", 10) || 1, 1), 1000);
      const ihtxDur = ihtxParts[2] ? parseFloat(ihtxParts[2]) || null : null;

      // Resolve media: current message attachment → replied message attachment (always cdn URLs)
      const allAttachments = [...message.attachments.values()];
      let inputUrl: string | null = allAttachments[0]?.url ? toCdnUrl(allAttachments[0].url) : null;
      let inputName: string = allAttachments[0]?.name ?? "";
      let inputCT: string = allAttachments[0]?.contentType ?? "";

      if (!inputUrl && message.reference?.messageId) {
        try {
          const refMsg = await message.channel.messages.fetch(message.reference.messageId);
          const refAttach = [...refMsg.attachments.values()][0] ?? null;
          inputUrl = refAttach?.url ? toCdnUrl(refAttach.url) : null;
          inputName = refAttach?.name ?? "";
          inputCT = refAttach?.contentType ?? "";
        } catch { /* fall through */ }
      }

      if (!inputUrl || !effectsStr) {
        const errText = inputUrl
          ? `❌ Tag \`${name}\` produced an empty effects string.`
          : `❌ Tag \`${name}\`: no media attached — attach a file to your message or reply to one.`;
        if (statusMsg) await statusMsg.edit(errText);
        else await message.reply(errText);
        return;
      }

      const inputExt = extname(inputName) || ".jpg";
      const mediaType = detectMediaType(inputName, inputCT);
      const effects = parseEffectsString(effectsStr);

      if (!statusMsg) statusMsg = await message.reply(`⏳ Running tag \`${name}\`…`);

      const ihtxResult = await processMedia({ effects, rep: ihtxRep, dur: ihtxDur, inputUrl, inputExt, mediaType });
      const DISCORD_MAX = 8 * 1024 * 1024;
      if (statusMsg) await statusMsg.delete().catch(() => {});
      if (ihtxResult.buffer.length <= DISCORD_MAX) {
        const file = new AttachmentBuilder(ihtxResult.buffer, { name: `tag_${name}${ihtxResult.ext}` });
        await message.reply({ content: `✅ Tag \`${name}\``, files: [file] });
      } else {
        const uploadingMsg = await message.reply("📦 Result too large — uploading to catbox.moe…");
        const catUrl = await uploadToCatbox(ihtxResult.buffer, `tag_${name}${ihtxResult.ext}`);
        await uploadingMsg.edit(`✅ Tag \`${name}\` → ${catUrl}`);
      }
      return;
    }

    if (typeof result === "string") {
      const DISCORD_MAX_CONTENT = 1900;
      const raw = result || "​";
      const output = raw.length > DISCORD_MAX_CONTENT
        ? raw.slice(0, DISCORD_MAX_CONTENT) + "\n… *(truncated)*"
        : raw;
      if (statusMsg) {
        await statusMsg.edit(output);
      } else {
        await message.reply(output);
      }
    } else {
      const DISCORD_MAX = 8 * 1024 * 1024;
      if (statusMsg) await statusMsg.delete().catch(() => {});

      const mediaContent = result.type === "combined"
        ? (result.text.slice(0, 1900) || `✅ Tag \`${name}\``)
        : `✅ Tag \`${name}\``;

      if (result.buffer.length <= DISCORD_MAX) {
        const file = new AttachmentBuilder(result.buffer, { name: `tag_${name}${result.ext}` });
        await message.reply({ content: mediaContent, files: [file] });
      } else {
        const uploadingMsg = await message.reply("📦 Result too large — uploading to catbox.moe…");
        const url = await uploadToCatbox(result.buffer, `tag_${name}${result.ext}`);
        await uploadingMsg.edit(`✅ Tag \`${name}\` → ${url}`);
      }
    }
  } catch (err) {
    logger.error({ err }, "Tag execution failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    const errText = `❌ Tag \`${name}\` failed: \`${msg.slice(0, 300)}\``;
    if (statusMsg) {
      await statusMsg.edit(errText);
    } else {
      await message.reply(errText);
    }
  }
}
