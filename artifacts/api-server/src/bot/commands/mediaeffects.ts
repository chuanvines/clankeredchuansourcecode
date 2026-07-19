/**
 * mediaeffects.ts
 * Shorthand & prefix commands and slash commands for common visual/audio/mediascript effects.
 *
 * Prefix commands added:
 *   &rotate, &explode, &implode, &swirl, &hue, &zoom, &blur, &fisheye, &mirror,
 *   &polar, &depolar, &flip, &vflip, &invert, &grayscale, &sepia, &spin,
 *   &orb, &deorb, &sphere, &desphere, &nervous, &wiggle, &cartoon, &kek, &vreverse,
 *   &distort <type> [val]
 *   &haah, &waaw, &hooh, &woow           (mediascript mirror effects)
 *   &reverse                             (mediascript full reverse)
 *   &audioreverse / &arev               (mediascript audio-only reverse)
 *   &bitrate <val>, &audiobitrate / &abitrate <val>, &samplerate / &sr <val>, &setfps / &fps <val>
 *   &join <url1> <url2> [-vertical]
 *   &audio <sub> [opts] / &a <sub> [opts]
 *     subs: reverse | pitch <st> | volume <f> | vibrato [freq] [depth] | acontrast [val]
 *
 * Slash commands exported: rotate, explode, implode, swirl, hue, zoom, blur, fisheye,
 *   mirror, polar, depolar, flip, vflip, invert, grayscale, distort,
 *   haah, waaw, hooh, woow, reverse, audioreverse,
 *   bitrate, audiobitrate, samplerate, setfps, join, audio
 */

import {
  Message,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  AttachmentBuilder,
} from "discord.js";
import { parseEffectsString } from "../effects/parser.js";
import { processMedia, detectMediaType } from "../effects/processor.js";
import { runMediascript } from "./tag.js";
import { uploadToCatbox } from "./catboxupload.js";
import { extname } from "node:path";
import { logger } from "../lib/logger.js";

const DISCORD_MAX_BYTES = 8 * 1024 * 1024;

// ── Internal helpers ──────────────────────────────────────────────────────────

interface Flags {
  s: number | undefined;
  d: number | undefined;
  vertical: boolean;
  positional: string[];
}

function parseFlags(tokens: string[]): Flags {
  let s: number | undefined;
  let d: number | undefined;
  let vertical = false;
  const positional: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const tl = t.toLowerCase();
    if ((tl === "-s" || tl === "--strength") && i + 1 < tokens.length) {
      s = parseFloat(tokens[++i]!);
    } else if ((tl === "-d" || tl === "--deg" || tl === "--degrees") && i + 1 < tokens.length) {
      d = parseFloat(tokens[++i]!);
    } else if (tl === "-vertical" || tl === "--vertical") {
      vertical = true;
    } else {
      positional.push(t);
    }
  }
  return { s, d, vertical, positional };
}

