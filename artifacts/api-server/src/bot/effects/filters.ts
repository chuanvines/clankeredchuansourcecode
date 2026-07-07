import { ParsedEffect, parseEffectsString } from "./parser.js";

// ── Segment types ─────────────────────────────────────────────────────────────

/** A run of simple comma-chainable ffmpeg filters (usable with -vf). */
export type SimpleSegment = { kind: "vf"; filters: string[] };

/**
 * A complex filter that needs its own filter_complex labels (e.g. mirror uses
 * split/hstack). `build` receives the input label, output label, and a unique
 * index so internal labels never collide when the effect is used multiple times.
 * The returned string may contain `;`-separated sub-parts internally.
 */
export type ComplexSegment = {
  kind: "fc";
  build: (inp: string, out: string, idx: number) => string;
};

export type VideoSegment = SimpleSegment | ComplexSegment;

// ── FilterResult ──────────────────────────────────────────────────────────────

/** A pending HALD CLut entry: the path is filled in by processMedia before runFfmpeg. */
export type PendingHald = { hue: string; type: "yuv" | "modulate"; ref: { path: string } };

/** A pending watermark entry: path and inputIndex are filled in by processMedia before runFfmpeg. */
export type PendingWatermark = { url: string; ref: { path: string; inputIndex: number } };

/** A pending URL-based lut3d entry: path is filled in by processMedia before runFfmpeg. */
export type PendingLut = { url: string; ref: { path: string } };

export type PendingTvsim = {
  linesync: number;
  zoomgrill: number;
  ref: { inputIndex: number };
};

export type PendingAutotune = {
  url: string;
  ref: { inputIndex: number };
};

export type PendingLsc = {
  text: string;
  videoUrl: string | null;
};

export type FilterResult = {
  videoSegments: VideoSegment[];
  pitchSubparams: string[];
  audioFilters: string[];
  pendingHalds: PendingHald[];
  pendingWatermarks: PendingWatermark[];
  pendingLuts: PendingLut[];
  builtinLuts: string[];
  rawFfmpegAudio: { filterComplex: string; audioMap: string } | null;
  hasRadar: boolean;
  pendingTvsim: PendingTvsim | null;
  pendingAutotune: PendingAutotune | null;
  hasSierpinski: boolean;
  hasNbfxEarthquake: boolean;
  hasWmm3dripple: boolean;
  pendingLsc: PendingLsc | null;
};

// ── Assembly ──────────────────────────────────────────────────────────────────

/**
 * Assemble video segments into ffmpeg filter args.
 * Returns null when there are no video segments.
 * Returns `{ kind: "vf", filter }` when only simple filters are present.
 * Returns `{ kind: "fc", fc, voutLabel }` when any complex segment is present.
 */
export function assembleVideoSegments(
  segments: VideoSegment[],
  srcLabel = "[0]",
): | { kind: "vf"; filter: string }
  | { kind: "fc"; fc: string; voutLabel: string }
  | null {
  // Merge consecutive vf segments, drop empty ones
  const merged: VideoSegment[] = [];
  for (const seg of segments) {
    if (seg.kind === "vf" && seg.filters.length === 0) continue;
    const last = merged[merged.length - 1];
    if (seg.kind === "vf" && last?.kind === "vf") {
      last.filters.push(...seg.filters);
    } else {
      merged.push(
        seg.kind === "vf"
          ? { kind: "vf", filters: [...seg.filters] }
          : seg,
      );
    }
  }

  if (merged.length === 0) return null;

  const hasFC = merged.some((s) => s.kind === "fc");

  if (!hasFC) {
    const filters = (merged as SimpleSegment[]).flatMap((s) => s.filters);
    return { kind: "vf", filter: filters.join(",") };
  }

  // Build a single filter_complex string chaining all segments
  const parts: string[] = [];
  let inp = srcLabel;

  for (let i = 0; i < merged.length; i++) {
    const seg = merged[i]!;
    const isLast = i === merged.length - 1;
    const out = isLast ? "[vout]" : `[vs${i}]`;

    if (seg.kind === "vf") {
      parts.push(`${inp}${seg.filters.join(",")}${out}`);
    } else {
      // FC segment may contain `;`-separated sub-parts
      parts.push(seg.build(inp, out, i));
    }
    inp = out;
  }

  return { kind: "fc", fc: parts.join(";"), voutLabel: "[vout]" };
}

/**
 * Assemble inner video segments (from a nested `buildFilters` call) into a
 * single filtergraph string. Uses `idxBase` to generate unique pad labels that
 * cannot collide with the outer assembly.
 */
function assembleInner(
  segments: VideoSegment[],
  srcLabel: string,
  outLabel: string,
  idxBase: number,
): string {
  const merged: VideoSegment[] = [];
  for (const seg of segments) {
    if (seg.kind === "vf" && seg.filters.length === 0) continue;
    const last = merged[merged.length - 1];
    if (seg.kind === "vf" && last?.kind === "vf") {
      last.filters.push(...seg.filters);
    } else {
      merged.push(seg.kind === "vf" ? { kind: "vf", filters: [...seg.filters] } : seg);
    }
  }
  if (merged.length === 0) return `${srcLabel}null${outLabel}`;
  const parts: string[] = [];
  let inp = srcLabel;
  for (let i = 0; i < merged.length; i++) {
    const seg = merged[i]!;
    const isLast = i === merged.length - 1;
    const out = isLast ? outLabel : `[_inn_${idxBase}_${i}]`;
    if (seg.kind === "vf") {
      parts.push(`${inp}${seg.filters.join(",")}${out}`);
    } else {
      parts.push(seg.build(inp, out, idxBase * 100 + i));
    }
    inp = out;
  }
  return parts.join(";");
}

// ── buildFilters ──────────────────────────────────────────────────────────────

