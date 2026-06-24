import { Message, AttachmentBuilder } from "discord.js";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../lib/logger.js";
import { uploadToCatbox } from "./catboxupload.js";

const DISCORD_MAX_BYTES = 8 * 1024 * 1024;
const MAX_DURATION = 60;
const MIN_DURATION = 0.1;
const MAX_SAMPLERATE = 96000;
const MIN_SAMPLERATE = 1000;

type BytebeatMode = "u8" | "s8" | "float";

const MODE_ALIASES: Record<string, BytebeatMode> = {
  u8:        "u8",
  mono:      "u8",
  classic:   "u8",
  unsigned:  "u8",
  s8:        "s8",
  signed:    "s8",
  float:     "float",
  floatbeat: "float",
  f32:       "float",
};

const BLOCKED_IDENTIFIERS =
  /\b(process|require|import|fetch|eval|Function|globalThis|global|__dirname|__filename|module|exports|setTimeout|setInterval|clearTimeout|clearInterval|Buffer|fs|child_process|XMLHttpRequest|WebSocket)\b/;

function buildEvaluator(code: string): (t: number) => number {
  if (BLOCKED_IDENTIFIERS.test(code)) {
    throw new Error("Code contains disallowed identifiers.");
  }
  const fn = new Function("t", "Math", `"use strict"; return (${code});`) as (
    t: number,
    math: typeof Math,
  ) => number;
  return (t: number) => {
    const result = fn(t, Math);
    return typeof result === "number" ? result : 0;
  };
}

function generatePcm(
  evaluator: (t: number) => number,
  mode: BytebeatMode,
  sampleRate: number,
  duration: number,
): Buffer {
  const numSamples = Math.floor(sampleRate * duration);

  if (mode === "float") {
    const buf = Buffer.allocUnsafe(numSamples * 4);
    for (let t = 0; t < numSamples; t++) {
      const val = Math.max(-1, Math.min(1, evaluator(t)));
      buf.writeFloatLE(val, t * 4);
    }
    return buf;
  }

  const buf = Buffer.allocUnsafe(numSamples);
  for (let t = 0; t < numSamples; t++) {
    const raw = evaluator(t) | 0;
    if (mode === "u8") {
      buf[t] = raw & 0xff;
    } else {
      const signed = ((raw & 0xff) << 24) >> 24;
      buf.writeInt8(Math.max(-128, Math.min(127, signed)), t);
    }
  }
  return buf;
}

function spawnFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const errChunks: Buffer[] = [];
    proc.stderr.on("data", (d: Buffer) => errChunks.push(d));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const stderr = Buffer.concat(errChunks).toString().slice(-800);
        reject(new Error(`FFmpeg exited ${code}: ${stderr}`));
      }
    });
    proc.on("error", reject);
  });
}

async function pcmToWaveformVideo(
  pcmBuf: Buffer,
  mode: BytebeatMode,
  sampleRate: number,
  tmpDir: string,
): Promise<Buffer> {
  const ffmpegFormat =
    mode === "float" ? "f32le" : mode === "u8" ? "u8" : "s8";

  const rawPath = join(tmpDir, "input.raw");
  const outPath = join(tmpDir, "bytebeat.mp4");

  await writeFile(rawPath, pcmBuf);

  await spawnFfmpeg([
    "-y",
    "-f", ffmpegFormat,
    "-ar", String(sampleRate),
    "-ac", "1",
    "-i", rawPath,
    "-filter_complex",
    "[0:a]showwaves=s=640x360:mode=line:colors=lime|white:rate=60[v]",
    "-map", "[v]",
    "-map", "0:a",
    "-c:v", "libx264", "-preset", "fast", "-crf", "22",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outPath,
  ]);

  return readFile(outPath);
}

