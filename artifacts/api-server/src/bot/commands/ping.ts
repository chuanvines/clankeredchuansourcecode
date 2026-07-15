import { Message } from "discord.js";

/**
 * &ping — replies with the bot's websocket + roundtrip latency.
 */
export async function runPing(message: Message): Promise<void> {
  const sent = Date.now();
  const reply = await message.reply("🏓 Pong...");
  const roundtrip = Date.now() - sent;
  const wsPing = message.client.ws.ping;
  await reply.edit(`🏓 Pong! Roundtrip: \`${roundtrip}ms\` · WS: \`${wsPing < 0 ? "n/a" : `${wsPing}ms`}\``);
}