async function resolveMedia(
  message: Message,
  positional: string[],
): Promise<{ inputUrl: string; inputName: string; inputCT: string } | null> {
  const allAttachments = [...message.attachments.values()];
  let attachment = allAttachments[0] ?? null;
  if (!attachment && message.reference?.messageId) {
    try {
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
      attachment = [...refMsg.attachments.values()][0] ?? null;
    } catch { /* fall through */ }
  }
  const inlineUrl = positional.find((t) => /^https?:\/\//i.test(t)) ?? null;
  const inputUrl = attachment?.url ?? inlineUrl ?? null;
  if (!inputUrl) return null;
  return {
    inputUrl,
    inputName: attachment?.name ?? inlineUrl ?? "",
    inputCT: attachment?.contentType ?? "",
  };
}

async function sendResult(
  message: Message,
  statusMsg: Message,
  buffer: Buffer,
  fileName: string,
  label: string,
): Promise<void> {
  if (buffer.length <= DISCORD_MAX_BYTES) {
    await statusMsg.delete().catch(() => {});
    await message.reply({ content: `✅ ${label}`, files: [new AttachmentBuilder(buffer, { name: fileName })] });
  } else {
    await statusMsg.edit("📦 File too large — uploading to catbox.moe…").catch(() => {});
    const url = await uploadToCatbox(buffer, fileName);
    await statusMsg.delete().catch(() => {});
    await message.reply({ content: `✅ ${label}\n📦 ${url}` });
  }
}

async function applyIhtx(
  message: Message,
  effectStr: string,
  positional: string[],
  outName: string,
  label: string,
): Promise<void> {
  const media = await resolveMedia(message, positional);
  if (!media) {
    await message.reply("❌ Attach a file, reply to a message with one, or include a direct URL.");
    return;
  }
  const { inputUrl, inputName, inputCT } = media;
  const inputExt = extname(inputName) || ".mp4";
  const mediaType = detectMediaType(inputName, inputCT);
  const effects = parseEffectsString(effectStr);
  let statusMsg: Message;
  try { statusMsg = await message.reply(`⏳ Applying \`${label}\`…`); } catch { return; }
  try {
    const result = await processMedia({ effects, rep: 1, dur: null, inputUrl, inputExt, mediaType });
    await sendResult(message, statusMsg, result.buffer, `${outName}${result.ext}`, `\`${label}\``);
  } catch (err) {
    logger.error({ err }, `mediaeffects "${label}" failed`);
    const msg = err instanceof Error ? err.message : "Unknown error";
    await statusMsg.edit({ content: `❌ \`${label}\` failed: \`${msg.slice(0, 300)}\`` });
  }
}

async function applyMediascript(
  message: Message,
  code: string,
  outName: string,
  label: string,
): Promise<void> {
  let statusMsg: Message;
  try { statusMsg = await message.reply(`⏳ Applying \`${label}\`…`); } catch { return; }
  try {
    const result = await runMediascript(code);
    if (typeof result === "string") {
      await statusMsg.edit({ content: `❌ \`${label}\` failed: \`${result.slice(0, 300)}\`` });
      return;
    }
    await sendResult(message, statusMsg, result.buffer, `${outName}${result.ext}`, `\`${label}\``);
  } catch (err) {
    logger.error({ err }, `mediaeffects mediascript "${label}" failed`);
    const msg = err instanceof Error ? err.message : "Unknown error";
    await statusMsg.edit({ content: `❌ \`${label}\` failed: \`${msg.slice(0, 300)}\`` });
  }
}

// ── ihtx shorthand table: prefix → effectStr builder ─────────────────────────

type EffectFn = (s: number | undefined, d: number | undefined, p: string[]) => string;

const IHTX_EFFECTS: Record<string, EffectFn> = {
  "&rotate":    (s, d, p) => `rotate=${d ?? s ?? p[0] ?? 90}`,
  "&explode":   (s, _d, p) => `explode=${s ?? p[0] ?? 1}`,
  "&implode":   (s, _d, p) => `implode=${s ?? p[0] ?? 0.5}`,
  "&swirl":     (s, d, p) => `swirl=${d ?? s ?? p[0] ?? 45}`,
  "&hue":       (s, d, p) => `hue=${d ?? s ?? p[0] ?? 90}`,
  "&zoom":      (s, _d, p) => `zoom=${s ?? p[0] ?? 2}`,
  "&blur":      (s, _d, p) => `blur=${s ?? p[0] ?? 5}`,
  "&fisheye":   (s, _d, p) => `fisheye=${s ?? p[0] ?? 1.5}`,
  "&mirror":    (s, d, p) => `mirror=${d ?? s ?? p[0] ?? 45}`,
  "&polar":     () => "polar",
  "&depolar":   () => "depolar",
  "&flip":      () => "hflip",
  "&vflip":     () => "vflip",
  "&invert":    () => "invert",
  "&grayscale": () => "grayscale",
  "&sepia":     () => "sepia",
  "&spin":      (s, _d, p) => `spin=${s ?? p[0] ?? 1}`,
  "&orb":       () => "orb",
  "&deorb":     () => "deorb",
  "&sphere":    () => "sphere",
  "&desphere":  () => "desphere",
  "&nervous":   () => "nervous",
  "&wiggle":    (s, _d, p) => `wiggle=${s ?? p[0] ?? 5}`,
  "&cartoon":   (s, _d, p) => `cartoon=${s ?? p[0] ?? 0.11}`,
  "&kek":       (s, _d, p) => `kek=${s ?? p[0] ?? 3.5}`,
  "&vreverse":  () => "vreverse",
};

const MS_MIRROR  = new Set(["&haah", "&waaw", "&hooh", "&woow"]);
const MS_REVERSE = new Set(["&reverse"]);
const MS_AREV    = new Set(["&audioreverse", "&arev"]);
const MS_ENCODE: Record<string, string> = {
  "&bitrate":      "bitrate",
  "&audiobitrate": "audiobitrate",
  "&abitrate":     "audiobitrate",
  "&samplerate":   "samplerate",
  "&sr":           "samplerate",
  "&setfps":       "setfps",
  "&fps":          "setfps",
};

const ENCODE_USAGE: Record<string, string> = {
  bitrate:      "`&bitrate <value>`  e.g. `&bitrate 500k`",
  audiobitrate: "`&audiobitrate <value>`  e.g. `&audiobitrate 128k`",
  samplerate:   "`&samplerate <hz>`  e.g. `&samplerate 44100`",
  setfps:       "`&setfps <fps>`  e.g. `&setfps 30`",
};

// ── Primary prefix handler ────────────────────────────────────────────────────

/**
 * Call this from a MessageCreate listener (after bot/block checks).
 * Returns true if the command was recognised and handled.
 */
export async function handleMediaEffectCommand(message: Message): Promise<boolean> {
  const content = message.content.trim();
  if (!content.startsWith("&")) return false;

  const tokens = content.split(/\s+/).filter(Boolean);
  const prefix  = tokens[0]!.toLowerCase();
  const rest    = tokens.slice(1);
  const { s, d, vertical, positional } = parseFlags(rest);

  // ── ihtx shorthand ────────────────────────────────────────────────────────
  if (prefix in IHTX_EFFECTS) {
    const effectStr = IHTX_EFFECTS[prefix]!(s, d, positional);
    const name      = prefix.slice(1);
    const valPart   = effectStr.includes("=") ? effectStr.split("=").slice(1).join("=") : "";
    const label     = valPart ? `${name} ${valPart}` : name;
    await applyIhtx(message, effectStr, positional, `${name}_result`, label);
    return true;
  }

  // ── &distort <type> [value] ───────────────────────────────────────────────
  if (prefix === "&distort") {
    const type = positional[0] ?? "depolar";
    // value: explicit -s / -d flag, or a bare number as the second positional
    const val  = s ?? d ?? (positional[1] !== undefined && /^-?[\d.]+$/.test(positional[1]) ? positional[1] : null);
    const effectStr = val !== null ? `${type}=${val}` : type;
    const label     = val !== null ? `distort:${type}=${val}` : `distort:${type}`;
    await applyIhtx(message, effectStr, positional, "distort_result", label);
    return true;
  }

  // ── mediascript mirror effects ────────────────────────────────────────────
  if (MS_MIRROR.has(prefix)) {
    const cmd   = prefix.slice(1);
    const media = await resolveMedia(message, positional);
    if (!media) { await message.reply("❌ Attach a file, reply to a message with one, or include a direct URL."); return true; }
    await applyMediascript(message, `load ${media.inputUrl} v\n${cmd} v\nrender v`, `${cmd}_result`, cmd);
    return true;
  }

  // ── &reverse ─────────────────────────────────────────────────────────────
  if (MS_REVERSE.has(prefix)) {
    const media = await resolveMedia(message, positional);
    if (!media) { await message.reply("❌ Attach a file, reply to a message with one, or include a direct URL."); return true; }
    await applyMediascript(message, `load ${media.inputUrl} v\nreverse v\nrender v`, "reverse_result", "reverse");
    return true;
  }

  // ── &audioreverse / &arev ────────────────────────────────────────────────
  if (MS_AREV.has(prefix)) {
    const media = await resolveMedia(message, positional);
    if (!media) { await message.reply("❌ Attach a file, reply to a message with one, or include a direct URL."); return true; }
    await applyMediascript(message, `load ${media.inputUrl} v\naudioreverse v\nrender v`, "audioreverse_result", "audioreverse");
    return true;
  }

  // ── &bitrate / &audiobitrate / &samplerate / &setfps (and aliases) ───────
  if (prefix in MS_ENCODE) {
    const msCmd = MS_ENCODE[prefix]!;
    // Accept bare number/k-value from positional, or -s flag
    const value = s?.toString()
      ?? positional.find((t) => /^[\d.]+[kKmM]?$/.test(t))
      ?? null;
    if (!value) {
      await message.reply(`❌ Usage: ${ENCODE_USAGE[msCmd]}`);
      return true;
    }
    const media = await resolveMedia(message, positional);
    if (!media) { await message.reply("❌ Attach a file, reply to a message with one, or include a direct URL."); return true; }
    await applyMediascript(message, `load ${media.inputUrl} v\n${msCmd} v ${value}\nrender v`, `${msCmd}_result`, `${msCmd} ${value}`);
    return true;
  }

  // ── &join <url1> <url2> [-vertical] ──────────────────────────────────────
  if (prefix === "&join") {
    const urls = rest.filter((t) => /^https?:\/\//i.test(t));
    const allAttachments = [...message.attachments.values()];
    const attachUrl = allAttachments[0]?.url ?? null;

    let url1: string | null = null;
    let url2: string | null = null;

    if (urls.length >= 2) {
      [url1, url2] = [urls[0]!, urls[1]!];
    } else if (urls.length === 1 && attachUrl) {
      url1 = attachUrl; url2 = urls[0]!;
    } else if (urls.length === 1) {
      // Try replied message for second source
      if (message.reference?.messageId) {
        try {
          const ref = await message.channel.messages.fetch(message.reference.messageId);
          const refUrl = [...ref.attachments.values()][0]?.url ?? null;
          if (refUrl) { url1 = refUrl; url2 = urls[0]!; }
          else { url1 = urls[0]!; }
        } catch { url1 = urls[0]!; }
      } else { url1 = urls[0]!; }
    } else if (urls.length === 0 && attachUrl && message.reference?.messageId) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        url2 = [...ref.attachments.values()][0]?.url ?? null;
        url1 = attachUrl;
      } catch { url1 = attachUrl; }
    } else if (attachUrl) {
      url1 = attachUrl;
    }

    if (!url1 || !url2) {
      await message.reply(
        "❌ `&join` needs two media sources.\n" +
        "• `&join <url1> <url2> [-vertical]`\n" +
        "• Attach a file + `&join <url> [-vertical]`\n" +
        "• Reply to a message + attach a file + `&join [-vertical]`",
      );
      return true;
    }

    const isV  = vertical || rest.some((t) => t.toLowerCase() === "-vertical");
    const code = `load ${url1} v1\nload ${url2} v2\njoin v1 v2 result ${isV ? "true" : "false"}\nrender result`;
    await applyMediascript(message, code, "join_result", `join (${isV ? "vertical" : "horizontal"})`);
    return true;
  }

  // ── &audio / &a <subcommand> ──────────────────────────────────────────────
  if (prefix === "&audio" || prefix === "&a") {
    const sub         = positional[0]?.toLowerCase() ?? "";
    const subRest     = rest.slice(rest.indexOf(positional[0] ?? "") + 1);
    const { s: subS, positional: subPos } = parseFlags(subRest);

    if (!sub) {
      await message.reply(
        "❌ Usage: `&audio <subcommand> [options]`\n" +
        "Subcommands: `reverse` · `pitch <semitones>` · `volume <factor>` · `vibrato [freq] [depth]` · `acontrast [val]`\n" +
        "Examples: `&audio reverse` · `&a pitch -s 5` · `&a pitch 5 -5` · `&a vibrato 6 0.8`",
      );
      return true;
    }

    let effectStr = "";
    let label = "";

    if (sub === "reverse") {
      effectStr = "areverse"; label = "audio reverse";
    } else if (sub === "pitch") {
      const nums = subPos.filter((t) => /^-?\d+(\.\d+)?$/.test(t));
      const val  = nums.length > 0 ? nums.join(";") : String(subS ?? 0);
      effectStr = `pitch=${val}`; label = `pitch ${val}st`;
    } else if (sub === "volume") {
      const val = subS ?? parseFloat(subPos[0] ?? "") || 1.5;
      effectStr = `volume=${val}`; label = `volume ×${val}`;
    } else if (sub === "vibrato") {
      const freq  = subS?.toString() ?? (subPos[0] !== undefined && /^[\d.]+$/.test(subPos[0]) ? subPos[0] : "5");
      const depth = subPos[1] !== undefined && /^[\d.]+$/.test(subPos[1]) ? subPos[1] : "0.5";
      effectStr = `vibrato=${freq};${depth}`; label = `vibrato ${freq}Hz d=${depth}`;
    } else if (sub === "acontrast") {
      const val = subS ?? parseFloat(subPos[0] ?? "") || 33;
      effectStr = `acontrast=${val}`; label = `acontrast ${val}`;
    } else {
      await message.reply(
        `❌ Unknown audio subcommand \`${sub}\`.\n` +
        "Available: `reverse` · `pitch` · `volume` · `vibrato` · `acontrast`",
      );
      return true;
    }

    // Resolve media from the full positional list (might contain an inline URL)
    await applyIhtx(message, effectStr, positional, "audio_result", label);
    return true;
  }

  return false;
}

