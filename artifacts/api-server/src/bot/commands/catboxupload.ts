import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import axios from "axios";
import FormData from "form-data";
import { basename } from "node:path";
import { logger } from "../lib/logger.js";
import { interactionError } from "../lib/embeds.js";

/**
 * Convert a media.discordapp.net proxy URL to a cdn.discordapp.com URL.
 * CDN URLs are permanent; proxy URLs can expire.
 */
export function toCdnUrl(url: string): string {
  return url.replace(/^https?:\/\/media\.discordapp\.net\//i, "https://cdn.discordapp.com/");
}

export async function downloadUrl(url: string): Promise<{ data: Buffer; filename: string }> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  };
  if (/discordapp\.(com|net)|discord\.com/i.test(url)) {
    headers["Referer"] = "https://discord.com/";
  }
  const res = await axios.get<Buffer>(url, {
    responseType: "arraybuffer",
    timeout: 30_000,
    maxContentLength: 200 * 1024 * 1024,
    headers,
  });
  const urlPath = url.split("?")[0] ?? "";
  const filename = basename(urlPath) || "file";
  return { data: Buffer.from(res.data), filename };
}

export async function uploadToCatbox(data: Buffer, filename: string): Promise<string> {
  const userhash = process.env["CATBOX_USER"] ?? process.env["CATBOX_USERHASH"] ?? "";
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("userhash", userhash);
  form.append("fileToUpload", data, { filename, knownLength: data.length });

  const res = await axios.post<string>("https://catbox.moe/user/api.php", form, {
    headers: form.getHeaders(),
    timeout: 60_000,
    responseType: "text",
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const result = (typeof res.data === "string" ? res.data : String(res.data)).trim();
  if (!result.startsWith("https://")) {
    throw new Error(`Catbox returned: ${result}`);
  }
  return result;
}

export const data = new SlashCommandBuilder()
  .setName("catboxupload")
  .setDescription("Upload a file or URL to catbox.moe and get a permanent link")
  .addStringOption((opt) =>
    opt
      .setName("url")
      .setDescription("URL of the file to upload (supports Discord CDN links)")
      .setRequired(false)
  )
  .addAttachmentOption((opt) =>
    opt
      .setName("attachment")
      .setDescription("File to upload directly")
      .setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const url = interaction.options.getString("url");
  const attachment = interaction.options.getAttachment("attachment");

  if (!url && !attachment) {
    await interactionError(interaction, "Provide either a `url` or an `attachment`.");
    return;
  }

  try {
    let fileData: Buffer;
    let filename: string;

    if (attachment) {
      const downloaded = await downloadUrl(attachment.url);
      fileData = downloaded.data;
      filename = attachment.name ?? downloaded.filename;
    } else {
      const downloaded = await downloadUrl(url!);
      fileData = downloaded.data;
      const urlPath = url!.split("?")[0] ?? "";
      filename = basename(urlPath) || "file";
    }

    const fileSizeMB = (fileData.length / 1024 / 1024).toFixed(2);
    logger.info({ filename, fileSizeMB }, "Uploading to catbox.moe");

    await interaction.editReply(`⏳ Uploading **${filename}** (${fileSizeMB} MB) to catbox.moe…`);

    const catboxUrl = await uploadToCatbox(fileData, filename);

    logger.info({ catboxUrl }, "Catbox upload successful");
    await interaction.editReply(`✅ **Uploaded!**\n${catboxUrl}`);
  } catch (err) {
    logger.error({ err }, "Catbox upload failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await interactionError(interaction, `Upload failed: \`${msg.slice(0, 300)}\``);
  }
}
