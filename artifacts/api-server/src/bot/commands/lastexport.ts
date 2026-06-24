import { spawn, execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import axios from "axios";
import { logger } from "../lib/logger.js";

const execFileAsync = promisify(execFile);

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
    logger.info({ cmd: ["ffmpeg", ...args].join(" ") }, "Running lastexport ffmpeg");
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderr: Buffer[] = [];
    proc.stderr.on("data", (d: Buffer) => stderr.push(d));
    proc.on("close", (code) => {
      const errText = Buffer.concat(stderr).toString();
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg lastexport exited ${code}: ${errText.slice(-1200)}`));
    });
    proc.on("error", reject);
  });
}

async function probeHasAudio(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "a",
      "-show_entries", "stream=codec_type",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Extract the last `duration` seconds of a video in correct forward order.
 *
 * Pipeline: reverse → trim to duration → reverse again.
 * Net result: the final `duration` seconds of the source, playing forwards.
 *
 * Uses: -vf reverse,trim=duration=<dur>,reverse,setpts=PTS-STARTPTS
 *       -af areverse,atrim=duration=<dur>,areverse,asetpts=PTS-STARTPTS
 */
export async function runLastExport(inputUrl: string, inputExt: string, duration: number): Promise<Buffer> {
  const tmpDir = await mkdtemp(join(tmpdir(), "lastexport-"));
  try {
    const inputPath  = join(tmpDir, `input${inputExt}`);
    const outputPath = join(tmpDir, "lastexport_output.mp4");

    await writeFile(inputPath, await downloadFile(inputUrl));

    const hasAudio = await probeHasAudio(inputPath);
    const dur = Math.max(0.1, duration);

    const vfFilter = `reverse,trim=duration=${dur},reverse,setpts=PTS-STARTPTS`;
    const afFilter = `areverse,atrim=duration=${dur},areverse,asetpts=PTS-STARTPTS`;

    const args: string[] = [
      "-y",
      "-i", inputPath,
      "-vf", vfFilter,
    ];

    if (hasAudio) {
      args.push("-af", afFilter);
    }

    args.push(
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
    );
    if (hasAudio) {
      args.push("-c:a", "aac", "-b:a", "192k");
    }
    args.push("-movflags", "+faststart", outputPath);

    await spawnFfmpeg(args);

    return await readFile(outputPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