// ── Slash command JSON ────────────────────────────────────────────────────────

function withMedia<T extends { addAttachmentOption: Function; addStringOption: Function }>(b: T): T {
  (b as any).addAttachmentOption((o: any) => o.setName("media").setDescription("Image/video/audio to process"));
  (b as any).addStringOption((o: any) => o.setName("url").setDescription("Direct URL to media (alternative to attaching)"));
  return b;
}

export const mediaEffectSlashCommandJSON: unknown[] = [
  // Visual effects (ihtx)
  withMedia(new SlashCommandBuilder().setName("rotate").setDescription("Rotate media by degrees")
    .addNumberOption((o: any) => o.setName("degrees").setDescription("Angle in degrees (default 90)"))).toJSON(),
  withMedia(new SlashCommandBuilder().setName("explode").setDescription("Radially expand content outward from centre")
    .addNumberOption((o: any) => o.setName("strength").setDescription("Strength (default 1)"))).toJSON(),
  withMedia(new SlashCommandBuilder().setName("implode").setDescription("Radially pull content toward centre")
    .addNumberOption((o: any) => o.setName("strength").setDescription("Strength (default 0.5)"))).toJSON(),
  withMedia(new SlashCommandBuilder().setName("swirl").setDescription("Swirl distortion")
    .addNumberOption((o: any) => o.setName("degrees").setDescription("Swirl angle (default 45)"))).toJSON(),
  withMedia(new SlashCommandBuilder().setName("hue").setDescription("Shift hue by degrees")
    .addNumberOption((o: any) => o.setName("degrees").setDescription("Hue shift 0–360 (default 90)"))).toJSON(),
  withMedia(new SlashCommandBuilder().setName("zoom").setDescription("Zoom in")
    .addNumberOption((o: any) => o.setName("factor").setDescription("Zoom factor (default 2)"))).toJSON(),
  withMedia(new SlashCommandBuilder().setName("blur").setDescription("Gaussian blur")
    .addNumberOption((o: any) => o.setName("strength").setDescription("Blur strength (default 5)"))).toJSON(),
  withMedia(new SlashCommandBuilder().setName("fisheye").setDescription("Fisheye lens warp")
    .addNumberOption((o: any) => o.setName("strength").setDescription("Strength (default 1.5)"))).toJSON(),
  withMedia(new SlashCommandBuilder().setName("mirror").setDescription("Mirror fold at angle")
    .addNumberOption((o: any) => o.setName("angle").setDescription("Fold angle in degrees (default 45)"))).toJSON(),
  withMedia(new SlashCommandBuilder().setName("polar").setDescription("Unroll a circular image to a strip")).toJSON(),
  withMedia(new SlashCommandBuilder().setName("depolar").setDescription("Wrap a strip into a disk")).toJSON(),
  withMedia(new SlashCommandBuilder().setName("flip").setDescription("Flip horizontally")).toJSON(),
  withMedia(new SlashCommandBuilder().setName("vflip").setDescription("Flip vertically")).toJSON(),
  withMedia(new SlashCommandBuilder().setName("invert").setDescription("Invert all colours")).toJSON(),
  withMedia(new SlashCommandBuilder().setName("grayscale").setDescription("Desaturate (remove colour)")).toJSON(),
  withMedia(new SlashCommandBuilder().setName("distort").setDescription("Apply any named distortion effect")
    .addStringOption((o: any) => o.setName("type").setDescription("Effect name: depolar, polar, fisheye, swirl, barrel, orb, sphere, nervous, wiggle…").setRequired(true))
    .addStringOption((o: any) => o.setName("value").setDescription("Optional numeric value for the effect"))).toJSON(),
  // Mediascript mirror effects
  withMedia(new SlashCommandBuilder().setName("haah").setDescription("Mirror: left half reflects rightward")).toJSON(),
  withMedia(new SlashCommandBuilder().setName("waaw").setDescription("Mirror: right half reflects leftward")).toJSON(),
  withMedia(new SlashCommandBuilder().setName("hooh").setDescription("Mirror: top half reflects downward")).toJSON(),
  withMedia(new SlashCommandBuilder().setName("woow").setDescription("Mirror: bottom half reflects upward")).toJSON(),
  // Mediascript reversal
  withMedia(new SlashCommandBuilder().setName("reverse").setDescription("Reverse video frames (and audio)")).toJSON(),
  withMedia(new SlashCommandBuilder().setName("audioreverse").setDescription("Reverse audio track only; video unchanged")).toJSON(),
  // Mediascript encoding
  withMedia(new SlashCommandBuilder().setName("bitrate").setDescription("Re-encode video at a given bitrate")
    .addStringOption((o: any) => o.setName("value").setDescription("Bitrate, e.g. 500k or 2M").setRequired(true))).toJSON(),
  withMedia(new SlashCommandBuilder().setName("audiobitrate").setDescription("Re-encode audio at a given bitrate")
    .addStringOption((o: any) => o.setName("value").setDescription("Bitrate, e.g. 128k").setRequired(true))).toJSON(),
  withMedia(new SlashCommandBuilder().setName("samplerate").setDescription("Resample audio to a given Hz")
    .addIntegerOption((o: any) => o.setName("hz").setDescription("Sample rate in Hz, e.g. 44100").setRequired(true))).toJSON(),
  withMedia(new SlashCommandBuilder().setName("setfps").setDescription("Change video frame rate")
    .addNumberOption((o: any) => o.setName("fps").setDescription("Frames per second, e.g. 30").setRequired(true))).toJSON(),
  // Join
  new SlashCommandBuilder().setName("join").setDescription("Stack two media side-by-side or vertically")
    .addStringOption((o: any) => o.setName("url1").setDescription("First media URL").setRequired(true))
    .addStringOption((o: any) => o.setName("url2").setDescription("Second media URL").setRequired(true))
    .addBooleanOption((o: any) => o.setName("vertical").setDescription("Stack vertically (default: horizontal)"))
    .toJSON(),
  // Audio subcommands
  new SlashCommandBuilder().setName("audio").setDescription("Apply audio effects")
    .addSubcommand((sub: any) => sub.setName("reverse").setDescription("Reverse the audio track")
      .addAttachmentOption((o: any) => o.setName("media").setDescription("File to process"))
      .addStringOption((o: any) => o.setName("url").setDescription("Direct URL")))
    .addSubcommand((sub: any) => sub.setName("pitch").setDescription("Shift pitch by semitones")
      .addNumberOption((o: any) => o.setName("semitones").setDescription("Semitones, e.g. 5 or -7").setRequired(true))
      .addAttachmentOption((o: any) => o.setName("media").setDescription("File to process"))
      .addStringOption((o: any) => o.setName("url").setDescription("Direct URL")))
    .addSubcommand((sub: any) => sub.setName("volume").setDescription("Adjust volume")
      .addNumberOption((o: any) => o.setName("factor").setDescription("Multiplier, e.g. 1.5").setRequired(true))
      .addAttachmentOption((o: any) => o.setName("media").setDescription("File to process"))
      .addStringOption((o: any) => o.setName("url").setDescription("Direct URL")))
    .addSubcommand((sub: any) => sub.setName("vibrato").setDescription("Add vibrato")
      .addNumberOption((o: any) => o.setName("freq").setDescription("Frequency in Hz (default 5)"))
      .addNumberOption((o: any) => o.setName("depth").setDescription("Depth 0–1 (default 0.5)"))
      .addAttachmentOption((o: any) => o.setName("media").setDescription("File to process"))
      .addStringOption((o: any) => o.setName("url").setDescription("Direct URL")))
    .addSubcommand((sub: any) => sub.setName("acontrast").setDescription("Audio contrast enhancement")
      .addNumberOption((o: any) => o.setName("value").setDescription("0–100 (default 33)"))
      .addAttachmentOption((o: any) => o.setName("media").setDescription("File to process"))
      .addStringOption((o: any) => o.setName("url").setDescription("Direct URL")))
    .toJSON(),
];