export function buildFilters(effects: ParsedEffect[]): FilterResult {
  const videoSegments: VideoSegment[] = [];
  const audioFilters: string[] = [];
  let pitchSubparams: string[] = [];
  const pendingHalds: PendingHald[] = [];
  const pendingWatermarks: PendingWatermark[] = [];
  const pendingLuts: PendingLut[] = [];
  const builtinLuts: string[] = [];
  let rawFfmpegAudio: FilterResult["rawFfmpegAudio"] = null;
  let hasRadar = false;
  let pendingTvsim: PendingTvsim | null = null;
  let pendingAutotune: PendingAutotune | null = null;
  let hasSierpinski = false;
  let hasNbfxEarthquake = false;
  let hasWmm3dripple = false;
  let pendingLsc: PendingLsc | null = null;

  for (const effect of effects) {
    switch (effect.name) {
      // ── audio effects ──────────────────────────────────────────────
      case "pitch":
        pitchSubparams = effect.subparams;
        break;

      case "volume": {
        const v = effect.param ?? "1.5";
        audioFilters.push(`volume=${v}`);
        break;
      }

      case "areverse":
        audioFilters.push("areverse", "asetpts=PTS-STARTPTS");
        break;

      case "vibrato": {
        const freq  = effect.subparams[0] ?? "5";
        const depth = effect.subparams[1] ?? "0.5";
        audioFilters.push(`vibrato=f=${freq}:d=${depth}`);
        break;
      }

      case "acontrast": {
        const c = effect.param ?? "33";
        audioFilters.push(`acontrast=${c}`);
        break;
      }

      case "adestroy":
        audioFilters.push(
          "acontrast=100",
          "acontrast=100",
          "acontrast=100",
          "acontrast=100",
          "acontrast=100",
        );
        break;

      case "4ormulator": {
        const dial = effect.param ?? "712923000";
        audioFilters.push(`rubberband=tempo=1:formant=${dial}:pitch=1`);
        break;
      }

      case "audioequalizer": {
        const subbass  = effect.subparams[0] ?? "0";
        const bass     = effect.subparams[1] ?? "0";
        const lowmids  = effect.subparams[2] ?? "0";
        const mids     = effect.subparams[3] ?? "0";
        const highmids = effect.subparams[4] ?? "0";
        for (const [freq, gain] of [
          ["40",   subbass],
          ["150",  bass],
          ["375",  lowmids],
          ["1000", mids],
          ["3000", highmids],
        ] as [string, string][]) {
          audioFilters.push(`equalizer=f=${freq}:width_type=q:width=1:g=${gain}`);
        }
        break;
      }

      case "autotune": {
        if (!effect.param) break;
        const atRef: { inputIndex: number } = { inputIndex: -1 };
        pendingAutotune = { url: effect.param, ref: atRef };
        break;
      }

      case "avflip": {
        rawFfmpegAudio = {
          filterComplex:
            `aresample=44100,` +
            `rubberband=tempo=0.05:smoothing=712923000:window=long,` +
            `afftfilt=real='real((1216000/b),ch)':imag='imag((1216000/b),ch)':overlap=1:win_size=65536:win_func=bharris,` +
            `rubberband=tempo=20:smoothing=712923000:window=long,` +
            `volume=8,aformat=channel_layouts=mono[aout]`,
          audioMap: "[aout]",
        };
        break;
      }

      // ── video effects ──────────────────────────────────────────────
      case "hflip":
        vf(videoSegments, "hflip");
        break;

      case "vflip":
        vf(videoSegments, "vflip");
        break;

      case "leftsplit": {
        const innerEffects = parseEffectsString(effect.param ?? "hflip");
        const innerResult = buildFilters(innerEffects);
        pendingHalds.push(...innerResult.pendingHalds);
        pendingWatermarks.push(...innerResult.pendingWatermarks);
        pendingLuts.push(...innerResult.pendingLuts);
        builtinLuts.push(...innerResult.builtinLuts);
        if (innerResult.pendingTvsim && !pendingTvsim) pendingTvsim = innerResult.pendingTvsim;
        if (innerResult.pendingAutotune && !pendingAutotune) pendingAutotune = innerResult.pendingAutotune;
        const lsSegs = innerResult.videoSegments;
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) => {
            const innerStr = assembleInner(lsSegs, `[_ls_b_${idx}]`, `[_ls_inner_${idx}]`, idx + 1000);
            return [
              `${inp}hflip,split=2[_ls_a_${idx}][_ls_b_${idx}]`,
              `[_ls_a_${idx}]crop=iw/2:ih:0:0[_ls_norm_${idx}]`,
              innerStr,
              `[_ls_inner_${idx}]crop=iw/2:ih:iw/2:0[_ls_okey_${idx}]`,
              `[_ls_norm_${idx}][_ls_okey_${idx}]hstack,hflip${out}`,
            ].join(";");
          },
        });
        break;
      }

      case "rightsplit": {
        const innerEffects = parseEffectsString(effect.param ?? "hflip");
        const innerResult = buildFilters(innerEffects);
        pendingHalds.push(...innerResult.pendingHalds);
        pendingWatermarks.push(...innerResult.pendingWatermarks);
        pendingLuts.push(...innerResult.pendingLuts);
        builtinLuts.push(...innerResult.builtinLuts);
        if (innerResult.pendingTvsim && !pendingTvsim) pendingTvsim = innerResult.pendingTvsim;
        if (innerResult.pendingAutotune && !pendingAutotune) pendingAutotune = innerResult.pendingAutotune;
        const rsSegs = innerResult.videoSegments;
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) => {
            const innerStr = assembleInner(rsSegs, `[_rs_b_${idx}]`, `[_rs_inner_${idx}]`, idx + 2000);
            return [
              `${inp}split=2[_rs_a_${idx}][_rs_b_${idx}]`,
              `[_rs_a_${idx}]crop=iw/2:ih:0:0[_rs_norm_${idx}]`,
              innerStr,
              `[_rs_inner_${idx}]crop=iw/2:ih:iw/2:0[_rs_okey_${idx}]`,
              `[_rs_norm_${idx}][_rs_okey_${idx}]hstack${out}`,
            ].join(";");
          },
        });
        break;
      }

      case "invert":
        vf(videoSegments, "negate");
        break;

      case "swapuv":
        vf(videoSegments, "colorchannelmixer=0:0:1:0:0:1:0:0:1:0:0:0:0:0:0:1");
        break;

      case "vreverse":
        vf(videoSegments, "reverse");
        break;

      case "invlum":
        builtinLuts.push("AccurateInvertLuminosity.cube");
        break;

      case "invertrgb": {
        const rI = effect.subparams[0] ?? "0";
        const gI = effect.subparams[1] ?? "0";
        const bI = effect.subparams[2] ?? "0";
        vf(
          videoSegments,
          `lutrgb=r=${rI !== "0" ? "negval" : "val"}:g=${gI !== "0" ? "negval" : "val"}:b=${bI !== "0" ? "negval" : "val"}`,
        );
        break;
      }

      case "channelblend": {
        const srcR = (effect.subparams[0] ?? "r").toLowerCase();
        const srcG = (effect.subparams[1] ?? "g").toLowerCase();
        const srcB = (effect.subparams[2] ?? "b").toLowerCase();
        const mix = (src: string, ch: string) =>
          `${ch}r=${src === "r" ? 1 : 0}:${ch}g=${src === "g" ? 1 : 0}:${ch}b=${src === "b" ? 1 : 0}`;
        vf(
          videoSegments,
          `colorchannelmixer=${mix(srcR, "r")}:${mix(srcG, "g")}:${mix(srcB, "b")}`,
        );
        break;
      }

      case "rotate": {
        const deg = effect.param ?? "0";
        const rad = `${deg}*PI/180`;
        vf(videoSegments, `rotate=${rad}`);
        break;
      }

      case "blur": {
        const s = Math.max(1, Math.round(parseFloat(effect.param ?? "5")));
        // boxblur expects integer luma/chroma radius
        vf(videoSegments, `boxblur=${s}:${Math.max(1, Math.round(s / 2))}`);
        break;
      }

      case "brightness": {
        const b = effect.param ?? "0.1";
        vf(videoSegments, `eq=brightness=${b}`);
        break;
      }

      case "contrast": {
        const c = effect.param ?? "1.5";
        vf(videoSegments, `eq=contrast=${c}`);
        break;
      }

      case "saturation": {
        const s = effect.param ?? "1.5";
        vf(videoSegments, `eq=saturation=${s}`);
        break;
      }

      case "hue": {
        const hue = effect.param ?? "0";
        const haldRef: PendingHald["ref"] = { path: "" };
        pendingHalds.push({ hue, type: "yuv", ref: haldRef });
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            `movie=${haldRef.path}[_hclut${idx}];${inp}[_hclut${idx}]haldclut${out}`,
        });
        break;
      }

      case "huehsv": {
        const hue = effect.param ?? "180";
        const haldRef: PendingHald["ref"] = { path: "" };
        pendingHalds.push({ hue, type: "modulate", ref: haldRef });
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            `movie=${haldRef.path}[_hclut${idx}];${inp}[_hclut${idx}]haldclut${out}`,
        });
        break;
      }

      case "fisheye": {
        const s  = effect.subparams[0] ?? "1";
        const cx = effect.subparams[1] ?? "0.5";
        const cy = effect.subparams[2] ?? "0.5";
        const r  = effect.subparams[3] ?? "1";
        const cxE = `W*${cx}`;
        const cyE = `H*${cy}`;
        const dnx = `W*0.5*${r}`;
        const dny = `H*0.5*${r}`;
        vf(
          videoSegments,
          "format=yuv444p",
          `geq='p(${cxE}+(X-${cxE})*(1-(${s})*gauss(-3.3333*pow(hypot((X-${cxE})/(${dnx}),(Y-${cyE})/(${dny})),2))),${cyE}+(Y-${cyE})*(1-(${s})*gauss(-3.3333*pow(hypot((X-${cxE})/(${dnx}),(Y-${cyE})/(${dny})),2))))'`,
          "scale=iw:ih",
          "format=yuv420p",
        );
        break;
      }

      case "swirl": {
        const a  = effect.subparams[0] ?? "90";
        const cx = effect.subparams[1] ?? "0.5";
        const cy = effect.subparams[2] ?? "0.5";
        const r  = effect.subparams[3] ?? "1";
        vf(
          videoSegments,
          "format=yuv444p",
          buildSwirlGeq(a, cx, cy, r),
          "scale=iw:ih",
          "format=yuv420p",
        );
        break;
      }

      case "wave":
        vf(videoSegments, ...buildWaveFilter(effect.subparams));
        break;

      case "ripple": {
        const speed     = effect.subparams[0] ?? "1";
        const frequency = effect.subparams[1] ?? "30";
        const amplitude = effect.subparams[2] ?? "10";
        const phase     = effect.subparams[3] ?? "0";
        const r = `hypot(X-W*0.5,Y-H*0.5)`;
        const disp = `(${r}+${amplitude}*sin(2*PI*${speed}*T-(${phase})+(-(${r})/${frequency})))`;
        const angle = `atan2(Y-H*0.5,X-W*0.5)`;
        vf(
          videoSegments,
          "format=yuv444p",
          `geq='p(W*0.5+${disp}*cos(${angle}),H*0.5+${disp}*sin(${angle}))'`,
          "scale=iw:ih",
          "format=yuv420p",
        );
        break;
      }

      case "scroll": {
        const params = effect.subparams;

        // hpos / ypos / vpos variant: scroll=hpos=0.5 or scroll=hpos=0.5;ypos=0.3
        if (params.some(p => p.startsWith("hpos=") || p.startsWith("ypos=") || p.startsWith("vpos="))) {
          const parts = params.map(p => p.replace(/^ypos=/, "vpos="));
          vf(videoSegments, `scroll=${parts.join(":")}`);
          break;
        }

        // Colon-separated animated pan: single subparam like "x1:y1:x2:y2[:dur]"
        const colonParts = params.length === 1 ? params[0]!.split(":") : [];
        const colonIsNumericPan = colonParts.length >= 4 && colonParts.slice(0, 4).every(p => !isNaN(parseFloat(p)));
        const panParts: string[] =
          colonIsNumericPan ? colonParts
          : params.length >= 4 && params.slice(0, 4).every(p => !isNaN(parseFloat(p))) ? params
          : [];

        if (panParts.length >= 4) {
          const x1 = parseFloat(panParts[0]!);
          const y1 = parseFloat(panParts[1]!);
          const x2 = parseFloat(panParts[2]!);
          const y2 = parseFloat(panParts[3]!);
          const dur = panParts[4] !== undefined ? parseFloat(panParts[4]) || 10 : 10;
          const dx = `${x1}+(${x2 - x1})*T/${dur}`;
          const dy = `${y1}+(${y2 - y1})*T/${dur}`;
          vf(videoSegments,
            "format=yuv444p",
            `geq='p(clip(X+${dx},0,W-1),clip(Y+${dy},0,H-1)):cb(clip(X+${dx},0,W-1),clip(Y+${dy},0,H-1)):cr(clip(X+${dx},0,W-1),clip(Y+${dy},0,H-1))'`,
            "scale=iw:ih",
            "format=yuv420p",
          );
          break;
        }

        // Default: continuous scroll h;v (0.0–1.0 per axis)
        const h = params[0] ?? "0";
        const v = params[1] ?? "0";
        vf(videoSegments, `scroll=h=${h}:v=${v}`);
        break;
      }

      case "pan": {
        const px = effect.subparams[0] ?? "0";
        const py = effect.subparams[1] ?? "0";
        vf(
          videoSegments,
          "format=yuv444p",
          `geq='p(clip(X+${px},0,W-1),clip(Y+${py},0,H-1)):cb(clip(X+${px},0,W-1),clip(Y+${py},0,H-1)):cr(clip(X+${px},0,W-1),clip(Y+${py},0,H-1))'`,
          "scale=iw:ih",
          "format=yuv420p",
        );
        break;
      }

      case "zoom": {
        const s = effect.param ?? "2";
        vf(
          videoSegments,
          `scale=iw*${s}:ih*${s}`,
          `crop=iw/${s}:ih/${s}:(iw-iw/${s})/2:(ih-ih/${s})/2`,
        );
        break;
      }

      case "mirror": {
        const A  = parseFloat(effect.subparams[0] ?? "90");
        const cx = parseFloat(effect.subparams[1] ?? "0.5");
        const cy = parseFloat(effect.subparams[2] ?? "0.5");
        // In the 2x canvas (W=2·OW, H=2·OH) the fold line's Y position is:
        //   fold_y = H/2 + (cx-0.5)·(W/2)·sin(A°) + (cy-0.5)·(H/2)·cos(A°)
        const aRad   = `${A}/180*PI`;
        const cxOff  = cx - 0.5;
        const cyOff  = cy - 0.5;
        const foldY  = `H/2${cxOff >= 0 ? "+" : ""}${cxOff}*(W/2)*sin(${aRad})${cyOff >= 0 ? "+" : ""}${cyOff}*(H/2)*cos(${aRad})`;
        vf(
          videoSegments,
          `rotate=${A}/180*PI:iw*2:ih*2`,
          `geq='if(gte(Y,${foldY}),p(X,2*(${foldY})-Y),p(X,Y))'`,
          `format=yuv420p`,
          `rotate=${A}/-180*PI`,
          `crop=iw/2:ih/2`,
          `format=yuv420p`,
        );
        break;
      }

      case "tile": {
        const tx = effect.subparams[0] ?? "2";
        const ty = effect.subparams[1] ?? "2";
        vf(
          videoSegments,
          `format=yuv444p`,
          `geq='p(mod(X*${tx},W),mod(Y*${ty},H)):cb(mod(X*${tx},W),mod(Y*${ty},H)):cr(mod(X*${tx},W),mod(Y*${ty},H))'`,
          `scale=iw:ih`,
          `format=yuv420p`,
        );
        break;
      }

      case "gradientmap": {
        const raw = effect.param ?? "[[0,0,0,255],[255,255,255,255]]";
        let stops: number[][];
        try {
          stops = JSON.parse(raw) as number[][];
          if (!Array.isArray(stops) || stops.length < 2) throw new Error("need ≥2 stops");
        } catch {
          stops = [[0, 0, 0, 255], [255, 255, 255, 255]];
        }
        const n = stops.length;
        // Build per-channel curves: x = position along gradient (0–1), y = normalised colour value (0–1)
        const rCurve = stops.map((s, i) => `${i / (n - 1)}/${(s[0] ?? 0) / 255}`).join(" ");
        const gCurve = stops.map((s, i) => `${i / (n - 1)}/${(s[1] ?? 0) / 255}`).join(" ");
        const bCurve = stops.map((s, i) => `${i / (n - 1)}/${(s[2] ?? 0) / 255}`).join(" ");
        // Gradient map: desaturate → replicate to RGB → remap each channel via curves
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, _idx: number) =>
            `${inp}format=gray,format=rgb24,` +
            `curves=r='${rCurve}':g='${gCurve}':b='${bCurve}',` +
            `format=yuv420p${out}`,
        });
        break;
      }

      case "depolar": {
        // depolar: wraps the image into a disk
        // Output (X,Y): angle = 2π*X/W, radius = Y/2 → samples source at (W/2+radius*cos(a), H/2+radius*sin(a))
        vf(
          videoSegments,
          "scroll=hpos=-0.25",
          "format=yuv444p",
          `geq='p(W/2+Y/2*cos(2*PI*X/W),H/2+Y/2*sin(2*PI*X/W)):cb(W/2+Y/2*cos(2*PI*X/W),H/2+Y/2*sin(2*PI*X/W)):cr(W/2+Y/2*cos(2*PI*X/W),H/2+Y/2*sin(2*PI*X/W))'`,
          "scale=iw:ih",
          "format=yuv420p",
          "hflip",
        );
        break;
      }

      case "polar": {
        // polar: unrolls a disk back into a rectangle
        // Output (X,Y): maps to angle = atan2(Y-H/2,X-W/2), radius = sqrt(dx²+dy²)
        vf(
          videoSegments,
          "scroll=hpos=0.25",
          "format=yuv444p",
          `geq='p(W*(atan2(Y-H/2,X-W/2)/(2*PI)+0.5),2*sqrt((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2))):cb(W*(atan2(Y-H/2,X-W/2)/(2*PI)+0.5),2*sqrt((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2))):cr(W*(atan2(Y-H/2,X-W/2)/(2*PI)+0.5),2*sqrt((X-W/2)*(X-W/2)+(Y-H/2)*(Y-H/2)))'`,
          "scale=iw:ih",
          "format=yuv420p",
          "hflip",
        );
        break;
      }

      case "ffmpeg": {
        const argsStr = effect.param ?? "";
        if (argsStr.startsWith("-")) {
          const parsed = parseFfmpegRawArgs(argsStr);
          if (parsed.vfFilters.length > 0) vf(videoSegments, ...parsed.vfFilters);
          if (parsed.filterComplex && parsed.audioMap) {
            rawFfmpegAudio = { filterComplex: parsed.filterComplex, audioMap: parsed.audioMap };
          }
        } else {
          const rawFilters = effect.subparams.filter((s) => s.length > 0);
          if (rawFilters.length > 0) vf(videoSegments, ...rawFilters);
        }
        break;
      }

      case "vebfisheye": {
        const count = Math.max(1, parseInt(effect.param ?? "1", 10) || 1);
        for (let i = 0; i < count; i++) {
          vf(videoSegments, `v360=e:ball`, `scale=iw:ih/2`, `setsar=1:1`);
        }
        break;
      }

      case "vebdefisheye": {
        const count = Math.max(1, parseInt(effect.param ?? "1", 10) || 1);
        for (let i = 0; i < count; i++) {
          vf(videoSegments, `v360=ball:e`, `scale=iw:ih*2`, `setsar=1:1`);
        }
        break;
      }

      case "lut": {
        if (effect.param) {
          const lutRef: { path: string } = { path: "" };
          pendingLuts.push({ url: effect.param, ref: lutRef });
          videoSegments.push({
            kind: "fc",
            build: (inp: string, out: string, _idx: number) =>
              `${inp}format=rgb24,lut3d=file='${lutRef.path}',format=yuv420p${out}`,
          });
        }
        break;
      }

      case "watermark": {
        if (!effect.param) break;
        const wmUrl = effect.param;
        const wmRef: { path: string; inputIndex: number } = { path: "", inputIndex: -1 };
        pendingWatermarks.push({ url: wmUrl, ref: wmRef });
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            `[${wmRef.inputIndex}:v]format=rgba,loop=loop=-1:size=1[_wmraw${idx}];` +
            `[_wmraw${idx}]${inp}scale2ref=w=ref_w:h=ref_h:flags=lanczos[_wm${idx}][_vid${idx}];` +
            `[_vid${idx}][_wm${idx}]overlay=0:0:eof_action=repeat${out}`,
        });
        break;
      }

      case "ring": {
        const ringUrl = effect.param ?? "https://files.catbox.moe/r8l5ay.png";
        const wmRef: { path: string; inputIndex: number } = { path: "", inputIndex: -1 };
        pendingWatermarks.push({ url: ringUrl, ref: wmRef });
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            `[${wmRef.inputIndex}:v]format=rgba,loop=loop=-1:size=1[_wmraw${idx}];` +
            `[_wmraw${idx}]${inp}scale2ref=w=ref_w:h=ref_h:flags=lanczos[_wm${idx}][_vid${idx}];` +
            `[_vid${idx}][_wm${idx}]overlay=0:0:eof_action=repeat${out}`,
        });
        break;
      }

      case "miui": {
        const wmRef: { path: string; inputIndex: number } = { path: "", inputIndex: -1 };
        pendingWatermarks.push({ url: "https://files.catbox.moe/z0gkil.png", ref: wmRef });
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            `[${wmRef.inputIndex}:v]format=rgba,loop=loop=-1:size=1[_wmraw${idx}];` +
            `[_wmraw${idx}]${inp}scale2ref=w=ref_w:h=ref_h:flags=lanczos[_wm${idx}][_vid${idx}];` +
            `[_vid${idx}][_wm${idx}]overlay=0:0:eof_action=repeat${out}`,
        });
        break;
      }

      case "reddit": {
        const wmRef: { path: string; inputIndex: number } = { path: "", inputIndex: -1 };
        pendingWatermarks.push({ url: "https://files.catbox.moe/3ce714.png", ref: wmRef });
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            `[${wmRef.inputIndex}:v]format=rgba,loop=loop=-1:size=1[_wmraw${idx}];` +
            `[_wmraw${idx}]${inp}scale2ref=w=ref_w:h=ref_h:flags=lanczos[_wm${idx}][_vid${idx}];` +
            `[_vid${idx}][_wm${idx}]overlay=0:0:eof_action=repeat${out}`,
        });
        break;
      }

      case "caption": {
        const rawText = (effect.param ?? "")
          .replace(/\\/g, "\\\\")
          .replace(/'/g, "\\'")
          .replace(/:/g, "\\:");
        vf(
          videoSegments,
          `drawtext=text='${rawText}':fontsize=h/15:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=20`,
        );
        break;
      }

      case "orb": {
        vf(
          videoSegments,
          "scroll=0.05",
          "v360=e:hammer",
          "v360=fisheye:22:7",
          "scale=iw/2:ih/2",
          "format=yuv444p",
          `geq='p((W/2)+(X-(W/2))/1,(H/2)+(Y-(H/2))/1)'`,
          "scale=iw:ih",
          "format=yuv420p",
        );
        break;
      }

      case "deorb": {
        vf(
          videoSegments,
          "scroll=-0.05",
          "v360=hammer:e",
          "v360=22:fisheye:7",
          "scale=iw*2:ih*2",
          "format=yuv444p",
          `geq='p((W/2)+(X-(W/2))/1,(H/2)+(Y-(H/2))/1)'`,
          "scale=iw:ih",
          "format=yuv420p",
        );
        break;
      }

        case "gm91deform": {
          // Perspective/barrel deformation effect.
          // Scales to 360×360, applies geq-based geometric warp, then crops to 640×360.
          // $w/$h from the original filter replaced with iw:ih (no-op, crop already outputs 640×360).
          vf(
            videoSegments,
            "format=yuv444p",
            "scale=360:360",
            "setsar=1:1",
            "rotate=0:iw*1.05:ih*1.05",
            `geq='p((W/2)+((X-W/2)/lerp(1,asin(sin(-Y/H)),0.164*1))/lerp(1,1.22,1)+((Y-H/2)*(-0.136*1))+((0.047*1*W)*pow((Y-H/2)/(H/2),2))+(-W/40),(H/2)+((Y-H/2)/lerp(1,1.27,1))/lerp(1,sin((X/W)*PI),0.12*1)-(((0.014*1)*H)*pow((X-W/2)/(W/2),2))+((X-W/2)*(0.12*1))-(1.2*1))'`,
            "scale='640*lerp(1.05,1.075,1)':360*1.05",
            "crop=640:360:'(in_w-in_h)/2+(8*1)'",
            "setsar=1",
            "scale=iw:ih",
            "format=yuv420p",
          );
          break;
        }

              case "vebfisheye2": {
        const count = Math.max(1, parseInt(effect.param ?? "1", 10) || 1);
        for (let i = 0; i < count; i++) {
          vf(videoSegments, `v360=e:hammer`, `scale=iw:ih`, `setsar=1:1`);
        }
        break;
      }

      case "vebdefisheye2": {
        const count = Math.max(1, parseInt(effect.param ?? "1", 10) || 1);
        for (let i = 0; i < count; i++) {
          vf(videoSegments, `v360=hammer:e`, `scale=iw:ih`, `setsar=1:1`);
        }
        break;
      }

      case "vebfisheye3": {
        const count = Math.max(1, parseInt(effect.param ?? "1", 10) || 1);
        for (let i = 0; i < count; i++) {
          vf(videoSegments, `v360=fisheye:22:7`, `scale=iw:ih`, `setsar=1:1`);
        }
        break;
      }

      case "vebdefisheye3": {
        const count = Math.max(1, parseInt(effect.param ?? "1", 10) || 1);
        for (let i = 0; i < count; i++) {
          vf(videoSegments, `v360=22:fisheye:7`, `scale=iw*2:ih*2`, `setsar=1:1`);
        }
        break;
      }

      case "grayscale": {
        vf(videoSegments, `hue=s=0`);
        break;
      }

      case "chromashift": {
        vf(videoSegments, `format=rgb24,geq=r='p(mod((255-g(X,Y)*0.593*3)+X,W),mod((255-b(X,Y)*0.926*3)+Y,H))':g='p(mod((255-g(X,Y)*0.593*3)+X,W),mod((255-b(X,Y)*0.926*3)+Y,H))':b='p(mod((255-g(X,Y)*0.593*3)+X,W),mod((255-b(X,Y)*0.926*3)+Y,H))',format=yuv420p,hue=s=0`);
        break;
      }


      case "🥸🥸": {
        vf(videoSegments, `hue=h=3.14159265`);
        break;
      }

      case "﷽": {
        vf(videoSegments, `v360=e:ball`, `v360=fisheye:22:7`);
        break;
      }

      case "𒐫": {
        vf(videoSegments, `v360=ball:hammer`);
        break;
      }

      case "sepia": {
        vf(videoSegments, `colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131`);
        break;
      }

      case "gm4": {
        vf(videoSegments, `selectivecolor=blacks='0 0 0 0':whites='1 1 1 1',format=yuv420p`);
        break;
      }

      case "realgm4": {
        vf(videoSegments, `curves=all=0/0 0.5/1 1/0`);
        break;
      }

      case "ffmpeghue": {
        const hue = effect.param ?? "180";
        vf(videoSegments, `hue=h=${hue}`);
        break;
      }

      case "wiggle": {
        const s = effect.param ?? "5";
        vf(
          videoSegments,
          "format=yuv444p",
          `geq=lum='lum(X+sin(Y/8+T*6)*${s},Y+cos(X/8+T*6)*${s}*0.5)':cb='cb(X+sin(Y/8+T*6)*${s},Y+cos(X/8+T*6)*${s}*0.5)':cr='cr(X+sin(Y/8+T*6)*${s},Y+cos(X/8+T*6)*${s}*0.5)'`,
          "format=yuv420p",
        );
        break;
      }

      case "cartoon": {
        // frei0r "cartoon" plugin: params are triLevel;threshold (each 0.0-1.0)
        const triLevel = effect.subparams[0] ?? "0.11";
        const threshold = effect.subparams[1] ?? "0.20";
        vf(videoSegments, `frei0r=filter_name=cartoon:filter_params=${triLevel}|${threshold}`);
        break;
      }

      case "distort0r": {
        // frei0r "distort0r" plugin: params are amount;tilt (each 0.0-1.0)
        const amount = effect.subparams[0] ?? "0.2";
        const tilt = effect.subparams[1] ?? "0.5";
        vf(videoSegments, `frei0r=filter_name=distort0r:filter_params=${amount}|${tilt}`);
        break;
      }

      case "nervous": {
        // frei0r "nervous" plugin: randomly swaps in a previous frame (glitch effect)
        vf(videoSegments, `frei0r=filter_name=nervous`);
        break;
      }

      case "orb2": {
        vf(
          videoSegments,
          "scroll=0:0.05",
          "v360=e:hammer",
          "v360=fisheye:22:7",
          "scale=iw/2:ih/2",
          "format=yuv444p",
          `geq='p((W/2)+(X-(W/2))/1,(H/2)+(Y-(H/2))/1)'`,
          "scale=iw:ih",
          "format=yuv420p",
        );
        break;
      }

      case "deorb2": {
        vf(
          videoSegments,
          "scroll=0:-0.05",
          "v360=hammer:e",
          "v360=22:fisheye:7",
          "scale=iw*2:ih*2",
          "format=yuv444p",
          `geq='p((W/2)+(X-(W/2))/1,(H/2)+(Y-(H/2))/1)'`,
          "scale=iw:ih",
          "format=yuv420p",
        );
        break;
      }

      case "orb3": {
        vf(
          videoSegments,
          "scroll=0.05:0.05",
          "v360=e:hammer",
          "v360=fisheye:22:7",
          "scale=iw/2:ih/2",
          "format=yuv444p",
          `geq='p((W/2)+(X-(W/2))/1,(H/2)+(Y-(H/2))/1)'`,
          "scale=iw:ih",
          "format=yuv420p",
        );
        break;
      }

      case "deorb3": {
        vf(
          videoSegments,
          "scroll=-0.05:-0.05",
          "v360=hammer:e",
          "v360=22:fisheye:7",
          "scale=iw*2:ih*2",
          "format=yuv444p",
          `geq='p((W/2)+(X-(W/2))/1,(H/2)+(Y-(H/2))/1)'`,
          "scale=iw:ih",
          "format=yuv420p",
        );
        break;
      }

      case "spin": {
        const speed = effect.param ?? "1";
        // Dynamic angle contains t — use diagonal as safe static output size
        vf(
          videoSegments,
          `rotate=t*${speed}*PI:ow=hypot(iw\\,ih):oh=hypot(iw\\,ih)`,
        );
        break;
      }

      case "sphere": {
        vf(
          videoSegments,
          "scroll=0.05:0.05",
          "rotate=t/3:ow=hypot(iw\\,ih):oh=hypot(iw\\,ih)",
          "v360=e:hammer",
          "v360=fisheye:22:7",
          "scale=iw/2:ih/2",
          "format=yuv444p",
          `geq='p((W/2)+(X-(W/2))/2,(H/2)+(Y-(H/2))/1)'`,
          "scale=iw:ih",
          "format=yuv420p",
        );
        break;
      }

      case "desphere": {
        vf(
          videoSegments,
          "scroll=-0.05:-0.05",
          "rotate=t*3:ow=hypot(iw\\,ih):oh=hypot(iw\\,ih)",
          "v360=hammer:e",
          "v360=22:fisheye:7",
          "scale=iw*2:ih*2",
          "format=yuv444p",
          `geq='p((W/2)+(X-(W/2))/0.5,(H/2)+(Y-(H/2))/1)'`,
          "scale=iw:ih",
          "format=yuv420p",
        );
        break;
      }

      case "vignette": {
        const s = effect.param ?? "1";
        vf(
          videoSegments,
          `vignette=${s}`,
        );
        break;
      }

      case "timecode":
        // Push a placeholder that processor.ts will replace with the real
        // drawtext string (which requires a runtime frame-rate probe).
        vf(videoSegments, "__TC__");
        break;

      case "radar":
        hasRadar = true;
        break;

      case "tvsim": {
        const linesync  = Math.min(Math.max(parseFloat(effect.subparams[0] ?? "0.5"), 0), 1);
        const zoomgrill = Math.max(1, parseFloat(effect.subparams[1] ?? "1") || 1);
        const tvRef: { inputIndex: number } = { inputIndex: -1 };
        pendingTvsim = { linesync, zoomgrill, ref: tvRef };
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            [
              `${inp}scale=854:854,format=bgr32[_tv00_${idx}]`,
              `[${tvRef.inputIndex}:v]crop=iw:ih/${zoomgrill.toFixed(6)}:0:0,scale=854:854,eq=contrast=${((1 - linesync) * 2.366666).toFixed(6)}:eval=frame,format=bgr32,hue=b=-0.033[_tvx_${idx}]`,
              `color=s=854x854:c=#808080,format=bgr32[_tvy_${idx}]`,
              `[_tv00_${idx}][_tvx_${idx}][_tvy_${idx}]displace=edge=wrap,TVSIM_SCALE_PLACEHOLDER,setsar=1,format=yuv444p${out}`,
            ].join(";"),
        });
        break;
      }

      case "shakeh": {
        const s = effect.param ?? "5";
        vf(videoSegments,
          "rotate=0:ow=iw*1.1:oh=ih*1.1",
          "format=yuv444p",
          `geq='p(X+${s}*(2*mod(1000*sin(N*12.9898),1)-1),Y):cb(X+${s}*(2*mod(1000*sin(N*12.9898),1)-1),Y):cr(X+${s}*(2*mod(1000*sin(N*12.9898),1)-1),Y)'`,
          "crop=iw/1.1:ih/1.1:(iw-iw/1.1)/2:(ih-ih/1.1)/2",
          "format=yuv420p",
        );
        break;
      }

      case "shakev": {
        const s = effect.param ?? "5";
        vf(videoSegments,
          "rotate=0:ow=iw*1.1:oh=ih*1.1",
          "format=yuv444p",
          `geq='p(X,Y+${s}*(2*mod(1000*sin(N+1000)*78.233,1)-1)):cb(X,Y+${s}*(2*mod(1000*sin(N+1000)*78.233,1)-1)):cr(X,Y+${s}*(2*mod(1000*sin(N+1000)*78.233,1)-1))'`,
          "crop=iw/1.1:ih/1.1:(iw-iw/1.1)/2:(ih-ih/1.1)/2",
          "format=yuv420p",
        );
        break;
      }

      case "shake": {
        const s = effect.param ?? "5";
        vf(videoSegments,
          "rotate=0:ow=iw*1.1:oh=ih*1.1",
          "format=yuv444p",
          `geq='p(X+${s}*(2*mod(1000*sin(N*12.9898),1)-1),Y+${s}*(2*mod(1000*sin(N+1000)*78.233,1)-1)):cb(X+${s}*(2*mod(1000*sin(N*12.9898),1)-1),Y+${s}*(2*mod(1000*sin(N+1000)*78.233,1)-1)):cr(X+${s}*(2*mod(1000*sin(N*12.9898),1)-1),Y+${s}*(2*mod(1000*sin(N+1000)*78.233,1)-1))'`,
          "crop=iw/1.1:ih/1.1:(iw-iw/1.1)/2:(ih-ih/1.1)/2",
          "format=yuv420p",
        );
        break;
      }

      case "rays": {
        const steps = Math.min(20, Math.max(2, parseInt(effect.param ?? "4", 10) || 4));
        const buildGeqCh = (ch: string): string => {
          let expr = `p(X,Y)`;
          for (let i = 1; i < steps; i++) {
            const d = (1 + i * 0.05).toFixed(2);
            const s = `p((W*0.5)+(X-(W*0.5))/${d},(H*0.5)+(Y-(H*0.5))/${d})`;
            expr = `max(${expr},${s})`;
          }
          return `${ch}='${expr}'`;
        };
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            `${inp}format=gbrp,split=2[_rf0_${idx}][_rf00_${idx}];` +
            `[_rf00_${idx}]geq=${buildGeqCh("r")}:${buildGeqCh("g")}:${buildGeqCh("b")}:i=n[_rf1_${idx}];` +
            `[_rf0_${idx}][_rf1_${idx}]blend=all_mode=lighten,format=yuv420p${out}`,
        });
        break;
      }

      case "lsc": {
        const text = effect.param ?? "";
        const rawUrl = effect.subparams[1] ?? null;
        const videoUrl = (!rawUrl || rawUrl === "{iv}") ? null : rawUrl;
        pendingLsc = { text, videoUrl };
        break;
      }

      case "sierpinskiransomware":
        hasSierpinski = true;
        break;

      case "nbfxearthquake":
        hasNbfxEarthquake = true;
        break;

      case "wmm3dripple":
        hasWmm3dripple = true;
        vf(
          videoSegments,
          "scale=640:640",
          "format=yuv444p",
          "geq='p(mod(W*0.5+(hypot(X-W*0.5,Y-H*0.5)+sin(N/WMM3DRIPPLE_FC*PI)*25*sin(2*PI*N/WMM3DRIPPLE_FC*2-(0)+(-(hypot(X-W*0.5,Y-H*0.5))/90)))*cos(atan2(Y-H*0.5,X-W*0.5)),W),mod(H*0.5+(hypot(X-W*0.5,Y-H*0.5)-sin(N/WMM3DRIPPLE_FC*PI)*25*sin(2*PI*N/WMM3DRIPPLE_FC*2-(0)+(-(hypot(X-W*0.5,Y-H*0.5))/90)))*sin(atan2(Y-H*0.5,X-W*0.5)),H))'",
          "scale=WMM3DRIPPLE_W:WMM3DRIPPLE_H",
          "setsar=1",
          "format=yuv420p",
        );
        break;

      // ── mirror/reflection effects ──────────────────────────────────────
      case "haah": {
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            `${inp}crop=iw/2:ih:0:0,split[_haah_a_${idx}][_haah_b_${idx}];` +
            `[_haah_b_${idx}]hflip[_haah_c_${idx}];` +
            `[_haah_a_${idx}][_haah_c_${idx}]hstack${out}`,
        });
        break;
      }

      case "waaw": {
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            `${inp}crop=iw/2:ih:iw/2:0,split[_waaw_a_${idx}][_waaw_b_${idx}];` +
            `[_waaw_a_${idx}]hflip[_waaw_c_${idx}];` +
            `[_waaw_c_${idx}][_waaw_b_${idx}]hstack${out}`,
        });
        break;
      }

      case "hooh": {
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            `${inp}crop=iw:ih/2:0:0,split[_hooh_a_${idx}][_hooh_b_${idx}];` +
            `[_hooh_b_${idx}]vflip[_hooh_c_${idx}];` +
            `[_hooh_a_${idx}][_hooh_c_${idx}]vstack${out}`,
        });
        break;
      }

      case "woow": {
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            `${inp}crop=iw:ih/2:0:ih/2,split[_woow_a_${idx}][_woow_b_${idx}];` +
            `[_woow_a_${idx}]vflip[_woow_c_${idx}];` +
            `[_woow_c_${idx}][_woow_b_${idx}]vstack${out}`,
        });
        break;
      }

      // ── notsobot-style effects ─────────────────────────────────────────
      case "flop":
        vf(videoSegments, "hflip");
        break;

      case "flip":
        vf(videoSegments, "vflip");
        break;

      case "copy": {
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            `${inp}split[_cp_a_${idx}][_cp_b_${idx}];[_cp_a_${idx}][_cp_b_${idx}]hstack${out}`,
        });
        break;
      }

      case "vcopy": {
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            `${inp}split[_vc_a_${idx}][_vc_b_${idx}];[_vc_a_${idx}][_vc_b_${idx}]vstack${out}`,
        });
        break;
      }

      case "quad": {
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            `${inp}split=4[_qa_${idx}][_qb_${idx}][_qc_${idx}][_qd_${idx}];` +
            `[_qa_${idx}][_qb_${idx}]hstack[_qt_${idx}];` +
            `[_qc_${idx}][_qd_${idx}]hstack[_qb2_${idx}];` +
            `[_qt_${idx}][_qb2_${idx}]vstack${out}`,
        });
        break;
      }

      case "edge": {
        const lo = effect.subparams[0] ?? "50";
        const hi = effect.subparams[1] ?? "150";
        vf(videoSegments, `edgedetect=low=${lo}/255:high=${hi}/255`);
        break;
      }

      case "emboss": {
        const s = effect.param ?? "1";
        vf(
          videoSegments,
          "format=rgb24",
          `convolution='-2 -1 0 -1 ${1 + parseFloat(s)} 1 0 1 2:-2 -1 0 -1 ${1 + parseFloat(s)} 1 0 1 2:-2 -1 0 -1 ${1 + parseFloat(s)} 1 0 1 2:0 0 0 0 1 0 0 0 0'`,
          "format=yuv420p",
        );
        break;
      }

      case "sharpen": {
        const s = parseFloat(effect.param ?? "1.5");
        const clamped = Math.min(10, Math.max(0.1, s));
        vf(videoSegments, `unsharp=5:5:${clamped}:5:5:0`);
        break;
      }

      case "pixelate": {
        const s = Math.max(2, parseInt(effect.param ?? "16", 10) || 16);
        vf(
          videoSegments,
          `scale=trunc(iw/${s})*2:trunc(ih/${s})*2`,
          `scale=iw*${s}:ih*${s}:flags=neighbor`,
          `scale=trunc(iw/${s})*2:trunc(ih/${s})*2`,
        );
        break;
      }

      case "solarize": {
        const t = Math.max(0, Math.min(255, parseInt(effect.param ?? "128", 10) || 128));
        vf(
          videoSegments,
          `format=rgb24`,
          `lutrgb=r='if(gt(val,${t}),255-val,val)':g='if(gt(val,${t}),255-val,val)':b='if(gt(val,${t}),255-val,val)'`,
          `format=yuv420p`,
        );
        break;
      }

      case "threshold": {
        const t = Math.max(0, Math.min(255, parseInt(effect.param ?? "128", 10) || 128));
        vf(
          videoSegments,
          `format=rgb24`,
          `lutrgb=r='if(gt(val,${t}),255,0)':g='if(gt(val,${t}),255,0)':b='if(gt(val,${t}),255,0)'`,
          `format=yuv420p`,
        );
        break;
      }

      case "deepfry": {
        const intensity = parseFloat(effect.param ?? "1");
        const sat = (3 * intensity).toFixed(2);
        const sharp = (4 * intensity).toFixed(2);
        vf(
          videoSegments,
          `eq=saturation=${sat}:contrast=1.3:brightness=0.02`,
          `unsharp=5:5:${sharp}:5:5:0`,
          `eq=saturation=${sat}`,
        );
        break;
      }

      case "speed": {
        const s = Math.max(0.25, Math.min(16, parseFloat(effect.param ?? "2") || 2));
        vf(videoSegments, `setpts=PTS/${s}`);
        let remaining = s;
        while (remaining > 2.0 + 1e-6) {
          audioFilters.push("atempo=2.0");
          remaining /= 2.0;
        }
        while (remaining < 0.5 - 1e-6) {
          audioFilters.push("atempo=0.5");
          remaining *= 2.0;
        }
        audioFilters.push(`atempo=${remaining.toFixed(6)}`);
        break;
      }

      case "noise": {
        const s = Math.max(1, Math.min(200, parseFloat(effect.param ?? "25") || 25)).toFixed(2);
        vf(
          videoSegments,
          "format=yuv444p",
          `geq='lum=clip(lum(X,Y)+(2*random(X+Y*W+N*W*H)-1)*${s},0,255):cb=cb(X,Y):cr=cr(X,Y)'`,
          "format=yuv420p",
        );
        break;
      }

      case "posterize": {
        const levels = Math.max(2, Math.min(64, parseInt(effect.param ?? "4", 10) || 4));
        const step = Math.floor(256 / levels);
        vf(
          videoSegments,
          "format=rgb24",
          `lut=r='${step}*floor(val/${step})':g='${step}*floor(val/${step})':b='${step}*floor(val/${step})'`,
          "format=yuv420p",
        );
        break;
      }

      case "transpose": {
        const dir = effect.param ?? "1";
        vf(videoSegments, `transpose=${dir}`);
        break;
      }

      case "glitch": {
        const s = Math.max(1, parseInt(effect.param ?? "10", 10) || 10);
        vf(
          videoSegments,
          "format=rgb24",
          `geq=r='r(X,Y)':g='g(clip(X-${s},0,W-1),Y)':b='b(clip(X+${s},0,W-1),Y)'`,
          "format=yuv420p",
        );
        break;
      }

      case "rainbow": {
        const speed = effect.param ?? "30";
        vf(videoSegments, `hue=h=${speed}*t`);
        break;
      }

      case "bloom": {
        const s = Math.max(1, parseInt(effect.param ?? "10", 10) || 10);
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            `${inp}split[_bl_a_${idx}][_bl_b_${idx}];` +
            `[_bl_b_${idx}]boxblur=${s}:${Math.max(1, Math.round(s / 2))},eq=brightness=0.15[_bl_glow_${idx}];` +
            `[_bl_a_${idx}][_bl_glow_${idx}]blend=all_mode=screen${out}`,
        });
        break;
      }

      case "scanlines": {
        const gap = Math.max(2, parseInt(effect.param ?? "4", 10) || 4);
        vf(
          videoSegments,
          "format=rgb24",
          `lutrgb=r='if(eq(mod(Y,${gap}),0),0,val)':g='if(eq(mod(Y,${gap}),0),0,val)':b='if(eq(mod(Y,${gap}),0),0,val)'`,
          "format=yuv420p",
        );
        break;
      }

      case "vhs": {
        vf(
          videoSegments,
          "format=rgb24",
          "geq=r='r(X,Y)':g='g(clip(X-3,0,W-1),Y)':b='b(clip(X+3,0,W-1),Y)'",
          "noise=alls=12:allf=t+u",
          "format=yuv420p",
          "hue=s=1.3",
        );
        break;
      }

      case "sobel": {
        vf(videoSegments, "sobel");
        break;
      }

      case "prewitt": {
        vf(videoSegments, "prewitt");
        break;
      }

      case "dither": {
        vf(videoSegments, "format=rgb8,format=yuv420p");
        break;
      }

      case "stretch": {
        const sx = effect.subparams[0] ?? "iw*2";
        const sy = effect.subparams[1] ?? "ih";
        vf(videoSegments, `scale=${sx}:${sy}`);
        break;
      }

      // ── new notsobot-style effects ─────────────────────────────────────

      case "explode": {
        const s = effect.param ?? "1";
        const G = `gauss(-3.3333*pow(hypot((X-W*0.5)/(W*0.5),(Y-H*0.5)/(H*0.5)),2))`;
        const sx = `W*0.5+(X-W*0.5)*(1-(${s})*${G})`;
        const sy = `H*0.5+(Y-H*0.5)*(1-(${s})*${G})`;
        vf(videoSegments,
          "format=yuv444p",
          `geq='p(${sx},${sy}):cb(${sx},${sy}):cr(${sx},${sy})'`,
          "scale=iw:ih",
          "format=yuv420p",
        );
        break;
      }

      case "implode": {
        const s = effect.param ?? "1";
        const G = `gauss(-3.3333*pow(hypot((X-W*0.5)/(W*0.5),(Y-H*0.5)/(H*0.5)),2))`;
        const sx = `W*0.5+(X-W*0.5)*(1+(${s})*${G})`;
        const sy = `H*0.5+(Y-H*0.5)*(1+(${s})*${G})`;
        vf(videoSegments,
          "format=yuv444p",
          `geq='p(${sx},${sy}):cb(${sx},${sy}):cr(${sx},${sy})'`,
          "scale=iw:ih",
          "format=yuv420p",
        );
        break;
      }

      case "distort": {
        const k = parseFloat(effect.param ?? "-0.5");
        const r2 = `(pow((X-W*0.5)/(W*0.5),2)+pow((Y-H*0.5)/(H*0.5),2))`;
        const f  = `(1+(${k.toFixed(6)})*${r2})`;
        const sx = `W*0.5+(X-W*0.5)*${f}`;
        const sy = `H*0.5+(Y-H*0.5)*${f}`;
        vf(videoSegments,
          "format=yuv444p",
          `geq='p(${sx},${sy}):cb(${sx},${sy}):cr(${sx},${sy})'`,
          "scale=iw:ih",
          "format=yuv420p",
        );
        break;
      }

      case "kek": {
        const sat = parseFloat(effect.subparams[0] ?? "3.5");
        vf(videoSegments,
          "format=rgb24",
          `eq=saturation=${sat.toFixed(4)}:contrast=1.4:brightness=0.05`,
          `lut=r='clip(val*0.65,0,255)':g='clip(val*1.25,0,255)':b='clip(val*0.45,0,255)'`,
          "format=yuv420p",
        );
        break;
      }

      case "exo": {
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) => [
            `${inp}format=rgb24,split=2[_exo_a_${idx}][_exo_b_${idx}]`,
            `[_exo_b_${idx}]sobel,eq=contrast=4:brightness=0[_exo_edge_${idx}]`,
            `[_exo_a_${idx}][_exo_edge_${idx}]blend=all_mode=screen,format=yuv420p${out}`,
          ].join(";"),
        });
        break;
      }

      case "hueshifthsv": {
        const hue = effect.param ?? "180";
        const haldRef: PendingHald["ref"] = { path: "" };
        pendingHalds.push({ hue, type: "modulate", ref: haldRef });
        videoSegments.push({
          kind: "fc",
          build: (inp: string, out: string, idx: number) =>
            `movie=${haldRef.path}[_hclut${idx}];${inp}[_hclut${idx}]haldclut${out}`,
        });
        break;
      }

      // ── new imagescript effects ────────────────────────────────────────

      case "swaprgba": {
        // swaprgba=bgr → output R=B, G=G, B=R
        const order = (effect.param ?? "rgb").toLowerCase().replace(/[^rgba]/g, "");
        const ch = ["r", "g", "b"];
        const src = [order[0] ?? "r", order[1] ?? "g", order[2] ?? "b"];
        const parts: string[] = [];
        for (let d = 0; d < 3; d++) {
          const dName = ch[d]!;
          const sName = src[d]!;
          for (const c of ch) parts.push(`${dName}${c}=${c === sName ? 1 : 0}`);
        }
        vf(videoSegments, `format=rgb24`, `colorchannelmixer=${parts.join(":")}`, `format=yuv420p`);
        break;
      }

      case "tunnel": {
        vf(videoSegments, `v360=e:cylinder_lr`, `scale=iw:ih`, `setsar=1:1`);
        break;
      }

      case "detunnel": {
        vf(videoSegments, `v360=cylinder_lr:e`, `scale=iw:ih`, `setsar=1:1`);
        break;
      }

      case "slide": {
        const speed = parseFloat(effect.param ?? "0.5");
        vf(videoSegments, `scroll=h=${speed.toFixed(6)}`);
        break;
      }

      // ── audio aliases ──────────────────────────────────────────────────

      case "audiopitch":
        pitchSubparams = effect.subparams;
        break;

      case "audiovibrato": {
        const freq  = effect.subparams[0] ?? "5";
        const depth = effect.subparams[1] ?? "0.5";
        audioFilters.push(`vibrato=f=${freq}:d=${depth}`);
        break;
      }

      case "audiodestroy":
        for (let _i = 0; _i < 11; _i++) audioFilters.push("acontrast=100");
        break;

      default:
        break;
    }
  }

  return { videoSegments, pitchSubparams, audioFilters, pendingHalds, pendingWatermarks, pendingLuts, builtinLuts, rawFfmpegAudio, hasRadar, pendingTvsim, pendingAutotune, hasSierpinski, hasNbfxEarthquake, hasWmm3dripple, pendingLsc };
}

