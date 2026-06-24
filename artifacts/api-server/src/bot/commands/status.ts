import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("status")
  .setDescription("Show bot uptime, server count, and memory usage");

export const botStartTime = Date.now();

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const client = interaction.client;
  const guildCount = client.guilds.cache.size;
  const uptime = formatUptime(Date.now() - botStartTime);
  const mem = process.memoryUsage();
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const rssMB = (mem.rss / 1024 / 1024).toFixed(1);
  const ping = client.ws.ping;

  const lines = [
    `🤖 **Clankered Chuan** — Status`,
    ``,
    `⏱ **Uptime:** \`${uptime}\``,
    `🏠 **Servers:** \`${guildCount}\``,
    `📡 **WS Ping:** \`${ping}ms\``,
    `💾 **Memory:** \`${heapMB} MB heap / ${rssMB} MB RSS\``,
  ];

  await interaction.reply({ content: lines.join("\n"), ephemeral: true });
}