// Set of command names handled by this module (for fast lookup in the slash dispatcher)
export const MEDIA_EFFECT_SLASH_NAMES = new Set([
  "rotate", "explode", "implode", "swirl", "hue", "zoom", "blur", "fisheye", "mirror",
  "polar", "depolar", "flip", "vflip", "invert", "grayscale", "distort",
  "haah", "waaw", "hooh", "woow", "reverse", "audioreverse",
  "bitrate", "audiobitrate", "samplerate", "setfps",
  "join", "audio",
]);

// ── Slash command executor ────────────────────────────────────────────────────

async function resolveSlashMedia(
  interaction: ChatInputCommandInteraction,
): Promise<{ inputUrl: string; inputName: string; inputCT: string } | null> {
  const a = interaction.options.getAttachment("media");
  if (a) return { inputUrl: a.url, inputName: a.name ?? "", inputCT: a.contentType ?? "" };
  const url = interaction.options.getString("url");
  if (url) {
    const name = (url.split("?")[0] ?? "").split("/").pop() ?? "file";
    return { inputUrl: url, inputName: name, inputCT: "" };
  }
  return null;
}

async function ihtxSlash(
  interaction: ChatInputCommandInteraction,
  effectStr: string,
  outName: string,
  label: string,
): Promise<void> {
  const media = await resolveSlashMedia(interaction);
  if (!media) { await interaction.editReply("❌ Attach a file or provide a `url` option."); return; }
  const { inputUrl, inputName, inputCT } = media;
  const inputExt = extname(inputName) || ".mp4";
  const mediaType = detectMediaType(inputName, inputCT);
  const effects = parseEffectsString(effectStr);
  try {
    const result = await processMedia({ effects, rep: 1, dur: null, inputUrl, inputExt, mediaType });
    const file = new AttachmentBuilder(result.buffer, { name: `${outName}${result.ext}` });
    await interaction.editReply({ content: `✅ \`${label}\``, files: [file] });
  } catch (err) {
    logger.error({ err }, `slash "${label}" failed`);
    const msg = err instanceof Error ? err.message : "Unknown error";
    await interaction.editReply({ content: `❌ \`${label}\` failed: \`${msg.slice(0, 300)}\`` });
  }
}

