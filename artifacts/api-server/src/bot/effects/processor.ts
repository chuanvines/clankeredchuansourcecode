import { spawn, execFile, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import { ParsedEffect } from "./parser.js";
import {
  buildFilters,
  buildAudioFilterComplex,
  assembleVideoSegments,
  VideoSegment,
} from "./filters.js";
import { logger } from "../lib/logger.js";

const execFileAsync = promisify(execFile);

// Lazily resolve the frei0r plugins directory from the Nix store.
let _frei0rPath: string | null = null;
function getFrei0rPath(): string | null {
  if (_frei0rPath !== null) return _frei0rPath || null;
  try {
    const out = execFileSync("sh", [
      "-c",
      "echo /nix/store/*frei0r*/lib/frei0r-1",
    ], { timeout: 3000 }).toString().trim();
    _frei0rPath = out.includes("*") ? "" : out.split("\n")[0] ?? "";
  } catch {
    _frei0rPath = "";
  }
  return _frei0rPath || null;
}

export type MediaType = "image" | "video" | "audio";

export type ProcessOptions = {
  effects: ParsedEffect[];
  rep: number;
  dur: number | null;
  inputUrl: string;
  inputExt: string;
  mediaType: MediaType;
  lutFileUrl?: string;
  forceGif?: boolean;
  inputBuffer?: Buffer;
};

export type ProcessResult = {
  buffer: Buffer;
  ext: string;
  contentType: string;
};

const MAX_SIDE_PX = 640;
const MAX_VIDEO_SEC = 600;
const MAX_REP = 1000;

/**
 * Replace every occurrence of the bare token `vd` (not part of a larger
 * identifier) with the actual video duration in seconds.
 * e.g. "360*t/vd" with dur=4 → "360*t/4"
 */
function substituteVd(effects: ParsedEffect[], dur: number): ParsedEffect[] {
  const re = /\bvd\b/g;
  const durStr = String(dur);
  return effects.map((e) => ({
    ...e,
    param: e.param !== null ? e.param.replace(re, durStr) : null,
    subparams: e.subparams.map((s) => s.replace(re, durStr)),
  }));
}

export async function processMedia(opts: ProcessOptions): Promise<ProcessResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), "ihtx-"));

  try {
    const inputPath = join(tmpDir, `input${opts.inputExt}`);
    await writeFile(inputPath, opts.inputBuffer ?? await downloadFile(opts.inputUrl));

    // Probe actual duration so `vd` in effect expressions can be resolved.
    // For images there is no duration; use 0 as a safe fallback.
    let resolvedEffects = opts.effects;
    if (opts.mediaType !== "image") {
      const { duration } = await probeMediaMeta(inputPath);
      if (duration !== null && duration > 0) {
        resolvedEffects = substituteVd(opts.effects, duration);
        logger.info({ duration }, "Resolved vd variable in effects");
      }
    }

    const filters = buildFilters(resolvedEffects);

    // Download URL-based lut3d files (lut=<url> effect) and fill in their ref paths
    for (let i = 0; i < filters.pendingLuts.length; i++) {
      const { url, ref } = filters.pendingLuts[i]!;
      const lutPath = join(tmpDir, `lut${i}.cube`);
      try {
        await writeFile(lutPath, await downloadFile(url));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not download LUT file from URL — the link may have expired or be inaccessible. Detail: ${msg}`);
      }
      ref.path = lutPath;
      logger.info({ url, lutPath }, "Downloaded lut3d file");
    }

    // Apply .cube file attachment (fallback when no lut= effect used)
    if (filters.pendingLuts.length === 0 && opts.lutFileUrl) {
      try {
        const lutPath = join(tmpDir, "attached.cube");
        await writeFile(lutPath, await downloadFile(opts.lutFileUrl));
        filters.videoSegments.push({ kind: "vf", filters: ["format=rgb24", `lut3d=file=${lutPath}`, "format=yuv420p"] });
      } catch {
        logger.warn("Failed to download attached .cube LUT — skipping");
      }
    }

    // Generate HALD CLut PPM files for any huehsv effects and set their paths
    for (let i = 0; i < filters.pendingHalds.length; i++) {
      const { hue, type: haldType, ref } = filters.pendingHalds[i]!;
      const ppmPath = join(tmpDir, `hald${i}.ppm`);
      try {
        const hueDeg = parseFloat(hue) || 0;
        if (haldType === "yuv") {
          // YUV rotation matrix — accurate chroma rotation
          const rad = (hueDeg * Math.PI) / 180;
          const cosA = Math.cos(rad).toFixed(8);
          const sinA = Math.sin(rad).toFixed(8);
          const fxExpr = `channel(u,.5+(u.g-.5)*${cosA}-(u.b-.5)*${sinA},.5+(u.g-.5)*${sinA}+(u.b-.5)*${cosA})`;
          await execFileAsync("magick", [
            "hald:6",
            "-colorspace", "yuv",
            "-fx", fxExpr,
            "-colorspace", "srgb",
            ppmPath,
          ]);
          logger.info({ hue, cosA, sinA, ppmPath }, "Generated HALD CLut (yuv)");
        } else {
          // HSV modulate — hue/360*200+100 maps degrees to IM modulate range
          const imHue = ((hueDeg / 360) * 200 + 100).toFixed(4);
          await execFileAsync("magick", [
            "hald:6",
            "-modulate", `100,100,${imHue}`,
            ppmPath,
          ]);
          logger.info({ hue, imHue, ppmPath }, "Generated HALD CLut (modulate)");
        }
        ref.path = ppmPath;
      } catch (err) {
        logger.warn({ err }, "Failed to generate HALD CLut — skipping huehsv effect");
      }
    }

    // Apply built-in LUT assets (bundled in dist/assets/)
    const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "assets");
    for (const lutFile of filters.builtinLuts) {
      const lutPath = join(assetsDir, lutFile);
      filters.videoSegments.push({ kind: "vf", filters: ["format=rgb24", `lut3d=file=${lutPath}`, "format=yuv420p"] });
      logger.info({ lutFile, lutPath }, "Applying built-in LUT");
    }

    // Download watermark images, set their paths and input indices
    // Main input is always index 0; watermarks get indices 1, 2, …
    const wmExtraPaths: string[] = [];
    for (let i = 0; i < filters.pendingWatermarks.length; i++) {
      const { url, ref } = filters.pendingWatermarks[i]!;
      ref.inputIndex = i + 1;
      const wmExt = extname(url.split("?")[0] ?? "") || ".png";
      const wmPath = join(tmpDir, `watermark${i}${wmExt}`);
      try {
        await writeFile(wmPath, await downloadFile(url));
        ref.path = wmPath;
        wmExtraPaths.push(wmPath);
        logger.info({ url, wmPath, inputIndex: ref.inputIndex }, "Downloaded watermark image");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not download watermark image — the URL may have expired. Use a permanent image URL (e.g. imgur, catbox). Detail: ${msg}`);
      }
    }

    const repCount = Math.min(Math.max(opts.rep, 1), MAX_REP);
    const outExt = opts.forceGif ? ".gif" : getOutputExt(opts.mediaType);
    // When forcing GIF from a video, concat as if dealing with frames
    const concatMediaType = opts.forceGif ? "image" : opts.mediaType;

    // Normalise: scale down + trim → working copy.
    // For video inputs always use .mp4 as the intermediate container — formats like
    // .gif and .webm cannot hold H.264/AAC which normalise encodes to, so writing back
    // to the original extension would fail with "incorrect codec parameters".
    const normExt = opts.mediaType === "video" ? ".mp4" : opts.inputExt;
    const normPath = join(tmpDir, `norm${normExt}`);
    await normalise(inputPath, normPath, opts);

    // Replace __TC__ placeholder with the real drawtext timecode filter,
    // but only when the user explicitly put "timecode" in their effects chain.
    let videoSegments = filters.videoSegments;
    const hasTc = videoSegments.some(
      (seg) => seg.kind === "vf" && seg.filters.includes("__TC__"),
    );
    if (hasTc && opts.mediaType === "video") {
      const fr = await probeFrameRate(normPath);
      const fontPath = join(dirname(fileURLToPath(import.meta.url)), "assets", "arialbold.ttf");
      const tcFilter = `drawtext=fontfile='${fontPath}':timecode='00\\:00\\:00\\:00':rate=${fr}:text_align=R:fontcolor=white:fontsize=w/24:box=1:boxcolor=black:boxborderw=7*(text_h):x=(w-text_w)/1.1:y=(h-text_h)/1.12`;
      videoSegments = videoSegments.map((seg) =>
        seg.kind === "vf" && seg.filters.includes("__TC__")
          ? { kind: "vf" as const, filters: seg.filters.map((f) => (f === "__TC__" ? tcFilter : f)) }
          : seg,
      );
    }

    // Inject radar ComplexSegment now that we can probe real video dimensions
    if (filters.hasRadar && opts.mediaType === "video") {
      const { w, h } = await probeVideoDimensions(normPath);
      videoSegments = [
        ...videoSegments,
        {
          kind: "fc" as const,
          build: (inp: string, out: string, idx: number) =>
            [
              `${inp}format=yuv444p,split=4[_ra${idx}][_rb${idx}][_rc${idx}][_rd${idx}]`,
              `[_ra${idx}]waveform,hue=b=1.455,scale=${w}:${h},setsar=1:1[_raa${idx}]`,
              `[_rb${idx}][_raa${idx}]vstack[_rV${idx}]`,
              `[_rc${idx}]format=rgb24,histogram=colors_mode=coloronblack,hue=b=1.25,scale=${w}:${h},setsar=1:1[_rcc${idx}]`,
              `[_rd${idx}]vectorscope=color4,hue=b=1.9,scale=${w}:${h},setsar=1:1[_rdd${idx}]`,
              `[_rcc${idx}][_rdd${idx}]vstack[_rV2${idx}]`,
              `[_rV${idx}][_rV2${idx}]hstack,scale=${w}:${h},setsar=1:1,format=yuv420p${out}`,
            ].join(";"),
        },
      ];
    }

    // Inject tvsim: download displacement map, resolve input index and real dims
    const streamLoopPaths: string[] = [];
    if (filters.pendingTvsim && opts.mediaType === "video") {
      const { ref } = filters.pendingTvsim;
      ref.inputIndex = wmExtraPaths.length + 1; // after main (0) + watermarks
      const tvMapPath = join(tmpDir, "tvsim_map.mov");
      try {
        await writeFile(tvMapPath, await downloadFile("https://file.garden/aTXso15ukD3mnuPI/tv_sim_displacement_map.mov"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not download tvsim displacement map: ${msg}`);
      }
      streamLoopPaths.push(tvMapPath);
      const { w, h } = await probeVideoDimensions(normPath);
      // Resolve TVSIM_SCALE_PLACEHOLDER with real output dimensions
      videoSegments = videoSegments.map((seg) => {
        if (seg.kind !== "fc") return seg;
        const orig = seg.build;
        return {
          kind: "fc" as const,
          build: (inp: string, out: string, idx: number) =>
            orig(inp, out, idx).replace("TVSIM_SCALE_PLACEHOLDER", `scale=${w}:${h}`),
        };
      });
    }

    // Handle autotune: download carrier URL for use as a separate post-processing pass
    let autotuneCarrierPath: string | null = null;
    if (filters.pendingAutotune && !opts.forceGif) {
      const { url } = filters.pendingAutotune;
      const atPath = join(tmpDir, `autotune_carrier.mp3`);
      try {
        if (/youtube\.com|youtu\.be/i.test(url)) {
          await downloadYtAudio(url, atPath);
        } else {
          await writeFile(atPath, await downloadFile(url));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not download autotune carrier URL: ${msg}`);
      }
      autotuneCarrierPath = atPath;
    }

    // Handle nbfxearthquake: two-pass vidstab using external catbox earthquake video
    if (filters.hasNbfxEarthquake && opts.mediaType === "video") {
      const { w: eqW, h: eqH } = await probeVideoDimensions(normPath);
      const eqFr = await probeFrameRate(normPath);
      const eqD = opts.dur !== null ? Math.min(opts.dur, MAX_VIDEO_SEC) : MAX_VIDEO_SEC;
      const trfPath = join(tmpDir, "earthquake.trf");
      const eqSrcPath = join(tmpDir, "earthquake_src.mp4");
      try {
        await writeFile(eqSrcPath, await downloadFile("https://files.catbox.moe/z5p5y6.mp4"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not download earthquake source video: ${msg}`);
      }
      // Pass 1: generate trf from the external earthquake source video
      await spawnFfmpeg([
        "-hide_banner", "-loglevel", "error",
        "-stream_loop", "-1", "-i", eqSrcPath,
        "-vf", `fps=${eqFr},scale=${eqW}:${eqH},setsar=1:1,vidstabdetect=shakiness=10:accuracy=1:mincontrast=0:show=0:result=${trfPath}`,
        "-c:v", "libx264", "-preset", "ultrafast",
        "-t", String(eqD),
        "-movflags", "+faststart",
        "-f", "null", "-",
      ]);
      // Prepend vidstabtransform as the first vf filter
      videoSegments = [
        { kind: "vf" as const, filters: [`vidstabtransform=input=${trfPath}:smoothing=0:optalgo=avg:optzoom=0:zoom=15:invert=1`, "format=yuv420p"] },
        ...videoSegments,
      ];
    }

    // Substitute real dimensions + frame count into wmm3dripple placeholders
    if (filters.hasWmm3dripple && opts.mediaType === "video") {
      const [{ w: rW, h: rH }, rFc] = await Promise.all([
        probeVideoDimensions(normPath),
        probeFrameCount(normPath),
      ]);
      videoSegments = videoSegments.map((seg) => {
        if (seg.kind !== "vf") return seg;
        return {
          kind: "vf" as const,
          filters: seg.filters.map((f) =>
            f
              .replace(/WMM3DRIPPLE_W/g, String(rW))
              .replace(/WMM3DRIPPLE_H/g, String(rH))
              .replace(/WMM3DRIPPLE_FC/g, String(rFc)),
          ),
        };
      });
    }

    // Probe for audio stream — skip audio effects entirely if none present
    // (GIF output never has audio, so skip if forceGif)
    const srcHasAudio =
      !opts.forceGif &&
      opts.mediaType !== "image" &&
      (await probeHasAudio(normPath));

    // Compute audio/video duration ratio for rubberband tempo compensation.
    // If durations are unavailable or equal, ratio defaults to 1 (no correction).
    let tempoRatio = 1;
    let probedAudioDuration: number | null = null;
    if (srcHasAudio && filters.pitchSubparams.length > 0) {
      const { audioDuration, videoDuration } = await probeStreamDurations(normPath);
      probedAudioDuration = audioDuration;
      if (audioDuration && videoDuration && videoDuration > 0) {
        const ratio = audioDuration / videoDuration;
        if (isFinite(ratio) && !isNaN(ratio)) {
          tempoRatio = ratio;
          logger.info({ audioDuration, videoDuration, tempoRatio }, "Computed rubberband tempo ratio");
        }
      }
    }

    // If pitch is requested but no audio stream exists, fail loudly instead of silently skipping
    if (filters.pitchSubparams.length > 0 && !srcHasAudio) {
      throw new Error("pitch requires an audio stream, but none was found in this file");
    }

    const audioFC = srcHasAudio
      ? (filters.rawFfmpegAudio ?? buildAudioFilterComplex(filters.pitchSubparams, filters.audioFilters, tempoRatio, opts.dur ?? probedAudioDuration))
      : null;

    // Handle sierpinskiransomware: overrides normal processing with 2×2 grid of different speeds
    if (filters.hasSierpinski && opts.mediaType === "video" && !opts.forceGif) {
      const { w: szW, h: szH } = await probeVideoDimensions(normPath);
      const szFr = await probeFrameRate(normPath);
      const szD = (opts.dur !== null ? Math.min(opts.dur, MAX_VIDEO_SEC) : MAX_VIDEO_SEC).toFixed(6);
      const sierpFC = [
        `[0]split=6[_sv_i0][_sv_i1][_sv_i2][_sv_i3][_sv_i4][_sv_i5]`,
        `asplit=6[_sa_i0][_sa_i1][_sa_i2][_sa_i3][_sa_i4][_sa_i5]`,
        `[_sv_i0]null,trim=0:${szD}[_sv1]`,
        `[_sv_i1]null,trim=0:${szD}[_sv2a];[_sv_i2]negate,trim=0:${szD}[_sv2b];[_sv2a][_sv2b]concat=2:1:0,setpts=1/2*PTS,fps=${szFr},trim=0:${szD}[_sv2]`,
        `[_sa_i0]atrim=0:${szD}[_sa1]`,
        `[_sa_i1]rubberband=2:2,atrim=0:${szD}[_sa2a];[_sa_i2]rubberband=2:2,atrim=0:${szD}[_sa2b];[_sa2a][_sa2b]concat=2:0:1,atrim=0:${szD}[_sa2]`,
        `[_sv_i3]null,trim=0:${szD}[_sv3a];[_sv_i4]negate,trim=0:${szD}[_sv3b];[_sv3a][_sv3b]concat=2:1:0,setpts=1/1.333*PTS,fps=${szFr},trim=0:${szD}[_sv3]`,
        `[_sa_i3]rubberband=1.333:1.333,atrim=0:${szD}[_sa3a];[_sa_i4]rubberband=1.333:1.333,atrim=0:${szD}[_sa3b];[_sa3a][_sa3b]concat=2:0:1,atrim=0:${szD}[_sa3]`,
        `[_sv_i5]setpts=1/0.5*PTS,fps=${szFr},trim=0:${szD}[_sv4]`,
        `[_sa_i5]rubberband=0.5:0.5,atrim=0:${szD}[_sa4]`,
        `[_sv1][_sv2]hstack[_stmp1];[_sv3][_sv4]hstack[_stmp2];[_stmp1][_stmp2]vstack,scale=${szW}:${szH}[_sv_out]`,
        `[_sa1][_sa2][_sa3][_sa4]amix=4,alimiter=2:latency=1,highpass=40[_sa_out]`,
      ].join(";");

      const szClips: string[] = [];
      let szInput = normPath;
      for (let i = 0; i < repCount; i++) {
        const szOut = join(tmpDir, `sierpinski${i}${outExt}`);
        await spawnFfmpeg([
          "-y", "-i", szInput,
          "-filter_complex", sierpFC,
          "-map", "[_sv_out]", "-map", "[_sa_out]",
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
          "-c:a", "flac",
          "-t", szD,
          szOut,
        ]);
        szClips.push(szOut);
        szInput = szOut;
      }

      let szFinalPath: string;
      if (szClips.length === 1) {
        szFinalPath = szClips[0]!;
      } else {
        szFinalPath = join(tmpDir, `final${outExt}`);
        await concatClips(szClips, szFinalPath, "video", tmpDir);
      }
      return { buffer: await readFile(szFinalPath), ext: outExt, contentType: getContentType(outExt) };
    }

    // Handle lsc: temporal split-screen with thumbnail overlay and text label.
    // Inputs: 0=main, 1=thumb({iv}), 2=main, 3=thumb({iv})
    // Main video is split at its midpoint; {iv} is scaled to 1/4 size as overlay thumbnail.
    // When no URL is given, main = {iv} = normPath (same file used for all 4 inputs).
    if (filters.pendingLsc && opts.mediaType === "video" && !opts.forceGif) {
      const { text, videoUrl } = filters.pendingLsc;

      // Main video: URL if provided, otherwise the base {iv} video
      const lscMainPath = videoUrl ? join(tmpDir, "lsc_main.mp4") : normPath;
      if (videoUrl) {
        try {
          await writeFile(lscMainPath, await downloadFile(videoUrl));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`lsc: could not download video URL: ${msg}`);
        }
      }

      // Thumbnail overlay: always the base {iv} video (normPath)
      const lscThumbPath = normPath;

      // Duration and audio always come from {iv} (normPath), not the URL video
      const { duration: lscDur } = await probeMediaMeta(normPath);
      if (!lscDur || lscDur <= 0) throw new Error("lsc: could not determine {iv} duration");
      const half = (lscDur / 2).toFixed(6);
      const lscHasAudio = await probeHasAudio(normPath);

      const safeText = text
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\u2019")
        .replace(/:/g, "\\:")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]");

      const lscFontPath = join(dirname(fileURLToPath(import.meta.url)), "assets", "arialbold.ttf");

      // 4 inputs: [0]=main, [1]=thumb, [2]=main, [3]=thumb
      // [0:v] → first half of main; [1:v] → thumbnail for first half
      // [2:v] → second half of main; [3:v] → thumbnail for second half
      const videoChain = [
        `[0:v]trim=0:${half},setpts=PTS-STARTPTS[_lia]`,
        `[1:v]setpts=PTS-STARTPTS,scale=iw/2:ih/2[_lia2]`,
        `[2:v]trim=${half},setpts=PTS-STARTPTS[_lib]`,
        `[3:v]setpts=PTS-STARTPTS,scale=iw/2:ih/2[_lib2]`,
        `[_lia][_lia2]overlay=0:0[_lpart1]`,
        `[_lib][_lib2]overlay=W/2:H/2[_lpart2]`,
        `[_lpart1][_lpart2]concat=n=2:v=1:a=0,format=yuv420p,` +
          `drawtext=fontfile='${lscFontPath}':text='${safeText}':fontsize=50:fontcolor=white` +
          `:box=1:boxcolor=black@0.5:boxborderw=10:x=(w-tw-10):y=10[vout]`,
      ];

      // Audio from {iv} (inputs 1/3 = normPath): trim each half then concat
      const audioChain = lscHasAudio ? [
        `[1:a]atrim=0:${half},asetpts=PTS-STARTPTS,aresample=44100[_laa]`,
        `[3:a]atrim=${half},asetpts=PTS-STARTPTS,aresample=44100[_lab]`,
        `[_laa][_lab]concat=n=2:v=0:a=1[aout]`,
      ] : [];

      const lscFC = [...videoChain, ...audioChain].join(";");
      const lscMaps = lscHasAudio
        ? ["-map", "[vout]", "-map", "[aout]"]
        : ["-map", "[vout]"];
      const lscAudioArgs = lscHasAudio
        ? ["-c:a", "aac", "-b:a", "128k"]
        : ["-an"];

      const lscClips: string[] = [];
      let lscMainCurrent = lscMainPath;
      for (let i = 0; i < repCount; i++) {
        const lscOut = join(tmpDir, `lsc${i}${outExt}`);
        await spawnFfmpeg([
          "-y",
          "-i", lscMainCurrent,  // 0: main video (first half source + audio)
          "-i", lscThumbPath,    // 1: thumbnail overlay for first half
          "-i", lscMainCurrent,  // 2: main video (second half source + audio)
          "-i", lscThumbPath,    // 3: thumbnail overlay for second half
          "-filter_complex", lscFC,
          ...lscMaps,
          "-t", String(lscDur),
          "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p",
          ...lscAudioArgs,
          "-movflags", "+faststart",
          lscOut,
        ]);
        lscClips.push(lscOut);
        lscMainCurrent = lscOut;
      }

      let lscFinalPath: string;
      if (lscClips.length === 1) {
        lscFinalPath = lscClips[0]!;
      } else {
        lscFinalPath = join(tmpDir, `final${outExt}`);
        await concatClips(lscClips, lscFinalPath, "video", tmpDir);
      }
      return { buffer: await readFile(lscFinalPath), ext: outExt, contentType: getContentType(outExt) };
    }

    const clips: string[] = [];
    let currentPath = normPath;
    for (let i = 0; i < repCount; i++) {
      const clipPath = join(tmpDir, `clip${i}${outExt}`);
      await runFfmpeg(currentPath, clipPath, videoSegments, audioFC, srcHasAudio, opts, wmExtraPaths, undefined, streamLoopPaths);
      if (autotuneCarrierPath && srcHasAudio) {
        const atClipPath = join(tmpDir, `clip${i}_at${outExt}`);
        await runAutotune(clipPath, autotuneCarrierPath, atClipPath, opts);
        clips.push(atClipPath);
        currentPath = atClipPath;
      } else {
        clips.push(clipPath);
        currentPath = clipPath;
      }
    }

    let finalPath: string;
    if (clips.length === 1) {
      finalPath = clips[0]!;
    } else {
      finalPath = join(tmpDir, `final${outExt}`);
      await concatClips(clips, finalPath, concatMediaType, tmpDir);
    }

    const buf = await readFile(finalPath);
    return { buffer: buf, ext: outExt, contentType: getContentType(outExt) };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function normalise(src: string, dst: string, opts: ProcessOptions): Promise<void> {
  const args: string[] = ["-y"];
  const maxSec =
    opts.dur !== null
      ? Math.min(opts.dur, MAX_VIDEO_SEC)
      : opts.mediaType !== "image"
        ? MAX_VIDEO_SEC
        : null;
  if (maxSec !== null) args.push("-t", String(maxSec));
  args.push("-i", src);

  if (opts.mediaType === "image") {
    args.push(
      "-vf",
      `scale='min(iw,${MAX_SIDE_PX})':'min(ih,${MAX_SIDE_PX})':force_original_aspect_ratio=decrease`,
      "-frames:v", "1",
    );
  } else if (opts.mediaType === "video") {
    args.push(
      "-vf",
      `scale='min(iw,${MAX_SIDE_PX})':'min(ih,${MAX_SIDE_PX})':force_original_aspect_ratio=decrease:flags=lanczos,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
    );
  } else {
    args.push("-c:a", "copy");
  }

  args.push(dst);
  await spawnFfmpeg(args);
}

async function runFfmpeg(
  inputPath: string,
  outputPath: string,
  videoSegments: VideoSegment[],
  audioFC: ReturnType<typeof buildAudioFilterComplex>,
  srcHasAudio: boolean,
  opts: ProcessOptions,
  extraInputs: string[] = [],
  audioSrcPath?: string,
  streamLoopInputs: string[] = [],
): Promise<void> {
  const args: string[] = ["-y", "-i", inputPath];
  // Watermark PNGs/images are looped so they last the full video duration
  for (const extra of extraInputs) args.push("-loop", "1", "-i", extra);
  // Stream-loop video inputs (e.g. displacement maps) use -stream_loop -1
  for (const sl of streamLoopInputs) args.push("-stream_loop", "-1", "-i", sl);

  // When audio should come from a different file (e.g. normPath during cumulative reps),
  // add it as an extra input and remap [0:a] → [N:a] in the filter complex.
  let effectiveAudioFC = audioFC;
  if (audioSrcPath && audioSrcPath !== inputPath && audioFC) {
    const audioInputIdx = 1 + extraInputs.length + streamLoopInputs.length; // after main + watermarks + stream loops
    args.push("-i", audioSrcPath);
    const remapped = audioFC.filterComplex.replace(/\[0:a\]/g, `[${audioInputIdx}:a]`);
    effectiveAudioFC = { filterComplex: remapped, audioMap: audioFC.audioMap };
  }

  const isImage  = opts.mediaType === "image";
  const hasVideo = isImage || opts.mediaType === "video";
  const hasAudio = srcHasAudio && (opts.mediaType === "audio" || opts.mediaType === "video");
  const outExt   = getOutputExt(opts.mediaType);

  if (isImage) args.push("-frames:v", "1");

  // For GIF output, append fps filter at the end of the video chain
  const effectiveSegments: VideoSegment[] =
    outExt === ".gif"
      ? [...videoSegments, { kind: "vf", filters: ["fps=10"] }]
      : videoSegments;

  // Assemble video filters (null when no video effects and not GIF)
  let videoAsm = hasVideo
    ? assembleVideoSegments(effectiveSegments)
    : null;

  // ── filter args ────────────────────────────────────────────────────────────
  if (videoAsm?.kind === "fc" && effectiveAudioFC) {
    // Both video FC and audio FC → merge into one filter_complex
    args.push("-filter_complex", `${videoAsm.fc};${effectiveAudioFC.filterComplex}`);
    args.push("-map", videoAsm.voutLabel, "-map", effectiveAudioFC.audioMap);

  } else if (videoAsm?.kind === "fc") {
    // Video FC only
    args.push("-filter_complex", videoAsm.fc);
    args.push("-map", videoAsm.voutLabel);
    if (hasAudio) args.push("-map", "0:a?");

  } else if (videoAsm?.kind === "vf" && effectiveAudioFC) {
    // Simple VF + audio FC → single filter_complex
    args.push(
      "-filter_complex",
      `[0]${videoAsm.filter}[vout];${effectiveAudioFC.filterComplex}`,
    );
    args.push("-map", "[vout]", "-map", effectiveAudioFC.audioMap);

  } else if (videoAsm?.kind === "vf") {
    // Simple VF only — audio codec is set in the codec section below, don't add it here
    args.push("-vf", videoAsm.filter);

  } else if (effectiveAudioFC) {
    // Audio processing only (no video effects)
    args.push("-filter_complex", effectiveAudioFC.filterComplex);
    args.push("-map", effectiveAudioFC.audioMap);
    if (hasVideo) args.push("-map", "0:v");
  }

  // GIF with no video segments still needs a scale+fps vf
  if (outExt === ".gif" && !videoAsm) {
    args.push("-vf", `fps=10,scale=${MAX_SIDE_PX}:-2:flags=lanczos`);
  }

  // ── codec / container args ─────────────────────────────────────────────────
  if (outExt === ".gif") {
    args.push("-loop", "0");
    if (opts.dur !== null)
      args.push("-r", String(Math.max(1, Math.round(1 / opts.dur))));
  } else if (outExt === ".mp4") {
    if (videoAsm) {
      args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p");
    } else {
      args.push("-c:v", "copy");
    }
    if (hasAudio) args.push("-c:a", "aac");
    args.push("-movflags", "+faststart");
  } else if (outExt === ".mp3") {
    args.push("-c:a", "libmp3lame", "-q:a", "4", "-vn");
  }

  args.push(outputPath);
  logger.debug({ cmd: `ffmpeg ${args.join(" ")}` }, "Running ffmpeg");
  await spawnFfmpeg(args);
}

async function concatClips(
  clips: string[],
  dst: string,
  mediaType: MediaType,
  tmpDir: string,
): Promise<void> {
  if (mediaType === "image") {
    // Concat GIF frames: each clip is a single-frame GIF → animated GIF slideshow
    const inputs: string[] = [];
    for (const c of clips) inputs.push("-i", c);
    const filterInputs = clips.map((_, i) => `[${i}:v]`).join("");
    await spawnFfmpeg([
      "-y", ...inputs,
      "-filter_complex", `${filterInputs}concat=n=${clips.length}:v=1:a=0[vout]`,
      "-map", "[vout]", "-loop", "0", dst,
    ]);
    return;
  }
  // Video / audio: use concat demuxer (stream-copy, no re-encode)
  const listLines = clips.map((c) => `file '${c}'`).join("\n");
  const listPath = join(tmpDir, "concat.txt");
  await writeFile(listPath, listLines);
  await spawnFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", dst]);
}

export async function runAutotune(
  inputPath: string,
  carrierPath: string,
  outputPath: string,
  opts: ProcessOptions,
): Promise<void> {
  const aphaseShifts = Array(10).fill("aphaseshift=shift=1:order=16").join(",");
  const atTrim = opts.dur !== null
    ? `atrim=start=0.02:end=${0.02 + opts.dur},asetpts=PTS-STARTPTS`
    : `atrim=0.02`;
  const filterComplex =
    `[0:a]aresample=44100,volume=0.07,highpass=1500,acrusher=bits=16:samples=1:mix=1,rubberband=pitch=2^(0/12)[mod];` +
    `[1:a]aresample=176400,volume=0.5[carr];` +
    `[mod][carr]anlms=out_mode=e:order=3600:mu=0.005:leakage=0.0015:eps=0.15[voc];` +
    `[voc]volume=64,${aphaseShifts},${atTrim}[a]`;
  const args: string[] = [
    "-y",
    "-i", inputPath,
    "-stream_loop", "-1", "-i", carrierPath,
    "-filter_complex", filterComplex,
  ];
  if (opts.mediaType === "video") {
    args.push("-map", "0:v", "-map", "[a]", "-c:v", "copy");
  } else {
    args.push("-map", "[a]");
  }
  args.push("-ac", "1", "-c:a", "aac", "-ar", "44100", "-movflags", "+faststart", outputPath);
  logger.debug({ cmd: `ffmpeg ${args.join(" ")}` }, "Running autotune ffmpeg");
  await spawnFfmpeg(args);
}

async function spawnFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const frei0rPath = getFrei0rPath();
    const env = frei0rPath
      ? { ...process.env, FREI0R_PATH: frei0rPath }
      : process.env;
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"], env });
    // Rolling stderr cap: keep only the last 8 KB to avoid heap bloat on long jobs
    const MAX_STDERR = 8192;
    let stderrTail = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderrTail += d.toString();
      if (stderrTail.length > MAX_STDERR) stderrTail = stderrTail.slice(-MAX_STDERR);
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg exited ${code}: ${stderrTail.slice(-800)}`));
      } else resolve();
    });
    proc.on("error", (err) => reject(err));
  });
}

/** Probe a media URL for its duration (in seconds). Returns null if unavailable. */
export async function probeMediaMeta(url: string): Promise<{ duration: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", url],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    const timer = setTimeout(() => { proc.kill(); resolve({ duration: null }); }, 10_000);
    proc.on("close", () => {
      clearTimeout(timer);
      const dur = parseFloat(out.trim());
      resolve({ duration: isNaN(dur) ? null : dur });
    });
    proc.on("error", () => { clearTimeout(timer); resolve({ duration: null }); });
  });
}

/** Probe separate audio and video stream durations from a local file. */
async function probeStreamDurations(filePath: string): Promise<{ audioDuration: number | null; videoDuration: number | null }> {
  const probe = (selectStreams: string): Promise<number | null> =>
    new Promise((resolve) => {
      const proc = spawn(
        "ffprobe",
        ["-v", "error", "-select_streams", selectStreams, "-show_entries", "stream=duration", "-of", "csv=p=0", filePath],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let out = "";
      proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      proc.on("close", () => {
        const dur = parseFloat(out.trim().split("\n")[0] ?? "");
        resolve(isNaN(dur) ? null : dur);
      });
      proc.on("error", () => resolve(null));
    });
  const [audioDuration, videoDuration] = await Promise.all([probe("a:0"), probe("v:0")]);
  return { audioDuration, videoDuration };
}


async function probeFrameRate(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", filePath],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => {
      const raw = out.trim().split("\n")[0] ?? "";
      resolve(raw || "30");
    });
    proc.on("error", () => resolve("30"));
  });
}

async function probeFrameCount(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames", "-of", "csv=p=0", filePath],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => {
      const n = parseInt(out.trim().split("\n")[0] ?? "", 10);
      resolve(n > 0 ? n : 30);
    });
    proc.on("error", () => resolve(30));
  });
}

export async function probeVideoDimensions(filePath: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", filePath],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => {
      const parts = out.trim().split(",");
      const w = parseInt(parts[0] ?? "0", 10);
      const h = parseInt(parts[1] ?? "0", 10);
      resolve((w > 0 && h > 0) ? { w, h } : { w: 640, h: 360 });
    });
    proc.on("error", () => resolve({ w: 640, h: 360 }));
  });
}

export async function probeHasAudio(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", filePath],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => resolve(out.trim().length > 0));
    proc.on("error", () => resolve(false));
  });
}

async function downloadYtAudio(url: string, outPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("yt-dlp", [
      "--no-playlist",
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "--extractor-args", "youtube:player_client=ios,web_creator",
      "--no-check-certificates",
      "-o", outPath,
      url,
    ]);
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(-300)}`));
    });
    proc.on("error", (err) => reject(new Error(`yt-dlp spawn error: ${err.message}`)));
  });
}

