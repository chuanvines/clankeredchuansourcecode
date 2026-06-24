import { REST, Routes } from "discord.js";
import { data as ihtxCommand } from "./commands/ihtx.js";
import { data as catboxCommand } from "./commands/catboxupload.js";
import { data as effectsGifCommand } from "./commands/effectsgif.js";
import { data as statusCommand } from "./commands/status.js";
import { data as googleSearchImageCommand } from "./commands/googlesearchimage.js";
import { data as canvasCommand } from "./commands/canvas.js";
import { logger } from "./lib/logger.js";

export async function registerCommands(): Promise<void> {
  const token = process.env["BOT_TOKEN"] ?? process.env["DISCORD_TOKEN"];
  const clientId = process.env["CLIENT_ID"] ?? process.env["DISCORD_CLIENT_ID"];

  if (!token || !clientId) {
    logger.warn("Missing BOT_TOKEN or CLIENT_ID — skipping command registration");
    return;
  }

  const rest = new REST().setToken(token);
  const commands = [ihtxCommand.toJSON(), catboxCommand.toJSON(), effectsGifCommand.toJSON(), statusCommand.toJSON(), googleSearchImageCommand.toJSON(), canvasCommand.toJSON()];

  try {
    logger.info("Registering global slash commands");
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Registration timed out after 15s")), 15_000)
    );
    await Promise.race([
      rest.put(Routes.applicationCommands(clientId), { body: commands }),
      timeout,
    ]);
    logger.info("Global slash commands registered");
  } catch (err) {
    logger.error({ err }, "Failed to register slash commands");
  }
}
