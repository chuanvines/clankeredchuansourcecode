import os
import re
import discord
from discord.ext import commands

from bot.effects.lsc import apply_lsc


intents = discord.Intents.default()
intents.message_content = True

bot = commands.Bot(command_prefix="!", intents=intents)


def get_video_url(message: discord.Message) -> str | None:
    if message.attachments:
        for att in message.attachments:
            if att.content_type and att.content_type.startswith("video"):
                return att.url
    if message.reference and message.reference.resolved:
        ref = message.reference.resolved
        if isinstance(ref, discord.Message):
            for att in ref.attachments:
                if att.content_type and att.content_type.startswith("video"):
                    return att.url
            url_match = re.search(r"https?://\S+\.(?:mp4|mov|webm|mkv|avi)\S*", ref.content)
            if url_match:
                return url_match.group()
    url_match = re.search(r"https?://\S+\.(?:mp4|mov|webm|mkv|avi)\S*", message.content)
    if url_match:
        return url_match.group()
    return None


def parse_effect(content: str) -> tuple[str, str | None] | None:
    match = re.match(r"lsc=(.+?)(?::(.+))?$", content.strip(), re.IGNORECASE)
    if match:
        text = match.group(1).strip()
        link = match.group(2).strip() if match.group(2) else None
        return text, link
    return None


@bot.event
async def on_ready():
    print(f"Logged in as {bot.user} (ID: {bot.user.id})")


@bot.command(name="effect")
async def effect_cmd(ctx: commands.Context, *, spec: str):
    parsed = parse_effect(spec)
    if parsed is None:
        await ctx.reply(
            "Unknown effect. Usage: `!effect lsc=<text>` or `!effect lsc=<text>:<video url>`"
        )
        return

    text, link = parsed
    video_url = link if (link and link != "{iv}") else get_video_url(ctx.message)

    if not video_url:
        await ctx.reply(
            "No video found. Attach a video, reply to a video message, or provide a URL after the colon."
        )
        return

    processing_msg = await ctx.reply("⏳ Processing `lsc` effect, please wait…")
    try:
        result_url = await apply_lsc(text, video_url)
        await processing_msg.edit(content=f"✅ Done! {result_url}")
    except Exception as e:
        error_text = str(e)[-1500:]
        await processing_msg.edit(content=f"❌ Error:\n```\n{error_text}\n```")


@bot.command(name="lsc")
async def lsc_cmd(ctx: commands.Context, text: str, url: str | None = None):
    video_url = url if url else get_video_url(ctx.message)
    if not video_url:
        await ctx.reply(
            "No video found. Attach a video, reply to a video, or pass a URL as the second argument."
        )
        return

    processing_msg = await ctx.reply("⏳ Processing `lsc` effect, please wait…")
    try:
        result_url = await apply_lsc(text, video_url)
        await processing_msg.edit(content=f"✅ Done! {result_url}")
    except Exception as e:
        error_text = str(e)[-1500:]
        await processing_msg.edit(content=f"❌ Error:\n```\n{error_text}\n```")


def run():
    token = os.environ["BOT_TOKEN"]
    bot.run(token)
