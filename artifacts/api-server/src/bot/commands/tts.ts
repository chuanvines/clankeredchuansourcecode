/**
 * &tts <voice> <text>
 *
 * Voices:
 *   male    — TikTok male   (en_us_006 / Austin)
 *   female  — TikTok female (en_us_001 / Jessie)
 *   sam     — Microsoft Sam  (gTTS + robotic ffmpeg filter)
 *   mike    — Microsoft Mike (gTTS + slightly different robot filter)
 */

import { AttachmentBuilder, Message } from "discord.js";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import axios from "axios";
import { logger } from "../lib/logger.js";
import { uploadToCatbox } from "./catboxupload.js";

const execFileAsync = promisify(execFile);

const DISCORD_MAX_BYTES = 24 * 1024 * 1024;

const VOICE_ALIASES: Record<string, string> = {
  male            : "male",
  m               : "male",
  female          : "female",
  f               : "female",
  girl            : "female",
  sam             : "sam",
  "microsoft sam" : "sam",
  mike            : "mike",
  "microsoft mike": "mike",
};

async function tiktokTts(text: string, voiceId: string): Promise<Buffer | null> {
  const endpoints = [
    "https://tiktok-tts.weilnet.workers.dev/api/generation",
    "https://tts.mbyte.space/api/generation",
  ];
  for (const url of endpoints) {
    try {
      const res = await axios.post(url, { text, voice: voiceId }, { timeout: 15_000 });
      const b64: string = res.data?.data ?? res.data?.audio ?? "";
      if (b64) return Buffer.from(b64, "base64");
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Generate Microsoft Sam/Mike style audio:
 *   1. gTTS → base speech MP3
 *   2. ffmpeg robot filter chain (ring modulation + echo + pitch)
 */
async function robotTts(
  text: string,
  tmpDir: string,
  preset: "sam" | "mike",
): Promise<Buffer | null> {
  const rawMp3  = join(tmpDir, "raw.mp3");
  const outMp3  = join(tmpDir, "robot.mp3");

  // Step 1: generate base speech with gTTS
  try {
    await execFileAsync("python3", [
      "-c",
      `from gtts import gTTS; gTTS(text=${JSON.stringify(text)}, lang='en', tld='com').save(${JSON.stringify(rawMp3)})`,
    ], { timeout: 20_000 });
  } catch (e) {
    logger.error({ err: e }, "gTTS generation failed");
    return null;
  }

  // Step 2: apply robot effect with ffmpeg
  // Sam:  slower, lower pitch, heavier ring-mod → very robotic
  // Mike: slightly faster, higher pitch, lighter ring-mod
  const samFilter  =
    "asetrate=44100*0.78,aresample=44100," +                         // pitch down ~3.5 semitones
    "atempo=1.05," +                                                  // slight speed-up to compensate
    "afftfilt=real='hypot(re,im)*cos(0)':imag='hypot(re,im)*sin(0)'," + // FFT robot
    "aecho=0.8:0.6:30:0.3";

  const mikeFilter =
    "asetrate=44100*0.88,aresample=44100," +                         // slight pitch down
    "atempo=1.1," +
    "afftfilt=real='hypot(re,im)*cos(0)':imag='hypot(re,im)*sin(0)'," +
    "aecho=0.7:0.5:20:0.2";

  const filter = preset === "sam" ? samFilter : mikeFilter;

  try {
    await execFileAsync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", rawMp3,
      "-af", filter,
      "-c:a", "libmp3lame", "-q:a", "3",
      outMp3,
    ], { timeout: 30_000 });
    return await readFile(outMp3);
  } catch (e) {
    logger.error({ err: e }, "ffmpeg robot filter failed");
    // Return the raw gTTS output as fallback
    try { return await readFile(rawMp3); } catch { return null; }
  }
}

export async function runTts(message: Message): Promise<void> {
  const raw  = message.content.trim();
  const rest = raw.slice(raw.toLowerCase().indexOf("&tts") + 4).trim();

  if (!rest) {
    await message.reply(
      "❌ Usage: `&tts <voice> <text>`\n" +
      "**Voices:** `male` `female` `sam` (Microsoft Sam) `mike` (Microsoft Mike)\n" +
      "**Example:** `&tts female Hello, this is TikTok voice!`"
    );
    return;
  }

  const firstSpace = rest.indexOf(" ");
  if (firstSpace === -1) {
    await message.reply("❌ Provide both a voice and some text. E.g. `&tts sam Hello world`");
    return;
  }

  const rawVoice = rest.slice(0, firstSpace).toLowerCase();
  const text     = rest.slice(firstSpace + 1).trim();
  const voice    = VOICE_ALIASES[rawVoice] ?? null;

  if (!voice) {
    await message.reply(
      `❌ Unknown voice \`${rawVoice}\`. Available: \`male\`, \`female\`, \`sam\`, \`mike\``
    );
    return;
  }

  if (!text) {
    await message.reply("❌ No text to speak.");
    return;
  }

  if (text.length > 300) {
    await message.reply("❌ Text is too long (max 300 characters).");
    return;
  }

  const statusMsg = await message.reply(`🔊 Generating **${voice}** TTS…`);
  const tmpDir    = await mkdtemp(join(tmpdir(), "tts-"));

  try {
    let audioBuf: Buffer | null = null;

    if (voice === "female") {
      audioBuf = await tiktokTts(text, "en_us_001");
    } else if (voice === "male") {
      audioBuf = await tiktokTts(text, "en_us_006");
    } else if (voice === "sam") {
      audioBuf = await robotTts(text, tmpDir, "sam");
    } else if (voice === "mike") {
      audioBuf = await robotTts(text, tmpDir, "mike");
    }

    if (!audioBuf || audioBuf.length === 0) {
      await statusMsg.edit("❌ TTS generation failed. Try again or use a different voice.");
      return;
    }

    const label = `🔊 **${voice} TTS:** ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`;

    if (audioBuf.length <= DISCORD_MAX_BYTES) {
      const file = new AttachmentBuilder(audioBuf, { name: "tts.mp3" });
      await statusMsg.edit({ content: label, files: [file] });
    } else {
      const tmpFile = join(tmpDir, "tts.mp3");
      await writeFile(tmpFile, audioBuf);
      const catboxUrl = await uploadToCatbox(tmpFile);
      await statusMsg.edit(`${label}\n📦 Too large for Discord → ${catboxUrl}`);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
