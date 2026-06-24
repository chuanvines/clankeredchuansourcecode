import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEffectsString } from "../effects/parser.js";
import { processMedia, probeHasAudio, probeVideoDimensions, MediaType } from "../effects/processor.js";
import { logger } from "../lib/logger.js";

export const MAX_N = 4;
const MAX_TILE_PX = 480;

function buildXstackLayout(n: number): string {
  const positions: string[] = [];
  for (let i = 0; i < n * n; i++) {
    const row = Math.floor(i / n);
    const col = i % n;
    const xParts = Array.from({ length: col }, (_, j) => `w${j}`);
    const yParts = Array.from({ length: row }, (_, j) => `h${j * n}`);
    const x = xParts.length === 0 ? "0" : xParts.join("+");
    const y = yParts.length === 0 ? "0" : yParts.join("+");
    positions.push(`${x}_${y}`);
  }
  return positions.join("|");
}

function spawnFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderr: Buffer[] = [];
    proc.stderr.on("data", (d: Buffer) => stderr.push(d));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg nparison exited ${code}: ${Buffer.concat(stderr).toString().slice(-800)}`));
    });
    proc.on("error", reject);
  });
}

export async function runNparison(opts: {
  inputUrl: string;
  inputExt: string;
  mediaType: MediaType;
  effectsStr: string;
  n: number;
  onProgress?: (current: number, total: number) => void;
}): Promise<Buffer> {
  const { inputUrl, inputExt, mediaType, effectsStr, n, onProgress } = opts;
  const cells = n * n;
  const effects = parseEffectsString(effectsStr);

  const tmpDir = await mkdtemp(join(tmpdir(), "nparison-"));
  try {
    const cellPaths: string[] = [];

    for (let power = 1; power <= cells; power++) {
      logger.info({ power, cells }, `Nparison: processing cell ${power}/${cells}`);
      onProgress?.(power, cells);

      let currentBuffer: Buffer | undefined = undefined;
      let currentExt = inputExt;

      for (let pass = 1; pass <= power; pass++) {
        const result = await processMedia({
          effects,
          rep: 1,
          dur: null,
          inputUrl,
          inputExt: currentExt,
          mediaType,
          inputBuffer: currentBuffer,
        });
        currentBuffer = result.buffer;
        currentExt = result.ext;
      }

      const cellPath = join(tmpDir, `cell_${String(power).padStart(3, "0")}${currentExt}`);
      await writeFile(cellPath, currentBuffer!);
      cellPaths.push(cellPath);
    }

    const firstCell = cellPaths[0]!;
    const [hasAudio, srcDims] = await Promise.all([
      mediaType === "video" ? probeHasAudio(firstCell) : Promise.resolve(false),
      mediaType !== "image" ? probeVideoDimensions(firstCell) : Promise.resolve({ w: MAX_TILE_PX, h: MAX_TILE_PX }),
    ]);

    // Compute tile size maintaining input aspect ratio, capped at MAX_TILE_PX
    const srcW = srcDims.w || MAX_TILE_PX;
    const srcH = srcDims.h || MAX_TILE_PX;
    let tileW: number, tileH: number;
    if (srcW >= srcH) {
      tileW = MAX_TILE_PX;
      tileH = Math.round((srcH / srcW) * MAX_TILE_PX);
    } else {
      tileH = MAX_TILE_PX;
      tileW = Math.round((srcW / srcH) * MAX_TILE_PX);
    }
    // Ensure even dimensions (required by libx264)
    tileW = tileW % 2 === 0 ? tileW : tileW + 1;
    tileH = tileH % 2 === 0 ? tileH : tileH + 1;
    logger.info({ srcW, srcH, tileW, tileH }, "Nparison tile dimensions");

    const outputPath = join(tmpDir, "nparison_output.mp4");
    const layout = buildXstackLayout(n);

    const scaleParts = cellPaths
      .map(
        (_, i) =>
          `[${i}:v]scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease,` +
          `pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=20[v${i}]`,
      )
      .join(";");

    const stackInputs = cellPaths.map((_, i) => `[v${i}]`).join("");
    let filterComplex = `${scaleParts};${stackInputs}xstack=inputs=${cells}:layout=${layout}[vout]`;

    if (hasAudio) {
      const audioInputs = cellPaths.map((_, i) => `[${i}:a]`).join("");
      filterComplex += `;${audioInputs}amix=inputs=${cells}:duration=longest:normalize=0[aout]`;
    }

    const inputArgs: string[] = [];
    for (const p of cellPaths) inputArgs.push("-i", p);

    const outputArgs: string[] = hasAudio
      ? ["-map", "[vout]", "-map", "[aout]", "-c:a", "aac", "-b:a", "128k"]
      : ["-map", "[vout]"];

    await spawnFfmpeg([
      "-y",
      ...inputArgs,
      "-filter_complex", filterComplex,
      ...outputArgs,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      outputPath,
    ]);

    return await readFile(outputPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