async function msSlash(
  interaction: ChatInputCommandInteraction,
  code: string,
  outName: string,
  label: string,
): Promise<void> {
  try {
    const result = await runMediascript(code);
    if (typeof result === "string") { await interaction.editReply({ content: `❌ \`${label}\` failed: \`${result.slice(0, 300)}\`` }); return; }
    const file = new AttachmentBuilder(result.buffer, { name: `${outName}${result.ext}` });
    await interaction.editReply({ content: `✅ \`${label}\``, files: [file] });
  } catch (err) {
    logger.error({ err }, `slash mediascript "${label}" failed`);
    const msg = err instanceof Error ? err.message : "Unknown error";
    await interaction.editReply({ content: `❌ \`${label}\` failed: \`${msg.slice(0, 300)}\`` });
  }
}

async function msSingleVarSlash(
  interaction: ChatInputCommandInteraction,
  msCmd: string,
  label: string,
): Promise<void> {
  const media = await resolveSlashMedia(interaction);
  if (!media) { await interaction.editReply("❌ Attach a file or provide a `url` option."); return; }
  await msSlash(interaction, `load ${media.inputUrl} v\n${msCmd} v\nrender v`, `${msCmd}_result`, label);
}

/**
 * Call from the InteractionCreate handler after deferring.
 * Returns true if the command was handled by this module.
 */
