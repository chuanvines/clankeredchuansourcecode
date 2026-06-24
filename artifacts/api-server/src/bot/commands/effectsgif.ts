import {
  ChatInputCommandInteraction,
  AttachmentBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { parseEffectsString } from "../effects/parser.js";
import { processMedia, detectMediaType } from "../effects/processor.js";
import { toCdnUrl } from "./catboxupload.js";
import { extname } from "node:path";
import { logger } from "../lib/logger.js";

export const data = new SlashCommandBuilder()
  .setName("effectsgif")
  .setDescription("Apply effects and output as an animated GIF (works on images and videos)")
  .addAttachmentOption((opt) =>
    opt
      .setName("media")
      .setDescription("Image or video to process")
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt
      .setName("effects")
      .setDescription("Effects to apply, e.g. hflip,invert,swirl=90")
      .setRequired(true)
  )
  .addNumberOption((opt) =>
    opt
      .setName("dur")
      .setDescription("GIF duration in seconds (default 3, max 600)")
      .setMinValue(0.5)
      .setMaxValue(600)
      .setRequired(false)
  )
  .addIntegerOption((opt) =>
    opt
      .setName("rep")
      .setDescription("Times to apply the effect chain (default 1)")
      .setMinValue(1)
      .setMaxValue(100)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const attachment = interaction.options.getAttachment("media", true);
  const effectsStr = interaction.options.getString("effects", true);
  const dur = interaction.options.getNumber("dur") ?? 3;
  const rep = interaction.options.getInteger("rep") ?? 1;

  const inputUrl = toCdnUrl(attachment.url);
  const inputExt = extname(attachment.name || inputUrl) || ".jpg";
  const contentType = attachment.contentType ?? "";
  const mediaType = detectMediaType(attachment.name ?? "", contentType);

  if (mediaType === "audio") {
    await interaction.editReply("❌ `effectsgif` only works with images and videos, not audio files.");
    return;
  }

  const effects = parseEffectsString(effectsStr);
  const knownEffects = effects.map((e) => e.name).join(", ");

  logger.info(
    { effects: effectsStr, dur, rep, mediaType, url: inputUrl },
    "Processing effectsgif slash command"
  );

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

    const file = new AttachmentBuilder(result.buffer, { name: `effectsgif_result.gif` });

    await interaction.editReply({
      content: `✅ Applied: \`${knownEffects}\`${rep > 1 ? ` × ${rep}` : ""} → GIF\nUse \`&sync\` To Make IHTX better`,
      files: [file],
    });
  } catch (err) {
    logger.error({ err }, "Failed to process effectsgif");
    const message = err instanceof Error ? err.message : "Unknown error";
    await interaction.editReply({
      content: `❌ Processing failed: \`${message.slice(0, 300)}\``,
    });
  }
}
