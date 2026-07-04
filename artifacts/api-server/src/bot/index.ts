import {
  Client,
  GatewayIntentBits,
  Events,
  ChatInputCommandInteraction,
  Message,
  AttachmentBuilder,
  TextChannel,
} from "discord.js";
import { execute as executeIhtx } from "./commands/ihtx.js";
import { runCqt } from "./commands/cqt.js";
import { runCwt } from "./commands/cwt.js";
import { runCq } from "./commands/cq.js";
import { runFft } from "./commands/fft.js";
import { runViz } from "./commands/viz.js";
import { runWaveform } from "./commands/waveform.js";
import { runAudioToImage } from "./commands/audiotoimage.js";
import { runImageToAudio } from "./commands/imagetoaudio.js";
import { runAddSource } from "./commands/addsource.js";
import { runLastExport } from "./commands/lastexport.js";
import { runNparison, MAX_N } from "./commands/nparison.js";
import { execute as executeCatbox, downloadUrl, uploadToCatbox, toCdnUrl } from "./commands/catboxupload.js";
import { handleTagCommand } from "./commands/tag.js";
import { handleBlockCommand, handleUnblockCommand, isBlocked, getBlockInfo } from "./commands/block.js";
import { runAi } from "./commands/ai.js";
import { execute as executeEffectsGif } from "./commands/effectsgif.js";
import { execute as executeStatus } from "./commands/status.js";
import { execute as executeGoogleSearchImage } from "./commands/googlesearchimage.js";
import { execute as executeCanvas, buildCanvasMessage, DEFAULT_ROWS, DEFAULT_COLS, DEFAULT_CHAR, MAX_ROWS, MAX_COLS } from "./commands/canvas.js";
import { runWorldNumbers } from "./commands/worldnumbers.js";
import { runVeb } from "./commands/veb.js";
import { runYtdl } from "./commands/ytdl.js";
import { runTts } from "./commands/tts.js";
import { runBytebeat } from "./commands/bytebeat.js";
import { registerCommands } from "./register.js";
import { parseEffectsString } from "./effects/parser.js";
import { processMedia, detectMediaType, probeMediaMeta } from "./effects/processor.js";
import { extname } from "node:path";
import { logger } from "./lib/logger.js";

const PREFIX = "&ihtx";

/** Message IDs of blocked users — populated by the gate listener before any command handler runs. */
const blockedMessages = new Set<string>();

/** Discord's free-tier inline media limit — files larger than this are sent via catbox. */
const DISCORD_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Send a processed result back to the user.
 * - If the buffer fits within Discord's 8 MB limit → delete the status message, reply with the file inline.
 * - Otherwise → update status to "uploading…", push to catbox.moe, then reply with the URL.
 */
async function sendResultOrCatbox(
  message: Message,
  statusMsg: Message,
  buffer: Buffer,
  fileName: string,
  content: string,
): Promise<void> {
  if (buffer.length <= DISCORD_MAX_BYTES) {
    await statusMsg.delete().catch(() => {});
    const file = new AttachmentBuilder(buffer, { name: fileName });
    await message.reply({ content, files: [file] });
  } else {
    await statusMsg.edit("📦 File too large for Discord — uploading to catbox.moe…").catch(() => {});
    const catboxUrl = await uploadToCatbox(buffer, fileName);
    await statusMsg.delete().catch(() => {});
    await message.reply({ content: `${content}\n📦 Too large for Discord → ${catboxUrl}` });
  }
}

const RANDOM_POOL = [
  "hflip", "vflip", "invert", "negate",
  "mirror=0", "mirror=90", "mirror=45", "mirror=135",
  "fisheye=1.5", "fisheye=2", "fisheye=0.8",
  "swirl=90", "swirl=180", "swirl=45", "swirl=270",
  "wave=3;3;30;30;0;0;5", "wave=5;5;20;20;90;0;3",
  "zoom=1.5", "zoom=2",
  "tile=2;2", "tile=3;3",
  "polar", "depolar",
  "hue=90", "hue=180", "hue=270",
  "huehsv=45", "huehsv=90", "huehsv=180",
  "scroll=0.1;0", "scroll=0;0.1",
  "vebfisheye=1", "vebdefisheye=1",
];

function getRandomEffects(): string {
  const shuffled = [...RANDOM_POOL].sort(() => Math.random() - 0.5);
  const count = Math.floor(Math.random() * 4) + 1;
  return shuffled.slice(0, count).join(",");
}

