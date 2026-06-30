import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { downloadUrl } from "./catboxupload.js";
import { logger } from "../lib/logger.js";

function spawnAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}:\n${stderr.slice(-2000)}`));
    });
    proc.on("error", reject);
  });
}

async function getDuration(filePath: string): Promise<number> {
  const { stdout } = await spawnAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const val = parseFloat(stdout.trim());
  if (!isFinite(val) || val <= 0) throw new Error("Could not determine video duration");
  return val;
}

export async function runLsc(text: string, videoUrl: string): Promise<Buffer> {
  const tmpDir = await mkdtemp(join(tmpdir(), "lsc-"));
  try {
    logger.info({ videoUrl, text }, "lsc: downloading input");
    const { data } = await downloadUrl(videoUrl);
    const inputPath = join(tmpDir, "input.mp4");
    await writeFile(inputPath, data);

    const duration = await getDuration(inputPath);
    const half = duration / 2;
    logger.info({ duration, half }, "lsc: probed duration");

    // Escape drawtext special characters
    const safeText = text
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\u2019")
      .replace(/:/g, "\\:")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]");

    const filterComplex = [
      `[0:v]split=4[v1][v2][v3][v4]`,
      `[0:a]asplit=4[a1][a2][a3][a4]`,
      `[v1]trim=0:${half},setpts=PTS-STARTPTS[ia]`,
      `[v2]setpts=PTS-STARTPTS,setpts=0.5*PTS,scale=iw/2:ih/2[ia2]`,
      `[v3]trim=${half},setpts=PTS-STARTPTS[ib]`,
      `[v4]setpts=PTS-STARTPTS,setpts=0.5*PTS,scale=iw/2:ih/2[ib2]`,
      `[ia][ia2]overlay=0:0[part1]`,
      `[ib][ib2]overlay=W/2:H/2[part2]`,
      `[part1][part2]concat=n=2:v=1:a=0,drawtext=text='${safeText}':fontsize=50:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=10:x=(w-tw-10):y=10[vout]`,
      `[a1]atrim=0:${half},asetpts=PTS-STARTPTS,loudnorm[aa]`,
      `[a2]asetpts=PTS-STARTPTS,atempo=2.0[aa2]`,
      `[a3]atrim=${half},asetpts=PTS-STARTPTS,loudnorm[ab]`,
      `[a4]asetpts=PTS-STARTPTS,atempo=2.0[ab2]`,
      `[aa][aa2]amix=inputs=2[aout1]`,
      `[ab][ab2]amix=inputs=2[aout2]`,
      `[aout1][aout2]concat=n=2:v=0:a=1[aout]`,
    ].join(";");

    const outputPath = join(tmpDir, "output.mp4");

    logger.info("lsc: running ffmpeg");
    await spawnAsync("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-i", inputPath,
      "-i", inputPath,
      "-i", inputPath,
      "-filter_complex", filterComplex,
      "-map", "[vout]",
      "-map", "[aout]",
      "-t", String(duration),
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      outputPath,
    ]);

    return await readFile(outputPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
