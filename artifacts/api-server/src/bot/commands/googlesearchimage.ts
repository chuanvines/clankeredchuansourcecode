import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  ButtonInteraction,
} from "discord.js";
import { interactionError } from "../lib/embeds.js";
import axios from "axios";
import { logger } from "../lib/logger.js";

export const data = new SlashCommandBuilder()
  .setName("googlesearchimage")
  .setDescription("Search Google Images and browse results")
  .addStringOption((o) =>
    o.setName("query").setDescription("Search query").setRequired(true)
  )
  .addIntegerOption((o) =>
    o.setName("page").setDescription("Starting page (default 1)").setMinValue(1).setMaxValue(100)
  );

const API_URL = "https://www.googleapis.com/customsearch/v1";
const PAGE_SIZE = 10; // Google CSE fixed page size

interface SearchResult {
  title: string;
  link: string;
  displayLink: string;
  image?: { contextLink: string };
}

interface SearchSession {
  query: string;
  page: number;         // current 1-based page
  results: SearchResult[];
  shuffled: boolean;
}

// In-memory session store keyed by interactionId
const sessions = new Map<string, SearchSession>();

async function fetchPage(query: string, page: number): Promise<SearchResult[]> {
  const apiKey = process.env["GOOGLE_API_KEY"];
  const cseId  = process.env["GOOGLE_CSE_ID"];
  if (!apiKey || !cseId) throw new Error("GOOGLE_API_KEY or GOOGLE_CSE_ID not configured");

  const start = (page - 1) * PAGE_SIZE + 1; // 1-based start index
  try {
    const res = await axios.get<{ items?: SearchResult[] }>(API_URL, {
      params: { key: apiKey, cx: cseId, q: query, searchType: "image", num: PAGE_SIZE, start },
      timeout: 10_000,
    });
    return res.data.items ?? [];
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response) {
      const status = err.response.status;
      const data = err.response.data as { error?: { message?: string; status?: string } } | undefined;
      const msg = data?.error?.message ?? JSON.stringify(data).slice(0, 200);
      throw new Error(`Google API ${status}: ${msg}`);
    }
    throw err;
  }
}

function buildEmbed(session: SearchSession): EmbedBuilder {
  const result = session.results[0];
  const embed = new EmbedBuilder()
    .setTitle(result?.title ?? "No results")
    .setURL(result?.image?.contextLink ?? result?.link ?? "")
    .setImage(result?.link ?? null)
    .setFooter({ text: `Page ${session.page} • Result 1/${session.results.length}${session.shuffled ? " • 🔀 Shuffled" : ""} • ${session.query}` })
    .setColor(0x4285f4);
  return embed;
}

function buildRow(hasResults: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("gsi_prev").setLabel("◀ Previous").setStyle(ButtonStyle.Secondary).setDisabled(!hasResults),
    new ButtonBuilder().setCustomId("gsi_next").setLabel("Next ▶").setStyle(ButtonStyle.Primary).setDisabled(!hasResults),
    new ButtonBuilder().setCustomId("gsi_shuffle").setLabel("🔀 Shuffle").setStyle(ButtonStyle.Success).setDisabled(!hasResults),
  );
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const query = interaction.options.getString("query", true);
  const startPage = interaction.options.getInteger("page") ?? 1;

  await interaction.deferReply();

  let results: SearchResult[] = [];
  try {
    results = await fetchPage(query, startPage);
  } catch (err) {
    logger.error({ err }, "Google Image Search failed");
    const msg = err instanceof Error ? err.message : String(err);
    await interactionError(interaction, `Search failed: \`${msg.slice(0, 300)}\``);
    return;
  }

  if (results.length === 0) {
    await interactionError(interaction, `No image results found for **${query}**`);
    return;
  }

  const session: SearchSession = { query, page: startPage, results, shuffled: false };
  const sessionId = interaction.id;
  sessions.set(sessionId, session);

  const reply = await interaction.editReply({
    embeds: [buildEmbed(session)],
    components: [buildRow(true)],
  });

  // Collector — listen for button presses for 5 minutes
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.user.id === interaction.user.id,
    time: 5 * 60 * 1000,
  });

  collector.on("collect", async (btn: ButtonInteraction) => {
    const s = sessions.get(sessionId);
    if (!s) { await btn.reply({ content: "Session expired.", ephemeral: true }); return; }

    await btn.deferUpdate();

    try {
      if (btn.customId === "gsi_next") {
        s.page += 1;
        s.results = await fetchPage(s.query, s.page);
        s.shuffled = false;
        if (s.results.length === 0) {
          s.page -= 1; // revert
          s.results = await fetchPage(s.query, s.page);
        }
      } else if (btn.customId === "gsi_prev") {
        if (s.page > 1) {
          s.page -= 1;
          s.results = await fetchPage(s.query, s.page);
          s.shuffled = false;
        }
      } else if (btn.customId === "gsi_shuffle") {
        // Re-fetch same page but shuffle the order
        const fresh = await fetchPage(s.query, s.page);
        s.results = fresh.sort(() => Math.random() - 0.5);
        s.shuffled = true;
      }

      await btn.editReply({
        embeds: [buildEmbed(s)],
        components: [buildRow(s.results.length > 0)],
      });
    } catch (err) {
      logger.error({ err }, "Google Image Search button handler failed");
      const msg = err instanceof Error ? err.message : String(err);
      await btn.followUp({ embeds: [{ color: 0xfee75c, description: `⚠️ **Command Error**\nError: \`${msg.slice(0, 200)}\`` }], ephemeral: true });
    }
  });

  collector.on("end", () => {
    sessions.delete(sessionId);
    interaction.editReply({ components: [] }).catch(() => {});
  });
}