export async function executeMediaEffectSlash(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const cmd = interaction.commandName;
  if (!MEDIA_EFFECT_SLASH_NAMES.has(cmd)) return false;

  await interaction.deferReply();

  // ── visual ihtx effects ───────────────────────────────────────────────────
  if (cmd === "rotate") {
    const deg = interaction.options.getNumber("degrees") ?? 90;
    return void await ihtxSlash(interaction, `rotate=${deg}`, "rotate_result", `rotate ${deg}°`);
  }
  if (cmd === "explode") {
    const s = interaction.options.getNumber("strength") ?? 1;
    return void await ihtxSlash(interaction, `explode=${s}`, "explode_result", `explode ${s}`);
  }
  if (cmd === "implode") {
    const s = interaction.options.getNumber("strength") ?? 0.5;
    return void await ihtxSlash(interaction, `implode=${s}`, "implode_result", `implode ${s}`);
  }
  if (cmd === "swirl") {
    const deg = interaction.options.getNumber("degrees") ?? 45;
    return void await ihtxSlash(interaction, `swirl=${deg}`, "swirl_result", `swirl ${deg}°`);
  }
  if (cmd === "hue") {
    const deg = interaction.options.getNumber("degrees") ?? 90;
    return void await ihtxSlash(interaction, `hue=${deg}`, "hue_result", `hue ${deg}°`);
  }
  if (cmd === "zoom") {
    const f = interaction.options.getNumber("factor") ?? 2;
    return void await ihtxSlash(interaction, `zoom=${f}`, "zoom_result", `zoom ×${f}`);
  }
  if (cmd === "blur") {
    const s = interaction.options.getNumber("strength") ?? 5;
    return void await ihtxSlash(interaction, `blur=${s}`, "blur_result", `blur ${s}`);
  }
  if (cmd === "fisheye") {
    const s = interaction.options.getNumber("strength") ?? 1.5;
    return void await ihtxSlash(interaction, `fisheye=${s}`, "fisheye_result", `fisheye ${s}`);
  }
  if (cmd === "mirror") {
    const a = interaction.options.getNumber("angle") ?? 45;
    return void await ihtxSlash(interaction, `mirror=${a}`, "mirror_result", `mirror ${a}°`);
  }
  if (cmd === "polar")     return void await ihtxSlash(interaction, "polar",     "polar_result",     "polar");
  if (cmd === "depolar")   return void await ihtxSlash(interaction, "depolar",   "depolar_result",   "depolar");
  if (cmd === "flip")      return void await ihtxSlash(interaction, "hflip",     "flip_result",      "flip");
  if (cmd === "vflip")     return void await ihtxSlash(interaction, "vflip",     "vflip_result",     "vflip");
  if (cmd === "invert")    return void await ihtxSlash(interaction, "invert",    "invert_result",    "invert");
  if (cmd === "grayscale") return void await ihtxSlash(interaction, "grayscale", "grayscale_result", "grayscale");
  if (cmd === "distort") {
    const type = interaction.options.getString("type", true);
    const val  = interaction.options.getString("value");
    const eff  = val ? `${type}=${val}` : type;
    return void await ihtxSlash(interaction, eff, "distort_result", val ? `distort:${type}=${val}` : `distort:${type}`);
  }

  // ── mediascript mirror effects ────────────────────────────────────────────
  if (cmd === "haah" || cmd === "waaw" || cmd === "hooh" || cmd === "woow") {
    return void await msSingleVarSlash(interaction, cmd, cmd);
  }

  // ── mediascript reversal ──────────────────────────────────────────────────
  if (cmd === "reverse")     return void await msSingleVarSlash(interaction, "reverse",     "reverse");
  if (cmd === "audioreverse") return void await msSingleVarSlash(interaction, "audioreverse", "audioreverse");

  // ── mediascript encoding ──────────────────────────────────────────────────
  if (cmd === "bitrate") {
    const val   = interaction.options.getString("value", true);
    const media = await resolveSlashMedia(interaction);
    if (!media) { await interaction.editReply("❌ Attach a file or provide a `url` option."); return true; }
    await msSlash(interaction, `load ${media.inputUrl} v\nbitrate v ${val}\nrender v`, "bitrate_result", `bitrate ${val}`);
    return true;
  }
  if (cmd === "audiobitrate") {
    const val   = interaction.options.getString("value", true);
    const media = await resolveSlashMedia(interaction);
    if (!media) { await interaction.editReply("❌ Attach a file or provide a `url` option."); return true; }
    await msSlash(interaction, `load ${media.inputUrl} v\naudiobitrate v ${val}\nrender v`, "audiobitrate_result", `audiobitrate ${val}`);
    return true;
  }
  if (cmd === "samplerate") {
    const hz    = interaction.options.getInteger("hz", true);
    const media = await resolveSlashMedia(interaction);
    if (!media) { await interaction.editReply("❌ Attach a file or provide a `url` option."); return true; }
    await msSlash(interaction, `load ${media.inputUrl} v\nsamplerate v ${hz}\nrender v`, "samplerate_result", `samplerate ${hz}Hz`);
    return true;
  }
  if (cmd === "setfps") {
    const fps   = interaction.options.getNumber("fps", true);
    const media = await resolveSlashMedia(interaction);
    if (!media) { await interaction.editReply("❌ Attach a file or provide a `url` option."); return true; }
    await msSlash(interaction, `load ${media.inputUrl} v\nsetfps v ${fps}\nrender v`, "setfps_result", `setfps ${fps}`);
    return true;
  }

  // ── /join ─────────────────────────────────────────────────────────────────
  if (cmd === "join") {
    const url1 = interaction.options.getString("url1", true);
    const url2 = interaction.options.getString("url2", true);
    const isV  = interaction.options.getBoolean("vertical") ?? false;
    await msSlash(
      interaction,
      `load ${url1} v1\nload ${url2} v2\njoin v1 v2 result ${isV ? "true" : "false"}\nrender result`,
      "join_result",
      `join (${isV ? "vertical" : "horizontal"})`,
    );
    return true;
  }

  // ── /audio ────────────────────────────────────────────────────────────────
  if (cmd === "audio") {
    const sub = interaction.options.getSubcommand();
    let effectStr = ""; let label = "";
    if (sub === "reverse")   { effectStr = "areverse"; label = "audio reverse"; }
    else if (sub === "pitch")     { const st = interaction.options.getNumber("semitones", true); effectStr = `pitch=${st}`; label = `pitch ${st}st`; }
    else if (sub === "volume")    { const f  = interaction.options.getNumber("factor",    true); effectStr = `volume=${f}`;  label = `volume ×${f}`; }
    else if (sub === "vibrato")   {
      const freq  = interaction.options.getNumber("freq")  ?? 5;
      const depth = interaction.options.getNumber("depth") ?? 0.5;
      effectStr = `vibrato=${freq};${depth}`; label = `vibrato ${freq}Hz d=${depth}`;
    }
    else if (sub === "acontrast") { const v = interaction.options.getNumber("value") ?? 33; effectStr = `acontrast=${v}`; label = `acontrast ${v}`; }
    if (effectStr) await ihtxSlash(interaction, effectStr, "audio_result", label);
    return true;
  }

  return true;
}
