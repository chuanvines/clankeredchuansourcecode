/**
 * run-ts.mjs — reads TypeScript from stdin, transpiles with esbuild, executes.
 * Used by the {ts:...} tagscript tag.
 */
import { transformSync } from "esbuild";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const tsCode = readFileSync(0, "utf8");

let jsCode;
try {
  const result = transformSync(tsCode, {
    loader: "ts",
    format: "esm",
    target: "node18",
    logLevel: "silent",
  });
  jsCode = result.code;
} catch (err) {
  process.stderr.write(String(err.message ?? err));
  process.exit(1);
}

const tmp = join(tmpdir(), `ts_run_${Date.now()}_${Math.random().toString(36).slice(2)}.mjs`);
writeFileSync(tmp, jsCode);
try {
  const out = execFileSync("node", [tmp], {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["inherit", "pipe", "pipe"],
  });
  process.stdout.write(out);
} catch (err) {
  const stderr = err.stderr ? err.stderr.toString() : "";
  const stdout = err.stdout ? err.stdout.toString() : "";
  process.stderr.write(stderr || stdout || String(err.message ?? err));
  process.exit(1);
} finally {
  try { unlinkSync(tmp); } catch {}
}