async function downloadFile(url: string): Promise<Buffer> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };
  if (/discordapp\.(com|net)|discord\.com/i.test(url)) {
    headers["Referer"] = "https://discord.com/";
  }
  const res = await axios.get<Buffer>(url, {
    responseType: "arraybuffer",
    timeout: 30_000,
    maxContentLength: 100 * 1024 * 1024,
    headers,
  });
  return Buffer.from(res.data);
}

function getOutputExt(mediaType: MediaType): string {
  if (mediaType === "audio") return ".mp3";
  if (mediaType === "video") return ".mp4";
  return ".gif";
}

function getContentType(ext: string): string {
  switch (ext) {
    case ".gif":  return "image/gif";
    case ".mp4":  return "video/mp4";
    case ".mp3":  return "audio/mpeg";
    default:      return "application/octet-stream";
  }
}

export function detectMediaType(filename: string, contentType: string): MediaType {
  const ext = extname(filename).toLowerCase();
  if ([".mp3", ".ogg", ".wav", ".flac", ".m4a", ".aac"].includes(ext)) return "audio";
  if ([".mp4", ".webm", ".mov", ".avi", ".mkv", ".gif"].includes(ext)) return "video";
  if ([".jpg", ".jpeg", ".png", ".webp", ".bmp"].includes(ext)) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  return "image";
}
