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
    logger.info({ cmd: ["ffmpeg", ...args].join(" ") }, "Running VIZ ffmpeg");
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    proc.stderr.on("data", (d: Buffer) => chunks.push(d));
    proc.on("close", (code) => {
      const stderr = Buffer.concat(chunks).toString();
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg VIZ exited ${code}: ${stderr.slice(-1200)}`));
    });
    proc.on("error", reject);
  });
}

/**
 * Generate a 2×2 grid of all four audio visualisations:
 *   top-left:     showcqt   (640×360)
 *   top-right:    showcwt   (640×360)
 *   bottom-left:  showcqt rotated + hflip, scaled to 640×360
 *   bottom-right: showspectrum (640×360)
 * Output: 1280×720 MP4 with original audio.
 */
export async function runViz(fileUrl: string, inputExt: string): Promise<Buffer> {
  const tmpDir = await mkdtemp(join(tmpdir(), "ihtxviz-"));
  try {
    const inputPath  = join(tmpDir, `input${inputExt}`);
    const outputPath = join(tmpDir, "viz_output.mp4");

    await writeFile(inputPath, await downloadFile(fileUrl));

    const filterComplex = [
      "[0:a]showcqt=s=640x360[cqt]",
      "[0:a]showcwt=s=640x360[cwt]",
      "[0:a]showcqt=s=360x480,transpose=2,hflip,scale=640:360[cq]",
      "[0:a]showspectrum=s=640x360[fft]",
      "[cqt][cwt][cq][fft]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[v]",
    ].join(";");

    await spawnFfmpeg([
      "-y", "-i", inputPath,
      "-filter_complex", filterComplex,
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
