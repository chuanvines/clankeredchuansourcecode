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
    logger.info({ cmd: ["ffmpeg", ...args].join(" ") }, "Running waveform ffmpeg");
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    proc.stderr.on("data", (d: Buffer) => chunks.push(d));
    proc.on("close", (code) => {
      const stderr = Buffer.concat(chunks).toString();
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg waveform exited ${code}: ${stderr.slice(-1200)}`));
    });
    proc.on("error", reject);
  });
}

const VALID_STYLES = ["line", "point", "p2p", "cline"] as const;
type WaveStyle = (typeof VALID_STYLES)[number];

/**
 * Generate a waveform visualisation video using FFmpeg's showwaves filter.
 * @param style  "line" | "point" | "p2p" | "cline" (defaults to "line")
 */
export async function runWaveform(
  fileUrl: string,
  inputExt: string,
  style: string = "line",
): Promise<Buffer> {
  const safeStyle: WaveStyle = (VALID_STYLES as readonly string[]).includes(style)
    ? (style as WaveStyle)
    : "line";

  const tmpDir = await mkdtemp(join(tmpdir(), "ihtxwave-"));
  try {
    const inputPath  = join(tmpDir, `input${inputExt}`);
    const outputPath = join(tmpDir, "waveform_output.mp4");

    await writeFile(inputPath, await downloadFile(fileUrl));

    await spawnFfmpeg([
      "-y", "-i", inputPath,
      "-filter_complex", `[0:a]showwaves=s=640x360:mode=${safeStyle}:colors=white[v]`,
      "-map", "[v]", "-map", "0:a",
      "-c:v", "libx264", "-preset", "fast", "-crf", "23",
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart",
      outputPath,
    ]);

    return await readFile(outputPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