// ── audio filter complex builder ──────────────────────────────────────────────

export function buildAudioFilterComplex(
  pitchSubparams: string[],
  audioFilters: string[],
  _tempoRatio?: number,
  audioDuration?: number | null,
  inputLabel = "",
): { filterComplex: string; audioMap: string } | null {
  const hasPitch = pitchSubparams.length > 0;
  const hasAF = audioFilters.length > 0;
  if (!hasPitch && !hasAF) return null;

  if (!hasPitch) {
    return {
      filterComplex: `${inputLabel}${audioFilters.join(",")}[aout]`,
      audioMap: "[aout]",
    };
  }

  // Inharmonic mode: first subparam is 'i' → each semitone gets a slightly detuned
  // companion (+0.12 st) mixed at half volume for a chorus / tape-wow texture.
  const inharmonicMode = pitchSubparams[0]?.toLowerCase() === "i";
  const rawSemiparams  = inharmonicMode ? pitchSubparams.slice(1) : pitchSubparams;

  const baseSemitones = rawSemiparams
    .map((s) => {
      const n = parseFloat(s);
      if (isNaN(n)) return n;
      return Math.abs(n) >= 120 ? n / 10 : n;
    })
    .filter((n) => !isNaN(n));

  const semitones = inharmonicMode
    ? baseSemitones.flatMap((st) => [st, st + 0.12])
    : baseSemitones;

  if (semitones.length === 0) {
    if (!hasAF) return null;
    return {
      filterComplex: `${inputLabel}${audioFilters.join(",")}[aout]`,
      audioMap: "[aout]",
    };
  }

  // volume filters go per-stream (after rubberband on each split); everything else goes pre-split
  const volumeFilters = audioFilters.filter((f) => f.startsWith("volume="));
  const otherFilters  = audioFilters.filter((f) => !f.startsWith("volume="));
  const prePitch  = otherFilters.length  > 0 ? `${otherFilters.join(",")},`  : "";
  const perStream = volumeFilters.length > 0 ? `,${volumeFilters.join(",")}` : "";

  // Pad input so rubberband's internal buffer is fully flushed; trim output back to
  // the original duration so no trailing silence leaks through.
  const padBefore = "apad=pad_dur=1,";
  const trimAfter = audioDuration != null && audioDuration > 0
    ? `,atrim=end=${audioDuration.toFixed(6)}`
    : "";

  const pcm = "aformat=sample_fmts=s16:sample_rates=44100,";

  if (semitones.length === 1) {
    const pitch = Math.pow(2, semitones[0]! / 12).toFixed(6);
    return {
      filterComplex: `${inputLabel}${prePitch}${pcm}${padBefore}rubberband=pitch=${pitch}:window=long:transients=crisp:smoothing=2.14748e+09/4.9:pitchq=speed:detector=percussive${trimAfter}${perStream}[aout]`,
      audioMap: "[aout]",
    };
  }

  const n = semitones.length;
  const split = `${inputLabel}${prePitch}${pcm}asplit=${n}${semitones.map((_, i) => `[ps${i}]`).join("")}`;

  const chains = semitones.map((st, i) => {
    const pitch = Math.pow(2, st / 12).toFixed(6);
    return `[ps${i}]${padBefore}rubberband=pitch=${pitch}:window=long:transients=crisp:smoothing=2.14748e+09/4.9:pitchq=speed:detector=percussive,dynaudnorm${perStream}[rb${i}]`;
  });
  const inputs = semitones.map((_, i) => `[rb${i}]`).join("");
  const mix = `${inputs}amix=inputs=${n}:normalize=0,apad=pad_dur=0.1${trimAfter}[aout]`;

  return {
    filterComplex: [split, ...chains, mix].join(";"),
    audioMap: "[aout]",
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

// ── raw ffmpeg args parser ────────────────────────────────────────────────────

function parseFfmpegRawArgs(argsStr: string): {
  vfFilters: string[];
  filterComplex: string | null;
  audioMap: string | null;
} {
  const vfMatch = argsStr.match(/-vf\s+(.*?)(?=\s+-[a-zA-Z]|$)/);
  const vfFilters = vfMatch
    ? vfMatch[1].trim().split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const fcDoubleMatch = argsStr.match(/-filter_complex\s+"([\s\S]*?)"/);
  const fcSingleMatch = argsStr.match(/-filter_complex\s+'([\s\S]*?)'/);
  const filterComplex = fcDoubleMatch?.[1] ?? fcSingleMatch?.[1] ?? null;

  const mapRe = /-map\s+("?\[[^\]]+\]"?)/g;
  const m = mapRe.exec(argsStr);
  const audioMap = m ? m[1].replace(/^"|"$/g, "") : null;

  return { vfFilters, filterComplex, audioMap };
}

/** Append simple filters, merging into an existing trailing SimpleSegment. */
function vf(segments: VideoSegment[], ...filters: string[]): void {
  const last = segments[segments.length - 1];
  if (last?.kind === "vf") {
    last.filters.push(...filters);
  } else {
    segments.push({ kind: "vf", filters: [...filters] });
  }
}

function buildWaveFilter(subparams: string[]): string[] {
  const xw     = subparams[0] ?? "3";
  const yw     = subparams[1] ?? "3";
  const xa     = subparams[2] ?? "20";
  const ya     = subparams[3] ?? "20";
  const xphase = subparams[4] ?? "0"; // X-axis phase offset in degrees
  const yphase = subparams[5] ?? "0"; // Y-axis phase offset in degrees
  const speed  = subparams[6] ?? "0"; // animation speed (cycles/sec)

  const phX = `2*PI*Y*${xw}/2/H+2*PI*${speed}*T+${xphase}*PI/180`;
  const phY = `2*PI*X*${yw}/2/W+2*PI*${speed}*T+${yphase}*PI/180`;

  const dx = xa !== "0" ? `${xa}*10*sin(${phX})` : "0";
  const dy = ya !== "0" ? `${ya}*10*sin(${phY})` : "0";

  const cx = `clip(X+${dx},0,W-1)`;
  const cy = `clip(Y+${dy},0,H-1)`;
  return [
    "format=yuv444p",
    `geq='p(${cx},${cy}):cb(${cx},${cy}):cr(${cx},${cy})'`,
    "scale=iw:ih",
    "format=yuv420p",
  ];
}

function buildSwirlGeq(angle: string, cx = "0.5", cy = "0.5", r = "1"): string {
  const cxE = `W*${cx}`;
  const cyE = `H*${cy}`;
  const nx  = `(X-${cxE})/(W/2)`;
  const ny  = `(Y-${cyE})/(H/2)`;
  const d   = `(hypot(${nx},${ny})+1e-6)`;
  const th  = `atan2(${ny},${nx})`;
  const sw  = `((${angle})/180*PI)*(if(lt(${d},${r}),1-${d}/${r},0)^2)`;
  const sx  = `${cxE}+cos(${th}+${sw})*${d}*(W/2)`;
  const sy  = `${cyE}+sin(${th}+${sw})*${d}*(H/2)`;
  return `geq='p(${sx},${sy}):cb(${sx},${sy}):cr(${sx},${sy})'`;
}
