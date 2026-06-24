import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";

export const DEFAULT_ROWS = 10;
export const DEFAULT_COLS = 12;
export const DEFAULT_CHAR = " ";
export const CELL_WIDTH = 5;
export const MAX_ROWS = 20;
export const MAX_COLS = 20;

export function buildCanvasMessage(rows: number, cols: number, char: string = DEFAULT_CHAR): string {
  const clampedRows = Math.min(Math.max(1, rows), MAX_ROWS);
  const clampedCols = Math.min(Math.max(1, cols), MAX_COLS);
  const fill = char.slice(0, 1) || DEFAULT_CHAR;
  const cell = `||${fill.repeat(CELL_WIDTH)}||`;
  const row = Array(clampedCols).fill(cell).join("");
  return Array(clampedRows).fill(row).join("\n");
}

export const CANVAS_MESSAGE = buildCanvasMessage(DEFAULT_ROWS, DEFAULT_COLS, DEFAULT_CHAR);

export const data = new SlashCommandBuilder()
  .setName("canvas")
  .setDescription("Send the canvas spoiler grid")
  .addIntegerOption((opt) =>
    opt
      .setName("rows")
      .setDescription(`Number of rows (1–${MAX_ROWS}, default ${DEFAULT_ROWS})`)
      .setMinValue(1)
      .setMaxValue(MAX_ROWS)
      .setRequired(false),
  )
  .addIntegerOption((opt) =>
    opt
      .setName("cols")
      .setDescription(`Number of columns (1–${MAX_COLS}, default ${DEFAULT_COLS})`)
      .setMinValue(1)
      .setMaxValue(MAX_COLS)
      .setRequired(false),
  )
  .addStringOption((opt) =>
    opt
      .setName("char")
      .setDescription(`Character to fill each cell (default: space). One character only.`)
      .setMinLength(1)
      .setMaxLength(1)
      .setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const rows = interaction.options.getInteger("rows") ?? DEFAULT_ROWS;
  const cols = interaction.options.getInteger("cols") ?? DEFAULT_COLS;
  const char = interaction.options.getString("char") ?? DEFAULT_CHAR;
  await interaction.reply({ content: buildCanvasMessage(rows, cols, char) });
}
