import { EmbedBuilder, Message, ChatInputCommandInteraction } from "discord.js";

/** Warning-yellow colour matching Discord's ⚠️ palette. */
const WARNING_COLOR = 0xfee75c;

/** Creates a ⚠️ Command Error embed. */
export function errorEmbed(text: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(WARNING_COLOR)
    .setDescription(`⚠️ **Command Error**\n${text}`);
}

/** Reply to a Message with a Command Error embed. */
export async function replyError(target: Message, text: string): Promise<void> {
  await target.reply({ embeds: [errorEmbed(text)] }).catch(() => {});
}

/**
 * Edit a status Message to show a Command Error embed, clearing any prior text.
 * Use this instead of statusMsg.edit({ content: "❌ ..." }).
 */
export async function editError(target: Message, text: string): Promise<void> {
  await target.edit({ content: "", embeds: [errorEmbed(text)] }).catch(() => {});
}

/** Edit a deferred slash-command interaction reply with a Command Error embed. */
export async function interactionError(
  interaction: ChatInputCommandInteraction,
  text: string,
): Promise<void> {
  await interaction
    .editReply({ content: "", embeds: [errorEmbed(text)] })
    .catch(() => {});
}
