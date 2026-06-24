import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import axios from "axios";
import { logger } from "../lib/logger.js";
import { runSync } from "./sync.js";

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
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    proc.stderr.on("data", (d: Buffer) => chunks.push(d));
    proc.on("close", (code) => {
      const stderr = Buffer.concat(chunks).toString();
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-1200)));
    });
    proc.on("error", reject);
  });
}

function parseFrac(f: string | undefined): number {
  const [n, d] = (f ?? "0/0").split("/").map(Number);
  return n && d ? n / d : 0;
}

async function probeSlowMotion(filePath: string): Promise<{
  captureFps: number;
  playbackFps: number;
  slowFactor: number;
  hasAudio: boolean;
}> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=r_frame_rate,avg_frame_rate",
      "-show_entries", "format=duration",
      "-print_format", "json",
      filePath,
    ]);
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => {
      try {
        const json = JSON.parse(out) as {
          streams?: Array<{ r_frame_rate?: string; avg_frame_rate?: string }>;
        };
        const s = json.streams?.[0];
        const captureFps  = parseFrac(s?.r_frame_rate);
        const playbackFps = parseFrac(s?.avg_frame_rate) || captureFps;

        if (!isFinite(captureFps) || captureFps <= 0) {
          reject(new Error("Could not read frame rate from video"));
          return;
        }

        const slowFactor = captureFps / (playbackFps > 0 ? playbackFps : captureFps);
        resolve({ captureFps, playbackFps, slowFactor, hasAudio: false });
      } catch (e) { reject(e); }
    });
    proc.on("error", reject);
  });
}

async function probeHasAudio(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=codec_type",
      "-of", "csv=p=0",
      filePath,
    ]);
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => resolve(out.trim().length > 0));
    proc.on("error", () => resolve(false));
  });
}

export type SyncAltResult = {
  buffer: Buffer;
  summary: string;
};

export async function runSyncAlt(fileUrl: string, inputExt: string): Promise<SyncAltResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), "ihtxsyncalt-"));
  try {
    const inputPath  = join(tmpDir, `input${inputExt}`);
    const outputPath = join(tmpDir, "output.mp4");

    await writeFile(inputPath, await downloadFile(fileUrl));

    const [{ captureFps, playbackFps, slowFactor }, hasAudio] = await Promise.all([
      probeSlowMotion(inputPath),
      probeHasAudio(inputPath),
    ]);

    logger.info({ captureFps, playbackFps, slowFactor, hasAudio }, "syncalt: detected");

    if (slowFactor < 1.05) {
      logger.info({ captureFps, playbackFps, slowFactor }, "syncalt: no slow-motion detected, falling back to AV sync");
      return runSync(fileUrl, inputExt);
    }

    // Clamp atempo to valid range (0.5–2.0); chain multiple filters for out-of-range factors
    function buildAtempo(factor: number): string {
      const filters: string[] = [];
      let rem = factor;
      while (rem > 2.0) {
        filters.push("atempo=2.0");
        rem /= 2.0;
      }
      while (rem < 0.5) {
        filters.push("atempo=0.5");
        rem /= 0.5;
      }
      filters.push(`atempo=${rem.toFixed(6)}`);
      return filters.join(",");
    }

    const setpts   = `setpts=${(1 / slowFactor).toFixed(6)}*PTS`;
    const fpsOut   = Math.round(playbackFps);
    const slowStr  = slowFactor.toFixed(3);

    const ffmpegArgs: string[] = ["-y", "-i", inputPath];

    if (hasAudio) {
      const atempo = buildAtempo(slowFactor);
      ffmpegArgs.push(
        "-vf", `${setpts},fps=${fpsOut}`,
        "-af", atempo,
        "-map", "0:v", "-map", "0:a",
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        outputPath,
      );
    } else {
      ffmpegArgs.push(
        "-vf", `${setpts},fps=${fpsOut}`,
        "-map", "0:v",
        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
        "-an",
        "-movflags", "+faststart",
        outputPath,
      );
    }

    await spawnFfmpeg(ffmpegArgs);

    const buf = await readFile(outputPath);

    const summary = [
      "✅ Slow-Motion Detected & Fixed",
      `Capture FPS: \`${captureFps.toFixed(2)}\``,
      `Playback FPS: \`${playbackFps.toFixed(2)}\``,
      `Slow Factor: \`${slowStr}×\``,
      `Output FPS: \`${fpsOut}\``,
      hasAudio ? `Audio: sped up \`${slowStr}×\` via atempo` : `Audio: none`,
    ].join("\n");

    return { buffer: buf, summary };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
