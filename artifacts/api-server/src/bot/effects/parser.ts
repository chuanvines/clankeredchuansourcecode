export type ParsedEffect = {
  name: string;
  param: string | null;
  subparams: string[];
};

export type ParsedCommand = {
  effects: ParsedEffect[];
  rep: number;
  dur: number | null;
};

export function parseEffectsString(raw: string): ParsedEffect[] {
  const effects: ParsedEffect[] = [];
  const parts = splitRespectingParens(raw);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // name(content) syntax — content may contain commas freely
    const parenStart = trimmed.indexOf("(");
    if (parenStart !== -1 && trimmed.endsWith(")")) {
      const name = trimmed.slice(0, parenStart).trim().toLowerCase();
      const rawParam = trimmed.slice(parenStart + 1, -1).trim();
      effects.push({ name, param: rawParam || null, subparams: rawParam ? [rawParam] : [] });
      continue;
    }

    // name=value syntax — subparams split by ;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) {
      effects.push({ name: trimmed.toLowerCase(), param: null, subparams: [] });
    } else {
      const name = trimmed.slice(0, eqIdx).trim().toLowerCase();
      const rawParam = trimmed.slice(eqIdx + 1).trim();
      const subparams = rawParam.split(";").map((s) => s.trim());
      effects.push({ name, param: subparams[0] ?? null, subparams });
    }
  }
  return effects;
}

function splitRespectingParens(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}