export async function runBytebeat(message: Message): Promise<void> {
  const raw = message.content.trim();
  const rest = raw.slice(raw.toLowerCase().indexOf("&bytebeat") + 9).trim();

  if (!rest) {
    await message.reply(
      "❌ Usage: `&bytebeat <mode> <samplerate> <duration> <code>`\n" +
      "**Modes:** `u8` (classic unsigned) · `s8` (signed) · `float` (floatbeat, values -1..1)\n" +
      "**Examples:**\n" +
      "• `&bytebeat u8 8000 10 t*(t>>5|t>>8)`\n" +
      "• `&bytebeat float 44100 5 Math.sin(t/10)*Math.sin(t/700)`\n" +
      "`t` = sample index · `Math.*` functions available\n" +
      `Max duration: **${MAX_DURATION}s** · Sample rate: **${MIN_SAMPLERATE}–${MAX_SAMPLERATE} Hz**`,
    );
    return;
  }

  const parts = rest.split(/\s+/);
  if (parts.length < 4) {
    await message.reply(
      "❌ Not enough arguments.\n" +
      "Usage: `&bytebeat <mode> <samplerate> <duration> <code>`\n" +
      "Example: `&bytebeat u8 8000 10 t*(t>>5|t>>8)`",
    );
    return;
  }

  const rawMode = parts[0]!.toLowerCase();
  const mode = MODE_ALIASES[rawMode];
  if (!mode) {
    await message.reply(
      `❌ Unknown mode \`${parts[0]}\`.\n` +
      "Valid: `u8` / `mono` / `classic` · `s8` / `signed` · `float` / `floatbeat`",
    );
    return;
  }

  const sampleRate = Math.round(parseFloat(parts[1]!));
  if (isNaN(sampleRate) || sampleRate < MIN_SAMPLERATE || sampleRate > MAX_SAMPLERATE) {
    await message.reply(
      `❌ Sample rate must be between **${MIN_SAMPLERATE}** and **${MAX_SAMPLERATE}** Hz.`,
    );
    return;
  }

  const duration = parseFloat(parts[2]!);
  if (isNaN(duration) || duration < MIN_DURATION || duration > MAX_DURATION) {
    await message.reply(
      `❌ Duration must be between **${MIN_DURATION}s** and **${MAX_DURATION}s**.`,
    );
    return;
  }

  const code = parts.slice(3).join(" ");

  let evaluator: (t: number) => number;
  try {
    evaluator = buildEvaluator(code);
    evaluator(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await message.reply(`❌ Invalid expression: \`${msg.slice(0, 200)}\``);
    return;
  }

  const numSamples = Math.floor(sampleRate * duration);
  let statusMsg: Message;
  try {
    statusMsg = await message.reply(
      `⏳ Generating bytebeat — mode: \`${mode}\` · ${sampleRate} Hz · ${duration}s · ${numSamples.toLocaleString()} samples…`,
    );
  } catch { return; }

  const tmpDir = await mkdtemp(join(tmpdir(), "bytebeat-"));
  try {
    const pcmBuf = generatePcm(evaluator, mode, sampleRate, duration);
    const videoBuf = await pcmToWaveformVideo(pcmBuf, mode, sampleRate, tmpDir);

    const snippet = code.length > 80 ? code.slice(0, 80) + "…" : code;
    const label =
      `🎵 **Bytebeat** — \`${snippet}\`\n` +
      `Mode: \`${mode}\` · ${sampleRate} Hz · ${duration}s`;

    if (videoBuf.length <= DISCORD_MAX_BYTES) {
      await statusMsg.delete().catch(() => {});
      const file = new AttachmentBuilder(videoBuf, { name: "bytebeat.mp4" });
      await message.reply({ content: label, files: [file] });
    } else {
      await statusMsg.edit("📦 File too large for Discord — uploading to catbox.moe…").catch(() => {});
      const catboxUrl = await uploadToCatbox(videoBuf, "bytebeat.mp4");
      await statusMsg.delete().catch(() => {});
      await message.reply(`${label}\n📦 Too large for Discord → ${catboxUrl}`);
    }
  } catch (err) {
    logger.error({ err }, "&bytebeat failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await statusMsg.edit({ content: `❌ Bytebeat failed: \`${msg.slice(0, 300)}\`` });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
