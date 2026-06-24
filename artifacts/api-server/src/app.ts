import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use("/api", router);

app.get("/", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ihtx effects bot</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0f0f23;
      font-family: 'Segoe UI', system-ui, sans-serif;
      color: #e8e8f0;
    }
    .card {
      text-align: center;
      padding: 3rem 4rem;
      background: #1a1a35;
      border-radius: 1.5rem;
      border: 1px solid #3d3d7a;
      box-shadow: 0 0 60px rgba(88, 101, 242, 0.15);
      max-width: 520px;
    }
    .dot {
      display: inline-block;
      width: 12px; height: 12px;
      background: #23d160;
      border-radius: 50%;
      margin-right: 8px;
      box-shadow: 0 0 8px #23d160;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.4; }
    }
    .status {
      font-size: 1.05rem;
      color: #23d160;
      font-weight: 600;
      margin-bottom: 1.5rem;
    }
    h1 {
      font-size: 1.9rem;
      font-weight: 700;
      color: #fff;
      margin-bottom: 0.6rem;
    }
    h1 span { color: #5865f2; }
    p {
      font-size: 0.95rem;
      color: #9898b8;
      line-height: 1.6;
      margin-top: 1rem;
    }
    code {
      background: #2a2a4a;
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 0.88rem;
      color: #c3c3e8;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="status"><span class="dot"></span>Bot is Running!</div>
    <h1>ihtx <span>effects</span> bot</h1>
    <p>Use <code>&amp;ihtx &lt;effects&gt;</code> in Discord to apply FFmpeg-based image, video, and audio effects.</p>
    <p style="margin-top:0.6rem">Leave effects blank for a random shuffle!</p>
  </div>
</body>
</html>`);
});

export default app;