export async function startBot(): Promise<void> {
  const token = process.env["BOT_TOKEN"] ?? process.env["DISCORD_TOKEN"];

  if (!token) {
    logger.warn("BOT_TOKEN not set — Discord bot will not start");
    return;
  }

  // Run slash-command registration in the background — never block login on it
  registerCommands().catch((err) => logger.error({ err }, "Command registration failed"));

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  client.setMaxListeners(50);

  // ── block gate — must be registered first so blockedMessages is populated ──
  client.on(Events.MessageCreate, (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    const cmd = message.content.trim();
    if (!cmd.startsWith("&")) return;
    if (cmd.startsWith("&block") || cmd.startsWith("&unblock")) return;
    if (isBlocked(message.author.id)) {
      blockedMessages.add(message.id);
      const info = getBlockInfo(message.author.id);
      const until = info ? `until <t:${Math.floor(info.until / 1000)}:F>` : "";
      message.reply(`❌ You are blocked from using this bot ${until}.`).catch(() => {});
    }
  });

  client.once(Events.ClientReady, (c) => {
    logger.info({ tag: c.user.tag }, "Discord bot ready");
    c.user.setActivity("Making Videos And Misc...", { type: 0 });
  });

  // ── slash commands ────────────────────────────────────────────────────────
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const cmd = interaction as ChatInputCommandInteraction;

    if (cmd.commandName === "ihtxgen") {
      await executeIhtx(cmd);
      console.clear();
    } else if (cmd.commandName === "catboxupload") {
      await executeCatbox(cmd);
    } else if (cmd.commandName === "effectsgif") {
      await executeEffectsGif(cmd);
    } else if (cmd.commandName === "status") {
      await executeStatus(cmd);
    } else if (cmd.commandName === "googlesearchimage") {
      await executeGoogleSearchImage(cmd);
    } else if (cmd.commandName === "canvas") {
      await executeCanvas(cmd);
    }
  });

  // ── &ihtx handler (extracted so MessageUpdate can call it too) ───────────
  async function runIhtxMessage(message: Message): Promise<void> {
    const rest = message.content.slice(PREFIX.length).trim();

    const parts = rest.split(/\s+/);
    const firstToken = parts[0] ?? "";
    const firstIsUrl = /^https?:\/\//i.test(firstToken);

    const effectsStr = (!firstToken || firstIsUrl) ? getRandomEffects() : firstToken;

    const nonUrlParts = parts.filter((p) => !/^https?:\/\//i.test(p));
    const repIdx = firstIsUrl ? 0 : 1;
    const durIdx = firstIsUrl ? 1 : 2;
    const rep = nonUrlParts[repIdx] !== undefined ? Math.min(Math.max(parseInt(nonUrlParts[repIdx]!, 10) || 1, 1), 1000) : 1;
    const dur = nonUrlParts[durIdx] !== undefined ? parseFloat(nonUrlParts[durIdx]!) || null : null;
    const isCubeUrl = (u: string) => u.split("?")[0]!.toLowerCase().endsWith(".cube");
    const inlineUrls = (firstIsUrl ? parts : parts.slice(1)).filter((p) => /^https?:\/\//i.test(p));
    const inlineLutUrl   = inlineUrls.find(isCubeUrl) ?? null;
    const inlineMediaUrl = inlineUrls.find((u) => !isCubeUrl(u)) ?? null;

    const allAttachments = [...message.attachments.values()];
    const cubeAttachment = allAttachments.find((a) =>
      (a.name ?? "").toLowerCase().endsWith(".cube")
    ) ?? null;
    const mediaAttachments = allAttachments.filter((a) =>
      !(a.name ?? "").toLowerCase().endsWith(".cube")
    );

    let attachment: import("discord.js").Attachment | null = mediaAttachments[0] ?? null;
    if (!attachment && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        const refAll = [...refMsg.attachments.values()];
        attachment = refAll.find((a) => !(a.name ?? "").toLowerCase().endsWith(".cube")) ?? null;
      } catch { /* fall through */ }
    }

    const inputUrl  = attachment?.url ?? inlineMediaUrl ?? null;
    const inputName = attachment?.name ?? inlineMediaUrl ?? "";
    const inputCT   = attachment?.contentType ?? "";

    if (!inputUrl) {
      await message.reply(`❌ Attach an image/video/audio file, reply to a message that has one, or include a direct URL after your effects.`);
      return;
    }

    const inputExt  = extname(inputName) || ".jpg";
    const mediaType = detectMediaType(inputName, inputCT);
    const effects   = parseEffectsString(effectsStr);
    const knownEffects = effects.map((e) => e.name).join(", ");
    const lutFileUrl = cubeAttachment?.url ?? inlineLutUrl ?? undefined;

    logger.info(
      { effects: effectsStr, rep, dur, mediaType, url: inputUrl, lutFileUrl },
      "Processing &ihtx prefix command"
    );

    let replyMsg: Message;
    try {
      replyMsg = await message.reply(`⏳ Processing \`${knownEffects}\`${rep > 1 ? ` × ${rep}` : ""}…`);
    } catch { return; }

    const effectLabel = `\`${knownEffects}\`${rep > 1 ? ` × ${rep}` : ""}`;
    const metaPromise = mediaType !== "image" ? probeMediaMeta(inputUrl) : Promise.resolve({ duration: null });
    const buildEstimate = (srcDur: number | null): number | null => {
      if (mediaType === "image") return Math.max(3, rep * 1.5);
      if (srcDur == null) return null;
      const cappedDur = Math.min(srcDur, dur ?? 600);
      return Math.max(3, rep * cappedDur * 1.5);
    };
    const formatTime = (sec: number) => sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
    const startMs = Date.now();
    let estimateSec: number | null = null;
    metaPromise.then(({ duration }) => { estimateSec = buildEstimate(duration); });

    const ticker = setInterval(async () => {
      const elapsed = Math.round((Date.now() - startMs) / 1000);
      let line = `⏳ Processing ${effectLabel}… ${formatTime(elapsed)} elapsed`;
      if (estimateSec != null && estimateSec > 0) {
        const remaining = Math.max(0, Math.round(estimateSec - elapsed));
        line += ` / ~${formatTime(remaining)} remaining`;
        if (rep > 1) {
          const currentRep = Math.min(rep, Math.floor((elapsed / estimateSec) * rep) + 1);
          line += ` (${currentRep}/${rep})`;
        }
      }
      try { await replyMsg.edit({ content: line }); } catch { /* rate-limited or deleted */ }
    }, 5000);

    try {
      const result = await processMedia({ effects, rep, dur, inputUrl, inputExt, mediaType, lutFileUrl });
      clearInterval(ticker);
      const fileName = `ihtx_result${result.ext}`;
      await sendResultOrCatbox(
        message, replyMsg, result.buffer, fileName,
        `✅ Applied: ${effectLabel}\nUse \`&t sync\` To Make IHTX better`,
      );
      console.clear();
    } catch (err) {
      clearInterval(ticker);
      logger.error({ err }, "Prefix &ihtx failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await replyMsg.edit({ content: `❌ Processing failed: \`${msg.slice(0, 300)}\`` });
      console.clear();
    }
  }

  // ── prefix command: &ihtx <effects> [rep] [dur] ───────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.startsWith(PREFIX)) return;
    await runIhtxMessage(message);
  });

  // ── prefix command: &pitch <s1> [s2] [s3] ... ───────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().startsWith("&pitch")) return;

    const rest = message.content.slice(message.content.indexOf("&pitch") + 6).trim();
    const tokens = rest.split(/\s+/).filter(Boolean);

    // Check for inharmonic flag: &pitch i <semitones>
    const inharmonic = tokens[0]?.toLowerCase() === "i";
    const semitoneTokens = inharmonic ? tokens.slice(1) : tokens;

    // Collect semitone values (numbers, including negatives)
    const semitones = semitoneTokens.filter((t) => /^-?\d+(\.\d+)?$/.test(t));
    if (semitones.length === 0) {
      await message.reply(
        "❌ Usage: `&pitch [i] <semitone1> [semitone2] ...`\n" +
        "• `i` flag = inharmonic mode (chorus-like detuned pairs)\n" +
        "Examples: `&pitch 5` · `&pitch 5 -5` · `&pitch i 5 -5`",
      );
      return;
    }

    // Find inline media URL if any
    const inlineUrl = semitoneTokens.find((t) => /^https?:\/\//i.test(t)) ?? null;

    // Resolve media attachment: current → replied → inline URL
    const allAttachments = [...message.attachments.values()];
    let attachment: import("discord.js").Attachment | null = allAttachments[0] ?? null;
    if (!attachment && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        attachment = [...refMsg.attachments.values()][0] ?? null;
      } catch { /* fall through */ }
    }

    const inputUrl = attachment?.url ?? inlineUrl ?? null;
    if (!inputUrl) {
      await message.reply("❌ Attach an audio or video file, or reply to a message that has one.");
      return;
    }

    const inputName = attachment?.name ?? inlineUrl ?? "";
    const inputCT   = attachment?.contentType ?? "";
    const inputExt  = extname(inputName) || ".mp4";
    const mediaType = detectMediaType(inputName, inputCT);

    const effectsStr = inharmonic ? `pitch=i;${semitones.join(";")}` : `pitch=${semitones.join(";")}`;
    const effects    = parseEffectsString(effectsStr);
    const inTag      = inharmonic ? " (inharmonic)" : "";
    const label      = semitones.length === 1
      ? `pitch ${semitones[0]} semitone${semitones[0] === "1" || semitones[0] === "-1" ? "" : "s"}${inTag}`
      : `pitch [${semitones.join(", ")}] semitones (mixed)${inTag}`;

    let statusMsg: Message;
    try {
      statusMsg = await message.reply(`⏳ Applying ${label}…`);
    } catch { return; }

    try {
      const result = await processMedia({ effects, rep: 1, dur: null, inputUrl, inputExt, mediaType });
      const fileName = `pitch_result${result.ext}`;
      await sendResultOrCatbox(message, statusMsg, result.buffer, fileName, `✅ ${label}`);
    } catch (err) {
      logger.error({ err }, "Prefix &pitch failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await statusMsg.edit({ content: `❌ Pitch failed: \`${msg.slice(0, 300)}\`` });
    }
  });

  // ── prefix command: &vibrato <freq> [depth] ─────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().startsWith("&vibrato")) return;

    const rest = message.content.slice(message.content.indexOf("&vibrato") + 8).trim();
    const tokens = rest.split(/\s+/).filter(Boolean);

    const nums = tokens.filter((t) => /^-?\d+(\.\d+)?$/.test(t));
    const freq  = nums[0] ?? "5";
    const depth = nums[1] ?? "0.5";

    const depthNum = parseFloat(depth);
    if (parseFloat(freq) <= 0 || depthNum < 0 || depthNum > 1) {
      await message.reply(
        "❌ Usage: `&vibrato [freq] [depth]`\n" +
        "• `freq` — vibrato rate in Hz (default `5`, range 0.1–20000)\n" +
        "• `depth` — depth/intensity (default `0.5`, range `0`–`1`)\n" +
        "Example: `&vibrato 6 0.8`",
      );
      return;
    }

    const inlineUrl = tokens.find((t) => /^https?:\/\//i.test(t)) ?? null;
    const allAttachments = [...message.attachments.values()];
    let attachment: import("discord.js").Attachment | null = allAttachments[0] ?? null;
    if (!attachment && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        attachment = [...refMsg.attachments.values()][0] ?? null;
      } catch { /* fall through */ }
    }

    const inputUrl = attachment?.url ?? inlineUrl ?? null;
    if (!inputUrl) {
      await message.reply("❌ Attach an audio or video file, or reply to a message that has one.");
      return;
    }

    const inputName = attachment?.name ?? inlineUrl ?? "";
    const inputCT   = attachment?.contentType ?? "";
    const inputExt  = extname(inputName) || ".mp4";
    const mediaType = detectMediaType(inputName, inputCT);

    const effectsStr = `vibrato=${freq};${depth}`;
    const effects    = parseEffectsString(effectsStr);
    const label      = `vibrato (freq=${freq} Hz, depth=${depth})`;

    let statusMsg: Message;
    try {
      statusMsg = await message.reply(`⏳ Applying ${label}…`);
    } catch { return; }

    try {
      const result = await processMedia({ effects, rep: 1, dur: null, inputUrl, inputExt, mediaType });
      await sendResultOrCatbox(message, statusMsg, result.buffer, `vibrato_result${result.ext}`, `✅ ${label}`);
    } catch (err) {
      logger.error({ err }, "Prefix &vibrato failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await statusMsg.edit({ content: `❌ Vibrato failed: \`${msg.slice(0, 300)}\`` });
    }
  });

  // ── prefix command: &effectsgif <effects> [dur] [rep] ────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.startsWith("&effectsgif")) return;

    const rest = message.content.slice("&effectsgif".length).trim();
    const parts = rest.split(/\s+/);
    const effectsStr = parts[0] ?? "hflip";
    const dur = parts[1] !== undefined ? Math.min(Math.max(parseFloat(parts[1]) || 3, 0.5), 600) : 3;
    const rep = parts[2] !== undefined ? Math.min(Math.max(parseInt(parts[2], 10) || 1, 1), 100) : 1;

    const allAttachments = [...message.attachments.values()];
    let attachment = allAttachments[0] ?? null;

    if (!attachment && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        attachment = [...refMsg.attachments.values()][0] ?? null;
      } catch { /* fall through */ }
    }

    if (!attachment) {
      await message.reply("❌ Attach an image or video, or reply to a message that has one.");
      return;
    }

    const mediaType = detectMediaType(attachment.name ?? "", attachment.contentType ?? "");
    if (mediaType === "audio") {
      await message.reply("❌ `&effectsgif` only works with images and videos.");
      return;
    }

    const inputUrl = toCdnUrl(attachment.url);
    const inputExt = extname(attachment.name || inputUrl) || ".jpg";
    const effects = parseEffectsString(effectsStr);
    const knownEffects = effects.map((e) => e.name).join(", ");

    let statusMsg: Message;
    try {
      statusMsg = await message.reply(`⏳ Generating GIF: \`${knownEffects}\`…`);
    } catch { return; }

    try {
      const result = await processMedia({
        effects,
        rep,
        dur,
        inputUrl,
        inputExt,
        mediaType,
        forceGif: true,
      });

      await sendResultOrCatbox(
        message,
        statusMsg,
        result.buffer,
        "effectsgif_result.gif",
        `✅ Applied: \`${knownEffects}\`${rep > 1 ? ` × ${rep}` : ""} → GIF\nUse \`&sync\` To Make IHTX better`,
      );
    } catch (err) {
      logger.error({ err }, "Prefix &effectsgif failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await statusMsg.edit({ content: `❌ Processing failed: \`${msg.slice(0, 300)}\`` });
    }
  });

  // ── prefix command: &help ────────────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().startsWith("&help")) return;

    const help = [
      "Clankered Chuan — Effect Reference",
      "Usage: &ihtx <effects> [rep] [dur]  or  /ihtxgen",
      "Chain effects with commas. Params use =, sub-params use ;.",
      "Example: &ihtx mirror=45,hue=90,pitch=5 3 10",
      "",
      "=== Video ===",
      "hflip                              - flip horizontally",
      "vflip                              - flip vertically",
      "leftsplit(<effects>)               - apply effects to left half (mirrored), e.g. leftsplit(hflip,vflip)",
      "rightsplit(<effects>)              - apply effects to right half, e.g. rightsplit(hflip,vflip)",
      "invert                             - invert all colours",
      "invlum                             - invert luminosity only (LUT-based)",
      "invertrgb=r;g;b                    - invert specific channels (1=invert, 0=keep)",
      "gradientmap=<json>                 - map luminance to colour gradient; json = [[r,g,b,a],...] (≥2 stops, 0-255)",
      "grayscale                          - remove colour (desaturate)",
      "sepia                              - sepia tone",
      "rotate=<deg>                       - rotate by degrees",
      "hue=<deg>                          - shift hue (0-360)",
      "huehsv=<val>                       - shift hue in HSV space (degrees, e.g. 180)",
      "hueshifthsv=<val>                  - alias for huehsv",
      "ffmpeghue=<deg>                    - hue shift via FFmpeg hue filter (degrees)",
      "brightness=<val>                   - adjust brightness (e.g. 0.1)",
      "contrast=<val>                     - adjust contrast (e.g. 1.5)",
      "saturation=<val>                   - adjust saturation (e.g. 1.5)",
      "channelblend=<r>;<g>;<b>           - swap/mix RGB channels (r/g/b)",
      "swapuv                             - swap U and V chroma channels",
      "blur=<strength>                    - gaussian-style box blur (e.g. blur=5, default 5)",
      "vignette=<strength>                - darken edges (vignette effect, e.g. 1)",
      "gm4                                - selective colour boost (blacks/whites)",
      "realgm4                            - solarise via curves inversion",
      "",
      "=== Distortion ===",
      "fisheye=<strength>;<xpos>;<ypos>;<radius> - fisheye lens warp (xpos/ypos 0.0–1.0, default 0.5;0.5;1)",
      "explode=<strength>                 - radially expand content outward from centre (default 1)",
      "implode=<strength>                 - radially pull content toward centre / pincushion (default 1)",
      "distort=<k>                        - barrel (k<0) or pincushion (k>0) lens distortion (default -0.5)",
      "swirl=<angle>;<cx>;<cy>;<r>        - swirl distortion",
      "wave=<xw>;<yw>;<xa>;<ya>;<xph>;<yph>;<speed>  - wave warp (freq x;y, amp x;y, phase x;y, speed)",
      "ripple=<speed>;<frequency>;<amplitude>;<phase> - radial ripple warp from centre (defaults: 1;30;10;0)",
      "zoom=<scale>                       - zoom in (e.g. 2)",
      "mirror=<angle>;<cx>;<cy>            - mirror fold at angle (degrees), cx/cy = fold centre (0.0–1.0, default 0.5;0.5)",
      "tile=<x>;<y>                       - tile the image N×M times",
      "polar                              - unroll a circular image to a strip",
      "depolar                            - wrap a strip into a disk",
      "wiggle=<strength>                  - frei0r distort0r ripple warp (e.g. 5)",
      "cartoon=<triLevel>;<threshold>     - frei0r cartoon effect (defaults 0.11;0.20)",
      "distort0r=<amount>;<tilt>          - frei0r distort0r lens warp (defaults 0.2;0.5)",
      "nervous                            - frei0r nervous glitch (random frame swap)",
      "spin=<speed>                       - continuous rotation (speed multiplier, e.g. 1)",
      "orb                                - fisheye orb effect",
      "deorb                              - reverse orb",
      "orb2                               - vertical-scroll orb (hammer projection)",
      "deorb2                             - reverse orb2",
      "orb3                               - diagonal-scroll orb (hammer projection)",
      "deorb3                             - reverse orb3",
      "sphere                             - scrolling rotating sphere effect",
      "desphere                           - reverse sphere",
      "gm91deform                         - perspective/barrel warp (geq-based)",
      "",
      "=== v360 Projection ===",
      "vebfisheye=<n>                     - equirectangular → ball (n passes)",
      "vebdefisheye=<n>                   - ball → equirectangular (n passes)",
      "vebfisheye2=<n>                    - equirectangular → hammer (n passes)",
      "vebdefisheye2=<n>                  - hammer → equirectangular (n passes)",
      "vebfisheye3=<n>                    - fisheye → 22:7 projection (n passes)",
      "vebdefisheye3=<n>                  - 22:7 → fisheye (n passes, upscaled)",
      "",
      "=== Transform / Overlay ===",
      "scroll=<h>;<v>                     - continuous scroll speed h,v (0.0–1.0)",
      "scroll=hpos=<x>                    - set horizontal scroll start (0.0–1.0)",
      "scroll=ypos=<y>                    - set vertical scroll start (0.0–1.0)",
      "scroll=hpos=<x>;ypos=<y>           - set both scroll start positions",
      "scroll=<x1>;<y1>;<x2>;<y2>        - animated pan pixel (x1,y1)→(x2,y2) over 10s",
      "scroll=<x1>;<y1>;<x2>;<y2>;<dur>  - same, custom duration in seconds",
      "pan=<x>;<y>                        - shift image by x/y pixels (edge clamp)",
      "vreverse                           - reverse video frames (and audio)",
      "chromashift                        - chroma channel pixel shift glitch effect",
      "watermark=<url>                    - overlay transparent PNG at full video size",
      "ring                               - preset frame overlay (full-frame PNG)",
      "ring=<url>                         - frame overlay with custom URL",
      "miui                               - MIUI-style watermark (preset, full-frame)",
      "reddit                             - Reddit-style watermark (preset, full-frame)",
      "caption=<text>                     - text at top-centre (white + black border, scales to video)",
      "timecode                           - burn-in running timecode (HH:MM:SS:FF) top-right",
      "radar                              - 2×2 panel: video · waveform · histogram · vectorscope",
      "",
      "=== Audio ===",
      "pitch=<semitones>                  - shift pitch (e.g. 5 or -7). Multi: pitch=5;-3;2",
      "pitch=i;<semitones>               - inharmonic pitch: each semitone gets a +0.12st detuned pair (chorus/tape-wow)",
      "",
      "=== Shorthand Commands ===",
      "&pitch [i] <s1> [s2] [s3] ...     - pitch shift with space-separated semitones",
      "  Example: &pitch 5               → single semitone shift up",
      "  Example: &pitch 5 -5            → two pitches mixed (5 up + 5 down)",
      "  Example: &pitch i 5 -5          → inharmonic mode: chorus-like detuned pairs",
      "  Example: &pitch -12 0 12        → octave down + original + octave up",
      "volume=<val>                       - adjust volume multiplier (e.g. 1.5)",
      "vibrato=<freq>;<depth>             - vibrato effect (e.g. 5;0.5)",
      "areverse                           - reverse audio",
      "acontrast=<val>                    - audio contrast enhancement (0–100, default 33)",
      "audioequalizer=<sub>;<bass>;<lmid>;<mid>;<hmid> - 5-band EQ gain in dB (40/150/375/1k/3kHz)",
      "autotune=<carrier_url>             - anlms-based autotune using a carrier audio URL",
      "avflip                             - spectral flip via afftfilt (freq-domain mirror, outputs mono)",
      "",
      "=== Shake / Earthquake ===",
      "shakeh=<s>                         - horizontal pixel shake (s = max offset in pixels, default 5)",
      "shakev=<s>                         - vertical pixel shake",
      "shake=<s>                          - horizontal + vertical pixel shake",
      "nbfxearthquake                     - two-pass vidstab earthquake effect (uses external motion source)",
      "",
      "=== Variables ===",
      "vd                                 - video duration in seconds (use in expressions, e.g. hue=360*t/vd)",
      "",
      "=== Notsobot Style ===",
      "kek=<sat>                          - kek meme effect: green-tinted high-saturation (default sat=3.5)",
      "exo                                - edge glow overlay (sobel edges screen-blended onto original)",
      "explode=<strength>                 - centre content expands outward (default 1) — see Distortion",
      "implode=<strength>                 - content pulled toward centre (default 1) — see Distortion",
      "distort=<k>                        - barrel/pincushion distortion (default -0.5) — see Distortion",
      "swirl=<angle>                      - swirl distortion — see Distortion",
      "hueshifthsv=<deg>                  - HSV hue shift alias for huehsv — see Colour",
      "",
      "=== Special ===",
      "rays=N                             - light-ray bloom (N zoom steps, default 4, max 20)",
      "sierpinskiransomware               - 2×2 speed grid: 1x · 2x · 1.33x · 0.5x (with audio)",
      "tvsim=<linesync>;<zoomgrill>       - TV glitch; linesync 0–1, zoomgrill ≥1 crops displacement",
      "",
      "=== LUT / Raw ===",
      "lut=<url>                          - apply external .cube LUT file from URL",
      "invlum                             - built-in luminosity-inversion LUT",
      "ffmpeg(<args>)                     - raw ffmpeg flags: -vf / -filter_complex / -map",
      "",
      "=== Visualisation Commands ===",
      "&cqt  [file|reply|url]             - constant-Q transform video + audio",
      "&cwt  [file|reply|url]             - continuous wavelet transform video + audio",
      "&cq   [file|reply|url]             - CQT rotated vertical bar style + audio",
      "&fft  [file|reply|url]             - FFT spectrum (showspectrum) video + audio",
      "&viz  [file|reply|url]             - 2×2 grid: CQT · CWT · CQ · FFT + audio",
      "&waveform [file|reply|url] [style] - waveform video + audio  (style: line/point/p2p/cline)",
      "&audiotoimage [file|reply|url]     - audio → full spectrogram PNG",
      "&imagetoaudio [file|reply|url]     - image → databend audio (pixel bytes as PCM)",
      "",
      "=== Other Commands ===",
      "&ihtx <effects> [rep] [dur]        - apply video/audio effects",
      "/ihtxgen                           - same, as slash command",
      "&effectsgif <effects> [dur] [rep]  - apply effects, output as GIF",
      "/effectsgif                        - same, as slash command",
      "&sync [file|reply]                 - auto-detect slow-motion and fix; falls back to AV sync if not slow-mo",
      "/sync                              - slash command (AV sync only)",
      "tvsim=<linesync>                   - TV displacement/glitch effect; linesync 0–1 (0=strongest, default 0.5)",
      "&catbox [url|file]                 - upload file to catbox.moe",
      "/catboxupload                      - same, as slash command",
      "&canvas [rows] [cols] [char]       - send the canvas spoiler grid (default 10×12 spaces, max 20×20); char replaces spaces e.g. &canvas 10 10 T",
      "/canvas [rows] [cols] [char]       - same, as slash command",
      "&addsource <src_url> [rows] [xpos] [ypos]  - overlay source on base; rows divides source width (0=native); xpos: 0=left 1=center 2=right (center blocked when rows is even); ypos: 0=top 1=middle 2=bottom",
      "&help                              - show this help",
    ].join("\n");

    const txtFile = new AttachmentBuilder(Buffer.from(help, "utf-8"), { name: "ihtx_help.txt" });
    await message.reply({ files: [txtFile] });
  });

  // ── prefix command: &cqt ─────────────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().startsWith("&cqt")) return;

    const rest = message.content.slice("&cqt".length).trim();
    const inlineUrl = /^https?:\/\/\S+/.exec(rest)?.[0] ?? null;

    // Resolve attachment: current message → replied-to message → inline URL
    const allAttachments = [...message.attachments.values()];
    let fileUrl: string | null = allAttachments[0]?.url ?? null;
    let fileName: string = allAttachments[0]?.name ?? "file";

    if (!fileUrl && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        const refAttach = [...refMsg.attachments.values()][0] ?? null;
        fileUrl = refAttach?.url ?? null;
        fileName = refAttach?.name ?? "file";
        if (!fileUrl) {
          const refUrl = /https?:\/\/\S+/.exec(refMsg.content)?.[0] ?? null;
          if (refUrl) { fileUrl = refUrl; fileName = "file"; }
        }
      } catch { /* fall through */ }
    }

    if (!fileUrl && inlineUrl) {
      fileUrl = inlineUrl;
      fileName = inlineUrl.split("/").pop()?.split("?")[0] ?? "file";
    }

    if (!fileUrl) {
      await message.reply("❌ Attach an audio/video file, reply to a message that has one, or include a direct URL.");
      return;
    }

    const inputExt = extname(fileName) || ".mp4";

    let statusMsg: Message;
    try {
      statusMsg = await message.reply("⏳ Generating CQT visualisation…");
    } catch { return; }

    try {
      const buffer = await runCqt(fileUrl, inputExt);
      await sendResultOrCatbox(message, statusMsg, buffer, "cqt_output.mp4", "✅ CQT visualisation");
    } catch (err) {
      logger.error({ err }, "Prefix &cqt failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await statusMsg.edit({ content: `❌ CQT failed: \`${msg.slice(0, 300)}\`` });
    }
  });

  // ── prefix command: &cwt ─────────────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().startsWith("&cwt")) return;

    const rest = message.content.slice("&cwt".length).trim();
    const inlineUrl = /^https?:\/\/\S+/.exec(rest)?.[0] ?? null;
    const allAttachments = [...message.attachments.values()];
    let fileUrl: string | null = allAttachments[0]?.url ?? null;
    let fileName: string = allAttachments[0]?.name ?? "file";

    if (!fileUrl && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        const refAttach = [...refMsg.attachments.values()][0] ?? null;
        fileUrl = refAttach?.url ?? null;
        fileName = refAttach?.name ?? "file";
        if (!fileUrl) {
          const refUrl = /https?:\/\/\S+/.exec(refMsg.content)?.[0] ?? null;
          if (refUrl) { fileUrl = refUrl; fileName = "file"; }
        }
      } catch { /* fall through */ }
    }
    if (!fileUrl && inlineUrl) { fileUrl = inlineUrl; fileName = inlineUrl.split("/").pop()?.split("?")[0] ?? "file"; }
    if (!fileUrl) { await message.reply("❌ Attach an audio/video file, reply to one, or include a direct URL."); return; }

    const inputExt = extname(fileName) || ".mp4";
    let statusMsg: Message;
    try { statusMsg = await message.reply("⏳ Generating CWT visualisation…"); } catch { return; }
    try {
      const buffer = await runCwt(fileUrl, inputExt);
      await sendResultOrCatbox(message, statusMsg, buffer, "cwt_output.mp4", "✅ CWT visualisation");
    } catch (err) {
      logger.error({ err }, "Prefix &cwt failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await statusMsg.edit({ content: `❌ CWT failed: \`${msg.slice(0, 300)}\`` });
    }
  });

  // ── prefix command: &cq ───────────────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!/^&cq(\s|$)/.test(message.content.trim())) return;

    const rest = message.content.slice("&cq".length).trim();
    const inlineUrl = /^https?:\/\/\S+/.exec(rest)?.[0] ?? null;
    const allAttachments = [...message.attachments.values()];
    let fileUrl: string | null = allAttachments[0]?.url ?? null;
    let fileName: string = allAttachments[0]?.name ?? "file";

    if (!fileUrl && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        const refAttach = [...refMsg.attachments.values()][0] ?? null;
        fileUrl = refAttach?.url ?? null;
        fileName = refAttach?.name ?? "file";
        if (!fileUrl) {
          const refUrl = /https?:\/\/\S+/.exec(refMsg.content)?.[0] ?? null;
          if (refUrl) { fileUrl = refUrl; fileName = "file"; }
        }
      } catch { /* fall through */ }
    }
    if (!fileUrl && inlineUrl) { fileUrl = inlineUrl; fileName = inlineUrl.split("/").pop()?.split("?")[0] ?? "file"; }
    if (!fileUrl) { await message.reply("❌ Attach an audio/video file, reply to one, or include a direct URL."); return; }

    const inputExt = extname(fileName) || ".mp4";
    let statusMsg: Message;
    try { statusMsg = await message.reply("⏳ Generating CQ visualisation…"); } catch { return; }
    try {
      const buffer = await runCq(fileUrl, inputExt);
      await sendResultOrCatbox(message, statusMsg, buffer, "cq_output.mp4", "✅ CQ visualisation");
    } catch (err) {
      logger.error({ err }, "Prefix &cq failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await statusMsg.edit({ content: `❌ CQ failed: \`${msg.slice(0, 300)}\`` });
    }
  });

  // ── prefix command: &fft ─────────────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().startsWith("&fft")) return;

    const rest = message.content.slice("&fft".length).trim();
    const inlineUrl = /^https?:\/\/\S+/.exec(rest)?.[0] ?? null;
    const allAttachments = [...message.attachments.values()];
    let fileUrl: string | null = allAttachments[0]?.url ?? null;
    let fileName: string = allAttachments[0]?.name ?? "file";

    if (!fileUrl && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        const refAttach = [...refMsg.attachments.values()][0] ?? null;
        fileUrl = refAttach?.url ?? null;
        fileName = refAttach?.name ?? "file";
        if (!fileUrl) {
          const refUrl = /https?:\/\/\S+/.exec(refMsg.content)?.[0] ?? null;
          if (refUrl) { fileUrl = refUrl; fileName = "file"; }
        }
      } catch { /* fall through */ }
    }
    if (!fileUrl && inlineUrl) { fileUrl = inlineUrl; fileName = inlineUrl.split("/").pop()?.split("?")[0] ?? "file"; }
    if (!fileUrl) { await message.reply("❌ Attach an audio/video file, reply to one, or include a direct URL."); return; }

    const inputExt = extname(fileName) || ".mp4";
    let statusMsg: Message;
    try { statusMsg = await message.reply("⏳ Generating FFT spectrum visualisation…"); } catch { return; }
    try {
      const buffer = await runFft(fileUrl, inputExt);
      await sendResultOrCatbox(message, statusMsg, buffer, "fft_output.mp4", "✅ FFT spectrum visualisation");
    } catch (err) {
      logger.error({ err }, "Prefix &fft failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await statusMsg.edit({ content: `❌ FFT failed: \`${msg.slice(0, 300)}\`` });
    }
  });

  // ── prefix command: &viz ─────────────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().startsWith("&viz")) return;

    const rest = message.content.slice("&viz".length).trim();
    const inlineUrl = /^https?:\/\/\S+/.exec(rest)?.[0] ?? null;
    const allAttachments = [...message.attachments.values()];
    let fileUrl: string | null = allAttachments[0]?.url ?? null;
    let fileName: string = allAttachments[0]?.name ?? "file";

    if (!fileUrl && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        const refAttach = [...refMsg.attachments.values()][0] ?? null;
        fileUrl = refAttach?.url ?? null;
        fileName = refAttach?.name ?? "file";
        if (!fileUrl) {
          const refUrl = /https?:\/\/\S+/.exec(refMsg.content)?.[0] ?? null;
          if (refUrl) { fileUrl = refUrl; fileName = "file"; }
        }
      } catch { /* fall through */ }
    }
    if (!fileUrl && inlineUrl) { fileUrl = inlineUrl; fileName = inlineUrl.split("/").pop()?.split("?")[0] ?? "file"; }
    if (!fileUrl) { await message.reply("❌ Attach an audio/video file, reply to one, or include a direct URL."); return; }

    const inputExt = extname(fileName) || ".mp4";
    let statusMsg: Message;
    try { statusMsg = await message.reply("⏳ Generating 2×2 visualisation grid…"); } catch { return; }
    try {
      const buffer = await runViz(fileUrl, inputExt);
      await sendResultOrCatbox(message, statusMsg, buffer, "viz_output.mp4", "✅ Visualisation grid (CQT · CWT · CQ · FFT)");
    } catch (err) {
      logger.error({ err }, "Prefix &viz failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await statusMsg.edit({ content: `❌ Viz failed: \`${msg.slice(0, 300)}\`` });
    }
  });

  // ── prefix command: &waveform ────────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().startsWith("&waveform")) return;

    const rest = message.content.slice("&waveform".length).trim();
    // Optional style arg — first non-URL word if present
    const styleMatch = /^(line|point|p2p|cline)\b/.exec(rest);
    const style = styleMatch?.[1] ?? "line";
    const inlineUrl = /https?:\/\/\S+/.exec(rest)?.[0] ?? null;

    const allAttachments = [...message.attachments.values()];
    let fileUrl: string | null = allAttachments[0]?.url ?? null;
    let fileName: string = allAttachments[0]?.name ?? "file";

    if (!fileUrl && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        const refAttach = [...refMsg.attachments.values()][0] ?? null;
        fileUrl = refAttach?.url ?? null;
        fileName = refAttach?.name ?? "file";
        if (!fileUrl) {
          const refUrl = /https?:\/\/\S+/.exec(refMsg.content)?.[0] ?? null;
          if (refUrl) { fileUrl = refUrl; fileName = "file"; }
        }
      } catch { /* fall through */ }
    }
    if (!fileUrl && inlineUrl) { fileUrl = inlineUrl; fileName = inlineUrl.split("/").pop()?.split("?")[0] ?? "file"; }
    if (!fileUrl) { await message.reply("❌ Attach an audio/video file, reply to one, or include a direct URL."); return; }

    const inputExt = extname(fileName) || ".mp4";
    let statusMsg: Message;
    try { statusMsg = await message.reply(`⏳ Generating waveform (style: \`${style}\`)…`); } catch { return; }
    try {
      const buffer = await runWaveform(fileUrl, inputExt, style);
      await sendResultOrCatbox(message, statusMsg, buffer, "waveform_output.mp4", `✅ Waveform visualisation (style: \`${style}\`)`);
    } catch (err) {
      logger.error({ err }, "Prefix &waveform failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await statusMsg.edit({ content: `❌ Waveform failed: \`${msg.slice(0, 300)}\`` });
    }
  });

  // ── prefix command: &audiotoimage ────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().startsWith("&audiotoimage")) return;

    const rest = message.content.slice("&audiotoimage".length).trim();
    const inlineUrl = /https?:\/\/\S+/.exec(rest)?.[0] ?? null;
    const allAttachments = [...message.attachments.values()];
    let fileUrl: string | null = allAttachments[0]?.url ?? null;
    let fileName: string = allAttachments[0]?.name ?? "file";

    if (!fileUrl && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        const refAttach = [...refMsg.attachments.values()][0] ?? null;
        fileUrl = refAttach?.url ?? null;
        fileName = refAttach?.name ?? "file";
        if (!fileUrl) {
          const refUrl = /https?:\/\/\S+/.exec(refMsg.content)?.[0] ?? null;
          if (refUrl) { fileUrl = refUrl; fileName = "file"; }
        }
      } catch { /* fall through */ }
    }
    if (!fileUrl && inlineUrl) { fileUrl = inlineUrl; fileName = inlineUrl.split("/").pop()?.split("?")[0] ?? "file"; }
    if (!fileUrl) { await message.reply("❌ Attach an audio/video file, reply to one, or include a direct URL."); return; }

    const inputExt = extname(fileName) || ".mp4";
    let statusMsg: Message;
    try { statusMsg = await message.reply("⏳ Generating spectrogram image…"); } catch { return; }
    try {
      const buffer = await runAudioToImage(fileUrl, inputExt);
      await statusMsg.delete().catch(() => {});
      await message.reply({ content: "✅ Spectrogram", files: [{ attachment: buffer, name: "spectrogram.png" }] });
    } catch (err) {
      logger.error({ err }, "Prefix &audiotoimage failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await statusMsg.edit({ content: `❌ audiotoimage failed: \`${msg.slice(0, 300)}\`` });
    }
  });

  // ── prefix command: &imagetoaudio ────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().startsWith("&imagetoaudio")) return;

    const rest = message.content.slice("&imagetoaudio".length).trim();
    const inlineUrl = /https?:\/\/\S+/.exec(rest)?.[0] ?? null;
    const allAttachments = [...message.attachments.values()];
    let fileUrl: string | null = allAttachments[0]?.url ?? null;
    let fileName: string = allAttachments[0]?.name ?? "file";

    if (!fileUrl && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        const refAttach = [...refMsg.attachments.values()][0] ?? null;
        fileUrl = refAttach?.url ?? null;
        fileName = refAttach?.name ?? "file";
        if (!fileUrl) {
          const refUrl = /https?:\/\/\S+/.exec(refMsg.content)?.[0] ?? null;
          if (refUrl) { fileUrl = refUrl; fileName = "file"; }
        }
      } catch { /* fall through */ }
    }
    if (!fileUrl && inlineUrl) { fileUrl = inlineUrl; fileName = inlineUrl.split("/").pop()?.split("?")[0] ?? "file"; }
    if (!fileUrl) { await message.reply("❌ Attach an image file, reply to one, or include a direct URL."); return; }

    const inputExt = extname(fileName) || ".png";
    let statusMsg: Message;
    try { statusMsg = await message.reply("⏳ Databending image to audio…"); } catch { return; }
    try {
      const buffer = await runImageToAudio(fileUrl, inputExt);
      await sendResultOrCatbox(message, statusMsg, buffer, "imagetoaudio.mp3", "✅ Image → audio (databend)");
    } catch (err) {
      logger.error({ err }, "Prefix &imagetoaudio failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await statusMsg.edit({ content: `❌ imagetoaudio failed: \`${msg.slice(0, 300)}\`` });
    }
  });

  // ── prefix command: &addsource / &as <src_url> [rows] [xpos] [ypos] ──────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    const trimmed = message.content.trim();
    const AS_PREFIXES = ["&addsource", "&as"];
    const matchedPrefix = AS_PREFIXES.find((p) => trimmed.startsWith(p + " ") || trimmed === p);
    if (!matchedPrefix) return;

    const rest = message.content.slice(message.content.indexOf(matchedPrefix) + matchedPrefix.length).trim();

    // First URL in rest is the source video; remaining tokens are rows/xpos/ypos
    const urlMatch = /https?:\/\/\S+/.exec(rest);
    if (!urlMatch) {
      await message.reply("❌ Provide a source video URL after `&addsource`. Usage: `&addsource <src_url> [rows] [xpos] [ypos]`");
      return;
    }
    const sourceUrl = urlMatch[0]!;
    const afterUrl  = rest.slice(urlMatch.index + sourceUrl.length).trim();
    const tokens    = afterUrl.split(/\s+/).filter(Boolean);
    const rows  = Math.max(0, parseInt(tokens[0] ?? "0", 10) || 0);
    const scale = rows > 0 ? 1 / rows : 0;
    const xpos  = parseInt(tokens[1] ?? "0", 10) || 0;
    const ypos  = parseInt(tokens[2] ?? "0", 10) || 0;
    const sourceExt = sourceUrl.split("?")[0]!.match(/\.\w+$/)?.[0] ?? ".mp4";

    // Even rows have no center column — force xpos away from 1 (middle)
    const effectiveXpos = (rows > 0 && rows % 2 === 0 && xpos === 1) ? 0 : xpos;
    // Even rows have no center row — force ypos away from 1 (middle)
    const effectiveYpos = (rows > 0 && rows % 2 === 0 && ypos === 1) ? 0 : ypos;

    // Resolve base video: attachment → replied message → inline URL before source URL
    const allAttachments = [...message.attachments.values()];
    let mainUrl: string | null = allAttachments[0]?.url ?? null;
    let mainName: string = allAttachments[0]?.name ?? "file";

    if (!mainUrl && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        const refAttach = [...refMsg.attachments.values()][0] ?? null;
        mainUrl  = refAttach?.url ?? null;
        mainName = refAttach?.name ?? "file";
        if (!mainUrl) {
          const refUrl = /https?:\/\/\S+/.exec(refMsg.content)?.[0] ?? null;
          if (refUrl) { mainUrl = refUrl; mainName = "file"; }
        }
      } catch { /* fall through */ }
    }

    if (!mainUrl) {
      await message.reply("❌ Attach a base video, reply to one, or include it before the source URL.");
      return;
    }

    const mainExt = extname(mainName) || ".mp4";

    let statusMsg: Message;
    try { statusMsg = await message.reply("⏳ Overlaying source video…"); } catch { return; }
    try {
      const buffer = await runAddSource({ mainUrl, mainExt, sourceUrl, sourceExt, scale, xpos: effectiveXpos, ypos: effectiveYpos });
      await sendResultOrCatbox(message, statusMsg, buffer, "addsource.mp4", "✅ Done");
    } catch (err) {
      logger.error({ err }, "Prefix &addsource failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await statusMsg.edit({ content: `❌ addsource failed: \`${msg.slice(0, 300)}\`` });
    }
  });

  // ── prefix command: &lastexport / &le <duration> ─────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    const trimmed = message.content.trim();
    const LE_PREFIXES = ["&lastexport", "&le"];
    const matchedPrefix = LE_PREFIXES.find((p) => trimmed.startsWith(p + " ") || trimmed === p);
    if (!matchedPrefix) return;

    const rest = message.content.slice(message.content.indexOf(matchedPrefix) + matchedPrefix.length).trim();
    const durRaw = rest.split(/\s+/)[0] ?? "";
    const duration = parseFloat(durRaw) || null;

    if (!duration || duration <= 0) {
      await message.reply("❌ Provide a duration in seconds. Usage: `&lastexport <seconds>` or `&le <seconds>`");
      return;
    }

    const inlineUrl = /https?:\/\/\S+/.exec(rest)?.[0] ?? null;
    const allAttachments = [...message.attachments.values()];
    let fileUrl: string | null = allAttachments[0]?.url ?? null;
    let fileName: string = allAttachments[0]?.name ?? "file.mp4";

    if (!fileUrl && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        const refAttach = [...refMsg.attachments.values()][0] ?? null;
        fileUrl = refAttach?.url ?? null;
        fileName = refAttach?.name ?? "file.mp4";
        if (!fileUrl) {
          const refUrl = /https?:\/\/\S+/.exec(refMsg.content)?.[0] ?? null;
          if (refUrl) { fileUrl = refUrl; fileName = "file.mp4"; }
        }
      } catch { /* fall through */ }
    }

    if (!fileUrl && inlineUrl) {
      fileUrl = inlineUrl;
      fileName = inlineUrl.split("/").pop()?.split("?")[0] ?? "file.mp4";
    }

    if (!fileUrl) {
      await message.reply("❌ Attach a video file, reply to a message that has one, or include a direct URL.");
      return;
    }

    const inputExt = extname(fileName) || ".mp4";

    let statusMsg: Message;
    try {
      statusMsg = await message.reply(`⏳ Extracting last ${duration}s…`);
    } catch { return; }

    try {
      const buffer = await runLastExport(fileUrl, inputExt, duration);
      await sendResultOrCatbox(message, statusMsg, buffer, "lastexport.mp4", `✅ Last ${duration}s extracted`);
    } catch (err) {
      logger.error({ err }, "Prefix &lastexport failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await statusMsg.edit({ content: `❌ lastexport failed: \`${msg.slice(0, 300)}\`` });
    }
  });

  // ── prefix command: &catbox [url] ─────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.startsWith("&catbox")) return;

    const rest = message.content.slice("&catbox".length).trim();
    const inlineUrl = /^https?:\/\/\S+/.exec(rest)?.[0] ?? null;

    // Resolve attachment: current message → replied-to message → inline URL
    const allAttachments = [...message.attachments.values()];
    let fileUrl: string | null = allAttachments[0]?.url ?? null;
    let filename: string | null = allAttachments[0]?.name ?? null;

    if (!fileUrl && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        const refAttach = [...refMsg.attachments.values()][0] ?? null;
        fileUrl = refAttach?.url ?? null;
        filename = refAttach?.name ?? null;
      } catch { /* fall through */ }
    }

    if (!fileUrl && inlineUrl) {
      fileUrl = inlineUrl;
    }

    if (!fileUrl) {
      await message.reply("❌ Attach a file, reply to a message with an attachment, or include a direct URL after `&catbox`.");
      return;
    }

    let statusMsg: Message;
    try {
      statusMsg = await message.reply("⏳ Uploading to catbox.moe…");
    } catch { return; }

    try {
      const downloaded = await downloadUrl(fileUrl);
      const resolvedFilename = filename ?? downloaded.filename;
      const catboxUrl = await uploadToCatbox(downloaded.data, resolvedFilename);
      logger.info({ catboxUrl, resolvedFilename }, "Catbox prefix upload successful");
      await statusMsg.edit(`✅ **Uploaded!**\n${catboxUrl}`);
    } catch (err) {
      logger.error({ err }, "Catbox prefix upload failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await statusMsg.edit(`❌ Upload failed: \`${msg.slice(0, 300)}\``);
    }
  });

  // ── prefix command: &nparison <effects> <n> ──────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().startsWith("&nparison")) return;

    const rest = message.content.slice("&nparison".length).trim();
    const parts = rest.split(/\s+/).filter(Boolean);

    const effectsStr = parts[0] ?? "";
    if (!effectsStr) {
      await message.reply(`❌ Usage: \`&nparison <effects> [n]\`  (e.g. \`&nparison invert 3\`)`);
      return;
    }

    const rawN = parseInt(parts[1] ?? "3", 10);
    const n = Math.min(Math.max(isNaN(rawN) ? 3 : rawN, 2), MAX_N);

    const allAttachments = [...message.attachments.values()];
    let inputUrl: string | null = allAttachments[0]?.url ?? null;
    let inputName: string = allAttachments[0]?.name ?? "";
    let inputCT: string = allAttachments[0]?.contentType ?? "";

    if (!inputUrl && message.reference?.messageId) {
      try {
        const refMsg = await message.channel.messages.fetch(message.reference.messageId);
        const refAttach = [...refMsg.attachments.values()][0] ?? null;
        inputUrl = refAttach?.url ?? null;
        inputName = refAttach?.name ?? "";
        inputCT = refAttach?.contentType ?? "";
      } catch { /* fall through */ }
    }

    const inlineUrl = parts.slice(1).find((p) => /^https?:\/\//i.test(p)) ?? null;
    if (!inputUrl && inlineUrl) {
      inputUrl = inlineUrl;
      inputName = inlineUrl;
    }

    if (!inputUrl) {
      await message.reply("❌ Attach an image/video, reply to a message with one, or include a direct URL.");
      return;
    }

    const { extname } = await import("node:path");
    const inputExt = extname(inputName) || ".jpg";
    const mediaType = detectMediaType(inputName, inputCT);
    const cells = n * n;

    let statusMsg: Message;
    try {
      statusMsg = await message.reply(`⏳ Building ${n}×${n} grid (${cells} cells) for \`${effectsStr}\`… (1/${cells})`);
    } catch { return; }

    const startMs = Date.now();
    let lastCell = 0;

    const onProgress = async (current: number, total: number) => {
      lastCell = current;
      const elapsed = Math.round((Date.now() - startMs) / 1000);
      try {
        await statusMsg.edit(`⏳ Building ${n}×${n} grid… cell ${current}/${total} — ${elapsed}s elapsed`);
      } catch { /* rate-limited */ }
    };

    try {
      const buffer = await runNparison({
        inputUrl,
        inputExt,
        mediaType,
        effectsStr,
        n,
        onProgress,
      });

      const elapsed = Math.round((Date.now() - startMs) / 1000);
      const label = `\`${effectsStr}\` × 1–${cells} (${n}×${n} grid, ${elapsed}s)`;

      await sendResultOrCatbox(
        message,
        statusMsg,
        buffer,
        "nparison_result.mp4",
        `✅ Nparison: ${label}`,
      );
    } catch (err) {
      logger.error({ err }, "Nparison failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await statusMsg.edit(`❌ Nparison failed: \`${msg.slice(0, 300)}\``);
    }
  });

  // ── prefix command: &tag / &t ────────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    const c = message.content.trim();
    if (!c.startsWith("&tag") && !c.startsWith("&t ") && c !== "&t") return;
    await handleTagCommand(message, uploadToCatbox);
  });

  // ── prefix command: &canvas [rows] [cols] ────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().startsWith("&canvas")) return;

    const rest = message.content.slice("&canvas".length).trim();
    const parts = rest.split(/\s+/).filter(Boolean);
    const rows = parts[0] !== undefined ? Math.min(Math.max(parseInt(parts[0], 10) || DEFAULT_ROWS, 1), MAX_ROWS) : DEFAULT_ROWS;
    const cols = parts[1] !== undefined ? Math.min(Math.max(parseInt(parts[1], 10) || DEFAULT_COLS, 1), MAX_COLS) : DEFAULT_COLS;
    const char = parts[2] !== undefined ? parts[2].slice(0, 1) : DEFAULT_CHAR;

    await message.reply({ content: buildCanvasMessage(rows, cols, char) });
  });

  // ── prefix command: &veb <effects> ──────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().toLowerCase().startsWith("&veb")) return;
    await runVeb(message);
  });

  // ── prefix command: &youtubedownload / &ytdl <url or search> ────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    const lower = message.content.trim().toLowerCase();
    if (!lower.startsWith("&youtubedownload") && !lower.startsWith("&ytdl")) return;
    await runYtdl(message);
  });

  // ── prefix command: &tts <voice> <text> ─────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().toLowerCase().startsWith("&tts")) return;
    await runTts(message);
  });

  // ── prefix command: &bytebeat <mode> <samplerate> <duration> <code> ─────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().toLowerCase().startsWith("&bytebeat")) return;
    await runBytebeat(message);
  });

  // ── alias: destroy <effects>  →  &veb <effects> ──────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    const trimmed = message.content.trim();
    if (!trimmed.toLowerCase().startsWith("destroy")) return;
    const afterKeyword = trimmed.slice("destroy".length);
    if (afterKeyword.length > 0 && !/^\s/.test(afterKeyword)) return;
    const rest = afterKeyword.trim();
    const fakeMessage = new Proxy(message, {
      get(target, prop) {
        if (prop === "content") return `&veb ${rest}`;
        const val = (target as Record<string | symbol, unknown>)[prop as string];
        return typeof val === "function" ? val.bind(target) : val;
      },
    });
    await runVeb(fakeMessage as Message);
  });

  // ── prefix command: &ai <prompt> ─────────────────────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().startsWith("&ai ") && message.content.trim() !== "&ai") return;
    await runAi(message);
  });

  // ── prefix command: &block <@mention|userId> <hours> ────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (!message.content.trim().startsWith("&block")) return;
    await handleBlockCommand(message);
  });

  // ── prefix command: &unblock <@mention|userId> ───────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (!message.content.trim().startsWith("&unblock")) return;
    await handleUnblockCommand(message);
  });

  // ── prefix command: &undo ────────────────────────────────────────────────
  // Reply to any bot message with &undo to delete it.
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (!message.content.trim().toLowerCase().startsWith("&undo")) return;
    if (!message.reference?.messageId) {
      await message.reply("❌ Reply to a bot message with `&undo` to delete it.").catch(() => {});
      return;
    }
    try {
      const target = await message.channel.messages.fetch(message.reference.messageId);
      if (!target.author.bot) {
        await message.reply("❌ You can only `&undo` a bot message.").catch(() => {});
        return;
      }
      if (target.author.id !== client.user?.id) {
        await message.reply("❌ That message is from a different bot.").catch(() => {});
        return;
      }
      await target.delete();
      await message.delete().catch(() => {});
    } catch (err) {
      logger.error({ err }, "&undo failed");
      await message.reply("❌ Could not delete that message (missing permissions?).").catch(() => {});
    }
  });

  // ── prefix command: &worldnumbers <expression> ───────────────────────────
  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (blockedMessages.has(message.id)) return;
    if (!message.content.trim().startsWith("&worldnumbers")) return;

    const expr = message.content.slice(message.content.indexOf("&worldnumbers") + 13).trim();
    if (!expr) {
      await message.reply(
        "❌ Usage: `&worldnumbers <expression>`\n" +
        "Example: `&worldnumbers x^2` · `&worldnumbers 2*x` · `&worldnumbers x*(x+1)/2`\n" +
        "Numbers matching your expression are highlighted in red on a spiral grid.",
      );
      return;
    }

    let statusMsg: Message;
    try {
      statusMsg = await message.reply(`⏳ Generating number spiral for \`${expr}\`…`);
    } catch { return; }

    try {
      const buffer = await runWorldNumbers(expr);
      await statusMsg.delete().catch(() => {});
      const file = new AttachmentBuilder(buffer, { name: "worldnumbers.png" });
      await message.reply({ content: `🔢 **World Numbers** — \`${expr}\``, files: [file] });
    } catch (err) {
      logger.error({ err }, "&worldnumbers failed");
      const msg = err instanceof Error ? err.message : "Unknown error";
      await statusMsg.edit({ content: `❌ Failed: \`${msg.slice(0, 300)}\`` });
    }
  });

  // ── message edit: re-run prefix commands ─────────────────────────────────
  // When a user edits a prefix command message, delete the bot's old reply
  // and re-run the command so the result reflects the updated content.
  client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
    // Skip if only embeds/attachments changed (content is identical)
    if (oldMessage.content === newMessage.content) return;

    // Fetch the full message object if Discord gave us a partial
    let msg: Message;
    try {
      msg = newMessage.partial ? await newMessage.fetch() : newMessage as Message;
    } catch { return; }

    if (msg.author.bot) return;
    if (blockedMessages.has(msg.id)) return;

    const content = msg.content.trim();
    if (!content.startsWith("&")) return;
    const lower = content.toLowerCase();

    // Only continue for commands we know how to re-run
    const isVeb  = lower.startsWith("&veb");
    const isIhtx = content.startsWith(PREFIX);
    const isTag  = lower.startsWith("&t ") || lower === "&t";
    const isAi   = lower.startsWith("&ai ") || lower === "&ai";
    if (!isVeb && !isIhtx && !isTag && !isAi) return;

    // Find and delete any previous bot replies to this message
    try {
      const ch = msg.channel;
      if ("messages" in ch) {
        const recent = await (ch as TextChannel).messages.fetch({ limit: 30 });
        for (const [, botMsg] of recent) {
          if (
            botMsg.author.id === client.user!.id &&
            botMsg.reference?.messageId === msg.id
          ) {
            await botMsg.delete().catch(() => {});
          }
        }
      }
    } catch { /* ignore — we'll still re-run even if cleanup fails */ }

    // Re-run the appropriate command handler
    if (isVeb)       await runVeb(msg);
    else if (isIhtx) await runIhtxMessage(msg);
    else if (isTag)  await handleTagCommand(msg, uploadToCatbox);
    else if (isAi)   await runAi(msg);
  });

  client.on(Events.Error, (err) => {
    logger.error({ err }, "Discord client error");
  });

  await client.login(token);
}
