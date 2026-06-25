/**
 * &veb <effects> — videoeditbot-style effects command
 * Processing is delegated to videoEdit.py (Python backend).
 * Effects string is passed through as-is; the Python script handles
 * all parsing, shorthands, and ffmpeg/sox filter application.
 */

import { AttachmentBuilder, Message } from "discord.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import axios from "axios";
import { logger } from "../lib/logger.js";
import { toCdnUrl, uploadToCatbox } from "./catboxupload.js";
import { resolveIv } from "./tag.js";
import { runAutotune } from "../effects/processor.js";

const execFileAsync = promisify(execFile);

const DISCORD_MAX_BYTES = 24 * 1024 * 1024;
const VEB_TIMEOUT_MS    = 5 * 60 * 1000; // 5 minutes
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Absolute path to videoEdit.py — sits next to the compiled index.mjs in dist/. */
const PY_SCRIPT    = join(dirname(fileURLToPath(import.meta.url)), "videoEdit.py");
/** Absolute path to the bundled assets dir (fonts, images, sounds). */
const PY_ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets");

export async function runVeb(message: Message): Promise<void> {
  const raw     = message.content.trim();
  const rest    = raw.slice(raw.toLowerCase().indexOf("&veb") + 4).trim();

  if (!rest) {
    await message.reply(
      "❌ Usage: `&veb <effects>`\n" +
      "Effects are comma-separated. Examples:\n" +
      "• `&veb bass=50,speed=1.5`\n" +
      "• `&veb earrape=80`\n" +
      "• `&veb hflip,invert,reverb=40`\n" +
      "• `&veb deepfry=60,hcycle=30`\n\n" +
      "Supports pipes for effect groups: `&veb effect1|effect2`\n" +
      "Use `repeat=N` (or `rep=N`) to loop the video N times (max 20).\n" +
      "Append `tovid` or `togif` to convert output format.\n\n" +
      "**Shorthands:** `er` `df` `ct` `sp` `bs` `tt` `bt` `ws` `hs` `tc` `bc` " +
      "`hue` `huec` `hypc` `bndc` `nc` `cap` `bcap` `rev` `vrev` `arev` `prev` " +
      "`dm` `st` `ytp` `fe` `defe` `mt` `pch` `rv` `rvd` `hm` `vm` `rc` `sfx` `mus` " +
      "`muss` `musd` `vol` `s` `e` `se` `hf` `delf` `dell` `shk` `cr` `lag` " +
      "`rlag` `wub` `zm` `hcp` `vcp` `hflp` `vflp` `shp` `wtm` `fps` `inv` " +
      "`wav` `wava` `wavs` `hwav` `hwava` `hwavs` `repu` `rep` `boom` `acid` `glch` `atb`",
    );
    return;
  }

  // Check for explicit videourl= / vidurl= named parameter first
  const namedUrlMatch = rest.match(/(?:^|,|\|)\s*(?:videourl|vidurl)\s*=\s*(https?:\/\/\S+)/i);
  const namedUrl = namedUrlMatch?.[1] ?? null;
  const restWithoutNamed = namedUrl
    ? rest.replace(/(?:^|(?<=,|\|))\s*(?:videourl|vidurl)\s*=\s*https?:\/\/\S+/i, "").trim().replace(/^[,|]+|[,|]+$/g, "").trim()
    : rest;

  // Strip any BARE URL (not a key=url value) from the remaining effect string.
  // Negative lookbehind (?<!=) ensures we don't strip URLs that are parameter
  // values, e.g. music=https://... must reach Python intact.
  const inlineUrlMatch = restWithoutNamed.match(/(?<!=)https?:\/\/\S+/);
  const inlineUrl = inlineUrlMatch?.[0] ?? null;
  const effectStr = inlineUrl
    ? restWithoutNamed.replace(inlineUrl, "").replace(/,\s*$|^\s*,/, "").trim()
    : restWithoutNamed;

  // Resolve input URL — explicit videourl= wins; otherwise use {iv} resolution
  // (current message attachment → replied-to attachment → channel history fallback)
  const inputUrl = namedUrl ?? inlineUrl ?? ((await resolveIv(message)) || null);

  if (!inputUrl) {
    await message.reply("❌ Attach a video, image, or audio file, or reply to a message that has one.");
    return;
  }

  const effectLabel = effectStr.slice(0, 120) || "(random)";
  let statusMsg: Message;
  try {
    statusMsg = await message.reply(`⏳ Applying: \`${effectLabel}\`…`);
  } catch { return; }

  const formatTime = (sec: number) =>
    sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const startMs = Date.now();
  const ticker = setInterval(async () => {
    const elapsed = Math.round((Date.now() - startMs) / 1000);
    try {
      await statusMsg.edit({ content: `⏳ Applying: \`${effectLabel}\`… ${formatTime(elapsed)} elapsed` });
    } catch { /* rate-limited or deleted */ }
  }, 5000);

  const tmpDir = await mkdtemp(join(tmpdir(), "veb-"));
  try {
    // Download input file
    const resp = await axios.get<ArrayBuffer>(inputUrl, {
      responseType: "arraybuffer",
      timeout: 60_000,
      headers: { "User-Agent": BROWSER_UA },
    });

    // Resolve extension: prefer Content-Type header over URL filename,
    // so images (PNG/JPG/GIF/WEBP) are handled correctly even when the
    // URL has no extension or is an opaque CDN path.
    const CONTENT_TYPE_EXT: Record<string, string> = {
      "image/png":  ".png",
      "image/jpeg": ".jpg",
      "image/jpg":  ".jpg",
      "image/gif":  ".gif",
      "image/webp": ".webp",
      "image/bmp":  ".bmp",
      "video/mp4":  ".mp4",
      "video/webm": ".webm",
      "video/quicktime": ".mov",
      "video/x-matroska": ".mkv",
      "video/gif":  ".gif",
      "audio/mpeg": ".mp3",
      "audio/ogg":  ".ogg",
      "audio/wav":  ".wav",
      "audio/webm": ".webm",
    };
    const contentType = ((resp.headers as Record<string, string>)["content-type"] ?? "")
      .split(";")[0]?.trim().toLowerCase() ?? "";
    const rawName = (inputUrl.split("?")[0] ?? "file").split("/").pop() ?? "file";
    const urlExt  = extname(rawName).toLowerCase();
    const ext     = CONTENT_TYPE_EXT[contentType] ?? (urlExt || ".mp4");
    const inputPath = join(tmpDir, `input${ext}`);

    await writeFile(inputPath, Buffer.from(resp.data));

    // Extract autotune=<url> before passing to Python (Python's AutotuneBot is unavailable).
    // We'll apply the TS FFmpeg autotune post-process on the Python output instead.
    const autotuneMatch = effectStr.match(/(?:^|,)atb(?:=(\S+))?|(?:^|,)autotune=(\S+)/i);
    const autotuneUrl = autotuneMatch ? (autotuneMatch[1] ?? autotuneMatch[2] ?? null) : null;
    const pyEffectStr = autotuneUrl
      ? effectStr.replace(/(?:^|,)\s*(?:atb(?:=\S+)?|autotune=\S+)/gi, "").replace(/^,+|,+$/g, "").trim()
      : effectStr;

    // Call Python backend: python3 videoEdit.py "<effects>" "<inputFile>" "<workingDir>"
    let stdout = "";
    let stderr = "";
    try {
      const result = await execFileAsync(
        "python3",
        [PY_SCRIPT, pyEffectStr || "noop", inputPath, tmpDir, PY_ASSET_DIR],
        { timeout: VEB_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      );
      stdout = result.stdout.trim();
      stderr = result.stderr.trim();
    } catch (err: unknown) {
      clearInterval(ticker);
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      stdout = (e.stdout ?? "").trim();
      stderr = (e.stderr ?? "").trim();
      const errMsg = stderr || stdout || (err instanceof Error ? err.message : String(err));
      await statusMsg.edit({ content: `❌ veb failed:\n\`\`\`\n${errMsg.slice(0, 1800)}\n\`\`\`` });
      return;
    }
    clearInterval(ticker);

    // stdout is the output file path printed by the Python script
    let outPath = stdout.split("\n").pop()?.trim() ?? "";
    if (!outPath) {
      const errMsg = stderr || "(no output path returned)";
      await statusMsg.edit({ content: `❌ veb failed:\n\`\`\`\n${errMsg.slice(0, 1800)}\n\`\`\`` });
      return;
    }

    // Apply TS autotune post-process if requested
    if (autotuneUrl) {
      try {
        const carrierPath = join(tmpDir, "autotune_carrier.mp3");
        const carrierResp = await axios.get<ArrayBuffer>(autotuneUrl, {
          responseType: "arraybuffer", timeout: 30_000,
          headers: { "User-Agent": BROWSER_UA },
        });
        await writeFile(carrierPath, Buffer.from(carrierResp.data));
        const atOutPath = join(tmpDir, `autotune_out${extname(outPath) || ".mp4"}`);
        const outExtLower = (extname(outPath) || ".mp4").toLowerCase();
        const isVideo = [".mp4", ".webm", ".mkv", ".mov", ".gif"].includes(outExtLower);
        await runAutotune(outPath, carrierPath, atOutPath, {
          effects: [], rep: 1, dur: null,
          inputUrl: "", inputExt: extname(outPath) || ".mp4",
          mediaType: isVideo ? "video" : "audio",
        });
        outPath = atOutPath;
      } catch (atErr) {
        const msg = atErr instanceof Error ? atErr.message : String(atErr);
        await statusMsg.edit({ content: `❌ veb autotune failed: \`${msg.slice(0, 300)}\`` });
        return;
      }
    }

    const outBuf  = await readFile(outPath);
    const outExt  = extname(outPath) || ".mp4";
    const fileName = `veb_result${outExt}`;
    const label    = `✅ veb: \`${effectStr.slice(0, 120) || "(random)"}\``;

    if (outBuf.length <= DISCORD_MAX_BYTES) {
      await statusMsg.delete().catch(() => {});
      const file = new AttachmentBuilder(outBuf, { name: fileName });
      await message.reply({ content: label, files: [file] });
    } else {
      await statusMsg.edit("📦 File too large — uploading to catbox.moe…").catch(() => {});
      const catboxUrl = await uploadToCatbox(outBuf, fileName);
      await statusMsg.delete().catch(() => {});
      await message.reply({ content: `${label}\n📦 Too large for Discord → ${catboxUrl}` });
    }
  } catch (err) {
    clearInterval(ticker);
    logger.error({ err }, "&veb failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await statusMsg.edit({ content: `❌ veb failed: \`${msg.slice(0, 300)}\`` });
  } finally {
    clearInterval(ticker);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
