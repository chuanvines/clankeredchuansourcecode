import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import axios from "axios";
import { logger } from "../lib/logger.js";

async function downloadFile(url: string): Promise<Buffer> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };
  if (/discordapp\.(com|net)|discord\.com/i.test(url)) {
    headers["Referer"] = "https://discord.com/";
  }
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 120_000,
    headers,
  });
  return Buffer.from(res.data);
}

function spawnFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    logger.info({ cmd: ["ffmpeg", ...args].join(" ") }, "Running imagetoaudio ffmpeg");
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    proc.stderr.on("data", (d: Buffer) => chunks.push(d));
    proc.on("close", (code) => {
      const stderr = Buffer.concat(chunks).toString();
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg imagetoaudio exited ${code}: ${stderr.slice(-1200)}`));
    });
    proc.on("error", reject);
  });
}

/**
 * Convert an image to audio via "databending":
 *   1. Extract raw RGB24 pixel data from the image.
 *   2. Re-interpret those bytes as unsigned 8-bit PCM samples at 8 kHz mono.
 * The result is a glitchy, noise-art audio file whose character directly
 * reflects the image's pixel values.
 */
export async function runImageToAudio(fileUrl: string, inputExt: string): Promise<Buffer> {
  const tmpDir = await mkdtemp(join(tmpdir(), "ihtxita-"));
  try {
    const inputPath  = join(tmpDir, `input${inputExt}`);
    const rawPath    = join(tmpDir, "pixels.rgb");
    const outputPath = join(tmpDir, "imagetoaudio.mp3");

    await writeFile(inputPath, await downloadFile(fileUrl));

    // Step 1: dump raw RGB24 pixels (no container overhead)
    await spawnFfmpeg([
      "-y", "-i", inputPath,
      "-f", "rawvideo", "-pix_fmt", "rgb24",
      rawPath,
    ]);

    // Step 2: interpret pixel bytes as u8 PCM mono 8 kHz → encode to MP3
    await spawnFfmpeg([
      "-y",
      "-f", "u8", "-ar", "8000", "-ac", "1",
      "-i", rawPath,
      "-c:a", "libmp3lame", "-b:a", "128k",
      outputPath,
    ]);

    return await readFile(outputPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
