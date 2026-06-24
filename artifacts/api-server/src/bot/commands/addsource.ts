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
    logger.info({ cmd: ["ffmpeg", ...args].join(" ") }, "Running addsource ffmpeg");
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderr: Buffer[] = [];
    proc.stderr.on("data", (d: Buffer) => stderr.push(d));
    proc.on("close", (code) => {
      const errText = Buffer.concat(stderr).toString();
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg addsource exited ${code}: ${errText.slice(-1200)}`));
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
 * Probe the width and height of the first video stream in a file.
 * Returns { width: 0, height: 0 } on failure (scale will be a no-op).
 */
async function probeVideoDimensions(filePath: string): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      filePath,
    ]);
    const [w, h] = stdout.trim().split(",").map(Number);
    if (w && h && w > 0 && h > 0) return { width: w, height: h };
  } catch { /* fall through */ }
  return { width: 0, height: 0 };
}

export interface AddSourceOptions {
  mainUrl: string;
  mainExt: string;
  sourceUrl: string;
  sourceExt: string;
  /** 0 = native resolution; >0 = scale source so its width = scale * base video width */
  scale: number;
  xpos: number;
  ypos: number;
}

/**
 * Overlay a source video onto a base video.
 * - scale=0: source at its own native width × height.
 * - scale>0: source width = scale * base video width (aspect-ratio preserved).
 * - Placed at (xpos, ypos).
 * - Audio priority: source audio → main audio → no audio.
 * - Output ends when the shorter of the two inputs ends.
 */
export async function runAddSource(opts: AddSourceOptions): Promise<Buffer> {
  const tmpDir = await mkdtemp(join(tmpdir(), "ihtxsrc-"));
  try {
    const mainPath   = join(tmpDir, `main${opts.mainExt}`);
    const srcPath    = join(tmpDir, `source${opts.sourceExt}`);
    const outputPath = join(tmpDir, "addsource_output.mp4");

    await Promise.all([
      writeFile(mainPath,  await downloadFile(opts.mainUrl)),
      writeFile(srcPath,   await downloadFile(opts.sourceUrl)),
    ]);

    // Positional shortcuts: 0=left/top, 1=center/middle, 2=right/bottom, >2=raw px
    const xExpr = opts.xpos === 0 ? "0"
      : opts.xpos === 1 ? "(main_w-overlay_w)/2"
      : opts.xpos === 2 ? "main_w-overlay_w"
      : String(opts.xpos);
    const yExpr = opts.ypos === 0 ? "0"
      : opts.ypos === 1 ? "(main_h-overlay_h)/2"
      : opts.ypos === 2 ? "main_h-overlay_h"
      : String(opts.ypos);

    // Determine whether to scale the source relative to its own native width.
    let srcVideoLabel = "[1:v]";
    let scaleFilter = "";
    if (opts.scale > 0) {
      const { width: srcNativeW } = await probeVideoDimensions(srcPath);
      if (srcNativeW > 0) {
        const targetW = Math.round(srcNativeW * opts.scale);
        // scale to targetW wide, keep aspect ratio; force even height for yuv420p
        scaleFilter = `[1:v]scale=${targetW}:-2[src_scaled];`;
        srcVideoLabel = "[src_scaled]";
      }
    }

    const [srcHasAudio, mainHasAudio] = await Promise.all([
      probeHasAudio(srcPath),
      probeHasAudio(mainPath),
    ]);

    const maps: string[] = ["-map", "[vout]"];
    let filterComplex: string;

    if (srcHasAudio) {
      filterComplex =
        `${scaleFilter}[0:v]${srcVideoLabel}overlay=${xExpr}:${yExpr}:eof_action=endall[vout];` +
        `[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]`;
      maps.push("-map", "[aout]");
    } else if (mainHasAudio) {
      filterComplex =
        `${scaleFilter}[0:v]${srcVideoLabel}overlay=${xExpr}:${yExpr}:eof_action=endall[vout];` +
        `[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[aout]`;
      maps.push("-map", "[aout]");
    } else {
      filterComplex =
        `${scaleFilter}[0:v]${srcVideoLabel}overlay=${xExpr}:${yExpr}:eof_action=endall[vout]`;
    }

    const hasAudio = srcHasAudio || mainHasAudio;

    await spawnFfmpeg([
      "-y",
      "-i", mainPath,
      "-i", srcPath,
      "-filter_complex", filterComplex,
      ...maps,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
      ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
      "-shortest",
      "-movflags", "+faststart",
      outputPath,
    ]);

    return await readFile(outputPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
