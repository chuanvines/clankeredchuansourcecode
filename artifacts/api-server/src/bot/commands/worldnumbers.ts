import { createCanvas } from "@napi-rs/canvas";
import { parse } from "mathjs";
import { logger } from "../lib/logger.js";

const GRID_SIZE  = 33;
const COUNT      = GRID_SIZE * GRID_SIZE;
const CELL       = 24;
const PAD        = 1;
const IMG_SIZE   = GRID_SIZE * CELL;

const BG_COLOR   = "#111111";
const DOT_COLOR  = "#2d2d2d";
const HIT_COLOR  = "#cc1f1f";
const TEXT_COLOR = "#ffffff";
const FONT_SIZE  = 10;

type Coord = { col: number; row: number };

function buildSpiral(): Coord[] {
  const coords: Coord[] = new Array(COUNT);
  const cx = Math.floor(GRID_SIZE / 2);
  const cy = Math.floor(GRID_SIZE / 2);
  let x = 0, y = 0;
  let dx = 1, dy = 0;
  let steps = 1, stepCount = 0, dirChanges = 0;

  for (let n = 1; n <= COUNT; n++) {
    coords[n - 1] = { col: cx + x, row: cy + y };
    x += dx;
    y += dy;
    stepCount++;
    if (stepCount === steps) {
      stepCount = 0;
      const ndx = -dy;
      dy = dx;
      dx = ndx;
      dirChanges++;
      if (dirChanges % 2 === 0) steps++;
    }
  }
  return coords;
}

const SPIRAL = buildSpiral();

function checkPrime(n: number): boolean {
  if (n < 2) return false;
  if (n === 2) return true;
  if (n % 2 === 0) return false;
  for (let i = 3; i <= Math.sqrt(n); i += 2) {
    if (n % i === 0) return false;
  }
  return true;
}

function nthPrime(n: number): number {
  const idx = Math.round(n);
  if (!isFinite(idx) || idx < 1) return NaN;
  let count = 0;
  let num = 1;
  while (count < idx) {
    num++;
    if (checkPrime(num)) count++;
    if (num > 100_000) return NaN;
  }
  return num;
}

const CUSTOM_SCOPE: Record<string, unknown> = {
  prime: nthPrime,
};

function buildHitSet(expr: string): Set<number> {
  let compiled: { evaluate: (scope: Record<string, unknown>) => number };
  try {
    compiled = parse(expr).compile();
  } catch {
    throw new Error(`Could not parse expression: \`${expr}\``);
  }

  const hits = new Set<number>();
  const maxX = Math.ceil(Math.sqrt(COUNT)) * 4;

  for (let x = 0; x <= maxX; x++) {
    let val: number;
    try {
      val = compiled.evaluate({ ...CUSTOM_SCOPE, x });
    } catch {
      continue;
    }
    if (typeof val !== "number" || !isFinite(val)) continue;
    const rounded = Math.round(val);
    if (Math.abs(val - rounded) < 1e-9 && rounded >= 1 && rounded <= COUNT) {
      hits.add(rounded);
    }
  }

  return hits;
}

export async function runWorldNumbers(expression: string): Promise<Buffer> {
  logger.info({ expression }, "Running &worldnumbers");

  const hits = buildHitSet(expression);
  if (hits.size === 0) {
    throw new Error("Expression produces no integer values in the display range (1–" + COUNT + ").");
  }

  const canvas = createCanvas(IMG_SIZE, IMG_SIZE);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, IMG_SIZE, IMG_SIZE);

  const radius = CELL / 2 - PAD;

  for (let n = 1; n <= COUNT; n++) {
    const { col, row } = SPIRAL[n - 1]!;
    const cx = col * CELL + CELL / 2;
    const cy = row * CELL + CELL / 2;
    const isHit = hits.has(n);

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = isHit ? HIT_COLOR : DOT_COLOR;
    ctx.fill();

    const label = String(n);
    const fontSize = label.length >= 4 ? FONT_SIZE - 2 : FONT_SIZE;
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = TEXT_COLOR;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, cx, cy);
  }

  return canvas.toBuffer("image/png");
}
