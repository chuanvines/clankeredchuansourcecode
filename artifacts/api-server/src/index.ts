import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot/index";

// Prevent pino-pretty worker OOM (or any other worker crash) from killing the process.
// ERR_WORKER_OUT_OF_MEMORY is emitted as an unhandled 'error' on the Worker thread; if
// nothing catches it, Node throws it as an uncaughtException and exits.
process.on("uncaughtException", (err: Error) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ERR_WORKER_OUT_OF_MEMORY") {
    // pino-pretty worker ran out of heap; log via stderr directly and continue.
    process.stderr.write(`[logger] pino-pretty worker OOM — continuing without pretty logs\n`);
    return;
  }
  // For any other uncaught exception, re-emit so the default handler exits.
  process.stderr.write(`Uncaught exception: ${err.stack ?? err.message}\n`);
  process.exit(1);
});

// Prepend extra nix store bin paths that aren't automatically in PATH
const EXTRA_BINS = [
  "/nix/store/j5mjv5wnrxi761550gwjiwr671szvs9q-sox-unstable-2021-05-09/bin",
];
process.env["PATH"] = [...EXTRA_BINS, process.env["PATH"] ?? ""].join(":");

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

startBot().catch((err) => {
  logger.error({ err }, "Failed to start Discord bot");
});
