import {
  ChatInputCommandInteraction,
  AttachmentBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import axios from "axios";
import { logger } from "../lib/logger.js";
import { interactionError } from "../lib/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("sync")
  .setDescription("Fix AV sync on a single video — separates streams, adjusts tempo or speed, remuxes")
  .addAttachmentOption((opt) =>
    opt.setName("video").setDescription("Video file with out-of-sync audio").setRequired(true)
  );

async function downloadFile(url: string): Promise<Buffer> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };
  if (/discordapp\.(com|net)|discord\.com/i.test(url)) {
    headers["Referer"] = "https://discord.com/";
  }
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 60_000,
    headers,
  });
  return Buffer.from(res.data);
}

/**
 * Count actual video packets to get true video duration.
 * Avoids relying on container metadata which is often wrong for Discord videos.
 */
async function probeVideoByFrameCount(filePath: string): Promise<{ vd: number; fr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-count_packets",
      "-select_streams", "v:0",
      "-show_entries", "stream=nb_read_packets,avg_frame_rate,r_frame_rate",
      "-print_format", "json",
      filePath,
    ]);
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => {
      try {
        const json = JSON.parse(out) as {
          streams?: Array<{
            nb_read_packets?: string;
            avg_frame_rate?: string;
            r_frame_rate?: string;
          }>;
        };
        const s = json.streams?.[0];
        const packets = parseInt(s?.nb_read_packets ?? "", 10);

        // Prefer avg_frame_rate (actual playback fps) over r_frame_rate
        // r_frame_rate can be misleadingly high (e.g. 60000/1001) for 30fps VFR content
        const parseFrac = (f: string | undefined) => {
          const [n, d] = (f ?? "0/0").split("/").map(Number);
          return n && d ? n / d : 0;
        };
        const avgFps = parseFrac(s?.avg_frame_rate);
        const rFps   = parseFrac(s?.r_frame_rate);
        const fps    = avgFps > 0 ? avgFps : (rFps > 0 ? rFps : 30);
        const fr     = String(Math.round(fps));

        if (!isFinite(packets) || packets <= 0 || !isFinite(fps) || fps <= 0) {
          reject(new Error("Could not count video packets"));
          return;
        }
        resolve({ vd: packets / fps, fr });
      } catch (e) { reject(e); }
    });
    proc.on("error", reject);
  });
}

/**
 * Probe duration from a WAV file — format is exact, no metadata issues.
 */
async function probeWavDuration(wavPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-print_format", "json",
      wavPath,
    ]);
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => {
      try {
        const json = JSON.parse(out) as { format?: { duration?: string } };
        const d = parseFloat(json.format?.duration ?? "");
        if (!isFinite(d) || d <= 0) {
          reject(new Error("Could not read WAV duration"));
          return;
        }
        resolve(d);
      } catch (e) { reject(e); }
    });
    proc.on("error", reject);
  });
}

function spawnFfmpeg(args: string[]): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    proc.stderr.on("data", (d: Buffer) => chunks.push(d));
    proc.on("close", (code) => {
      const stderr = Buffer.concat(chunks).toString();
      if (code === 0) resolve({ stderr });
      else reject(new Error(stderr.slice(-1200)));
    });
    proc.on("error", reject);
  });
}

export type SyncResult = {
  buffer: Buffer;
  summary: string;
};

export async function runSync(fileUrl: string, inputExt: string): Promise<SyncResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), "ihtxsync-"));
  try {
    const inputPath  = join(tmpDir, `input${inputExt}`);
    const audioPath  = join(tmpDir, "audio.wav");
    const outputPath = join(tmpDir, "output.mp4");

    await writeFile(inputPath, await downloadFile(fileUrl));

    // Extract audio to WAV — gives us an accurate, metadata-clean audio file
    await spawnFfmpeg([
      "-y", "-i", inputPath,
      "-vn", "-acodec", "pcm_s16le",
      audioPath,
    ]);

    // Probe true durations:
    //   - video: count actual packets (ignores wrong container metadata)
    //   - audio: WAV format duration (always exact)
    const [{ vd, fr }, ad] = await Promise.all([
      probeVideoByFrameCount(inputPath),
      probeWavDuration(audioPath),
    ]);

    logger.info({ vd, ad, fr }, "ihtxsync: true durations");

    let speed: number;
    let ffmpegArgs: string[];

    if (ad > vd) {
      // Audio longer → speed up audio to match video: atempo = ad/vd
      speed = ad / vd;
      ffmpegArgs = [
        "-y",
        "-i", inputPath,
        "-stream_loop", "-1", "-i", audioPath,
        "-af", `atempo=${speed.toFixed(6)}`,
        "-map", "0:v", "-map", "1:a",
        "-t", String(vd),
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        outputPath,
      ];
    } else {
      // Video longer → speed up video to match audio: setpts = 1/(vd/ad)*PTS
      speed = vd / ad;
      const vdOverAd = (vd / ad).toFixed(6);
      ffmpegArgs = [
        "-y",
        "-i", inputPath,
        "-stream_loop", "-1", "-i", audioPath,
        "-vf", `setpts=1/${vdOverAd}*PTS,fps=${fr}`,
        "-map", "0:v", "-map", "1:a",
        "-t", String(vd),
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        outputPath,
      ];
    }

    await spawnFfmpeg(ffmpegArgs);

    const buf = await readFile(outputPath);

    const diff = (vd - ad).toFixed(6);
    const summary = [
      "✅ AV Sync Fixed",
      `Video: \`${vd.toFixed(6)}\``,
      `Audio: \`${ad.toFixed(6)}\``,
      ``,
      `Speed Used: \`${speed.toFixed(6)}\``,
      `Diff: \`${diff}\``,
    ].join("\n");

    return { buffer: buf, summary };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const videoAtt = interaction.options.getAttachment("video", true);
  const inputExt = extname(videoAtt.name || videoAtt.url) || ".mp4";

  try {
    const { buffer, summary } = await runSync(videoAtt.url, inputExt);
    const file = new AttachmentBuilder(buffer, { name: "ihtxsync_result.mp4" });
    await interaction.editReply({ content: summary, files: [file] });
  } catch (err) {
    logger.error({ err }, "ihtxsync slash failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await interactionError(interaction, `Sync failed: \`${msg.slice(0, 300)}\``);
  }
}
