import { Message, AttachmentBuilder, TextChannel, NewsChannel, ThreadChannel, DMChannel, PartialDMChannel } from "discord.js";
import axios from "axios";
import { logger } from "../lib/logger.js";
import { replyError, editError } from "../lib/embeds.js";

type SupportedChannel =
  | TextChannel
  | NewsChannel
  | ThreadChannel
  | DMChannel
  | PartialDMChannel;

interface AttachmentInfo {
  url: string;
  name: string;
  contentType: string;
}

async function downloadAttachment(url: string): Promise<Buffer> {
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

function pickAttachment(message: Message): AttachmentInfo | null {
  const all = [...message.attachments.values()];
  const att = all[0];
  if (!att) return null;
  return {
    url: att.url,
    name: att.name ?? "file",
    contentType: att.contentType ?? "",
  };
}

async function findLastChannelAttachment(
  message: Message,
): Promise<AttachmentInfo | null> {
  const channel = message.channel;
  if (!("messages" in channel)) return null;

  try {
    const fetched = await (channel as SupportedChannel & { messages: { fetch: (opts: object) => Promise<import("discord.js").Collection<string, Message>> } }).messages.fetch({ limit: 50, before: message.id });
    for (const [, msg] of fetched) {
      if (msg.attachments.size > 0) {
        const att = [...msg.attachments.values()][0]!;
        return {
          url: att.url,
          name: att.name ?? "file",
          contentType: att.contentType ?? "",
        };
      }
      // Also check embeds with a video/image proxy
      for (const embed of msg.embeds) {
        const src = embed.video?.url ?? embed.image?.url ?? null;
        if (src) {
          return { url: src, name: "embed_media", contentType: "" };
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, "&iv: failed to fetch channel history");
  }
  return null;
}

export async function handleIv(message: Message): Promise<void> {
  // 1. Attachment on this message
  let info = pickAttachment(message);

  // 2. Replied-to message
  if (!info && message.reference?.messageId) {
    try {
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      info = pickAttachment(ref);
    } catch {
      // fall through
    }
  }

  // 3. Last attachment in channel history
  if (!info) {
    info = await findLastChannelAttachment(message);
  }

  if (!info) {
    await replyError(message, "No attachment found — attach a file, reply to one, or make sure something was sent in this channel recently.");
    return;
  }

  let statusMsg: Message;
  try {
    statusMsg = await message.reply("⏳ Fetching…");
  } catch { return; }

  try {
    const buffer = await downloadAttachment(info.url);
    await statusMsg.delete().catch(() => {});
    const file = new AttachmentBuilder(buffer, { name: info.name || "media" });
    await message.reply({ files: [file] });
    logger.info({ url: info.url }, "&iv sent attachment");
  } catch (err) {
    logger.error({ err }, "&iv failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await editError(statusMsg, `Failed: \`${msg.slice(0, 300)}\``);
  }
}
