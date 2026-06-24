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
  .setName("ihtxgen")
  .setDescription("Apply FFmpeg effects to an attached image, video, or audio file")
  .addAttachmentOption((opt) =>
    opt
      .setName("media")
      .setDescription("Image, video, or audio to process")
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt
      .setName("effects")
      .setDescription(
        "e.g. hflip,vflip,invert,fisheye=1.5,swirl=90,wave=3;3;20;20,invlum,lut=url,pitch=5;-7"
      )
      .setRequired(true)
  )
  .addIntegerOption((opt) =>
    opt
      .setName("rep")
      .setDescription("Number of times to apply the effect chain (1–1000, default 1)")
      .setMinValue(1)
      .setMaxValue(1000)
  )
  .addNumberOption((opt) =>
    opt
      .setName("dur")
      .setDescription(
        "For images: frame duration in seconds for animated GIF output. For video/audio: output duration cap."
      )
      .setMinValue(0.05)
      .setMaxValue(60)
  )
  .addAttachmentOption((opt) =>
    opt
      .setName("lut")
      .setDescription("Optional .cube LUT file to apply (same as lut= param but via file attachment)")
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const attachment = interaction.options.getAttachment("media", true);
  const lutAttachment = interaction.options.getAttachment("lut") ?? null;
  const effectsStr = interaction.options.getString("effects", true);
  const rep = Math.min(interaction.options.getInteger("rep") ?? 1, 1000);
  const dur = interaction.options.getNumber("dur") ?? null;

  const inputUrl = toCdnUrl(attachment.url);
  const lutUrl = lutAttachment ? toCdnUrl(lutAttachment.url) : undefined;
  const inputExt = extname(attachment.name || inputUrl) || ".jpg";
  const contentType = attachment.contentType ?? "";
  const mediaType = detectMediaType(attachment.name ?? "", contentType);

  logger.info(
    { effects: effectsStr, rep, dur, mediaType, url: inputUrl, lutFileUrl: lutUrl },
    "Processing ihtxgen command"
  );

  const effects = parseEffectsString(effectsStr);
  const knownEffects = effects.map((e) => e.name).join(", ");

  try {
    const result = await processMedia({
      effects,
      rep,
      dur,
      inputUrl,
      inputExt,
      mediaType,
      lutFileUrl: lutUrl,
    });

    const fileName = `ihtx_result${result.ext}`;
    const file = new AttachmentBuilder(result.buffer, { name: fileName });

    await interaction.editReply({
      content: `✅ Applied: \`${knownEffects}\`${rep > 1 ? ` × ${rep}` : ""}\nUse \`&t sync\` To Make IHTX better`,
      files: [file],
    });
  } catch (err) {
    logger.error({ err }, "Failed to process media");
    const message =
      err instanceof Error ? err.message : "Unknown error";
    await interaction.editReply({
      content: `❌ Processing failed: \`${message.slice(0, 300)}\``,
    });
  }
}
