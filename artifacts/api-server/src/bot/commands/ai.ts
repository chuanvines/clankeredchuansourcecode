import Groq from "groq-sdk";
import { Message, AttachmentBuilder } from "discord.js";
import { logger } from "../lib/logger.js";
import { editError } from "../lib/embeds.js";
import { processTagscript } from "./tag.js";

const client = new Groq({
  apiKey: process.env["GROQ_API_KEY"],
});

const MODEL = "llama-3.3-70b-versatile";
const MAX_TOKENS = 8192;
const DISCORD_MAX = 1900;

const SYSTEM_PROMPT = `You are a knowledgeable assistant for the Clankered Chuan Discord bot — a bot that applies FFmpeg-based audio/video/image effects to media files and runs a powerful tagscript scripting engine.

## Bot Identity
- Name: Clankered Chuan (tag: Clankered Chuan#4679)
- Prefix: \`&ihtx\` for media effects, \`&tag\` / \`&t\` for tags, \`&ai\` for AI

---

## IMPORTANT: How to run vs show TagScript

When you want to EXECUTE TagScript code (actually run it and produce output/media):
- Wrap it in \`{process:YOUR_TAGSCRIPT_HERE}\`
- Example: \`{process:{ihtx:invert}}\` — this will actually apply the invert effect to attached media
- Only use this when the user explicitly asks you to run/apply/execute something

When you want to SHOW TagScript code as an example (without running it):
- Use a regular markdown code block: \`\`\`{ihtx:invert}\`\`\`
- This just displays the code, nothing gets executed

Never use \`{process:}\` for explanations or examples — only for actual execution the user requested.

---

## Core Commands

### &ihtx <effects> [rep] [dur]
Apply one or more chained effects to an attached or replied-to media file.
- Effects separated by commas: \`&ihtx invert,hflip,hue=90\`
- \`rep\` = repeat count (default 1, max 1000)
- \`dur\` = trim duration in seconds before processing
- Example: \`&ihtx wave=3;3;30;30;0;0;5,pitch=7 10 0.5\`

### &pitch <semitones>[;<semitones2>...]
Quick multipitch overlay shorthand.

### &vibrato [freq] [depth]
Quick vibrato shorthand.

### &sync
Video synchronization/processing command.

### &canvas [text] [rows] [cols] [char]
Generate text-based canvas art.

### &ai <prompt>
Ask the AI assistant (that's me!).

### &tag / &t — Tag System
Manage and run saved tagscript programs.
- \`&tag add <name> <script>\` — create or update a tag
- \`&tag del <name>\` — delete a tag (owner or mod only)
- \`&tag info <name>\` — show script, owner, timestamps
- \`&tag list [page]\` — list all tags (paginated)
- \`&tag search <query>\` — search tag names
- \`&tag help\` — show help file
- \`&tag <name> [arg0] [arg1] ...\` — run a tag
- \`&t <name> [args...]\` — shorthand alias

---

## Tagscript Engine

Tags contain a script with special \`{tag:content}\` blocks that get evaluated. Tags are nested and compose freely.

### Arguments
- \`{arg:0}\` — first argument (0-indexed)
- \`{arg:1}\` — second argument, etc.
- \`{arg:*}\` — all arguments as one string
- \`{args}\` — alias for \`{arg:*}\`
- \`{argslen}\` — number of arguments passed

### Variables
- \`{set:varname|value}\` — store a value
- \`{get:varname}\` — retrieve it
- Example: \`{set:x|5}{math:{get:x}*2}\` → 10

### Math
- \`{math:<expr>}\` — evaluate math expression
- Supports: \`+\`, \`-\`, \`*\`, \`/\`, \`^\`, \`%\`, \`sqrt\`, \`sin\`, \`cos\`, \`tan\`, \`log\`, \`ln\`, \`floor\`, \`ceil\`, \`round\`, \`abs\`, \`min\`, \`max\`, \`gcd\`, \`lcm\`, \`pi\`, \`e\`, \`tau\`, \`phi\`
- Example: \`{math:sqrt(2)^2}\` → 2

### JS Eval
- \`{eval:<js expression>}\` — safe JS VM expression
- Example: \`{eval:"hello".toUpperCase()}\` → HELLO

### Conditionals
- \`{if:a|op|b|then:x|else:y}\`
- Operators: \`=\`, \`!=\`, \`>\`, \`<\`, \`>=\`, \`<=\`
- Example: \`{if:{arg:0}|>|10|then:big|else:small}\`
- Block form: \`{if:cond}...{elif:cond}...{else}...{/if}\`

### String Utilities
- \`{upper:<text>}\` — uppercase
- \`{lower:<text>}\` — lowercase
- \`{len:<text>}\` — string length
- \`{substring:text|start}\` — substring from index
- \`{substring:text|start|end}\` — substring with end
- \`{indexof:needle|haystack}\` — char index (-1 if not found)
- \`{replace:old|new|text}\` — replace all occurrences

### Repetition & Loops
- \`{repeat:N:text}\` — repeat text N times (e.g. \`{repeat:3:ha}\` → hahaha)
- \`{range:min|max}\` — random integer; use decimals for float (e.g. \`{range:0.0|1.0}\`)
- \`{foreach:N|template}\` — repeat template N times
- \`{foreach:template|item1|item2|item3}\` — iterate over items; \`@\` = current item
  - Custom separator: \`{foreach:,~pitch=@|0|3|7}\` → \`pitch=0,pitch=3,pitch=7\`
- Example counter: \`{set:#|0}{foreach:3|{set:#|{math:{get:#}+1}}{get:#}}\` → 123

### Media Tags
- \`{iv}\` — URL of the attached or replied-to media file
- \`{attach:<url>}\` — download URL and send as Discord file attachment
- \`{ihtx:<effects>|<rep>|<dur>}\` — apply ihtx effects to attached/replied media inline in a tag
- \`{ihtxffmpeg:<powers>|<duration>|<ffmpeg args>}\` — exponential effect escalation

### Code Execution Tags
- \`{js:<code>}\` — run Node.js code, returns stdout
- \`{py:<code>}\` — run Python 3 code, returns stdout
- \`{sh:<script>}\` — run bash script; special \`load <url>\` downloads to \`$FILE_1\`, \`$FILE_2\`...; write output files to \`./output/\` to get them attached
  - Example: \`{sh:\\nload {iv}\\nffmpeg -i "$FILE_1" -vf negate output/out.mp4\\n}\`

### Imagescript (\`{imagescript:...}\` or \`{iscript:...}\`)
Line-based media scripting language for complex multi-step media manipulation:
- \`load <url> <var>\` — download URL into variable (use \`{iv}\` for attached media)
- \`copy <var> <dest>\` — copy variable
- \`join <var1> <var2> [dest]\` — hstack two variables side by side
- \`concatmultiple <var1> <var2> ...\` — concat multiple clips
- \`<effect>[=<p>] <var> [dest]\` — apply any &ihtx effect
- \`pitch <var> <s1> [s2 ...]\` — multipitch overlay
- \`audiopitch <var> <s1> [s2 ...]\` — alias for pitch
- \`speed <var> <rate>\` — change playback speed
- \`volume <var> <amount>\` — adjust volume
- \`vibrato <var> <freq> [depth]\` — vibrato effect
- \`audiodestroy <var>\` — extreme audio distortion

---

## &ihtx Effects Reference (partial)

### Audio
- \`pitch=<semitones>[;<s2>;...]\` — pitch shift (multipitch overlay)
- \`volume=<factor>\` — volume multiplier
- \`vibrato=<freq>[;<depth>]\` — vibrato
- \`acontrast=<amount>\` — audio contrast
- \`adestroy\` / \`audiodestroy\` — extreme distortion
- \`areverse\` — reverse audio
- \`autotune=<scale>\` — autotune
- \`4ormulator=<dial>\` — formant shift

### Color
- \`invert\` / \`negate\` — invert colors
- \`grayscale\` — remove color
- \`sepia\` — sepia tone
- \`hue=<degrees>\` — hue rotation
- \`huehsv=<degrees>\` — hue rotation (HSV)
- \`brightness=<val>\` — brightness
- \`contrast=<val>\` — contrast
- \`saturation=<val>\` — saturation

### Geometry / Distortion
- \`fisheye=<strength>\` — fisheye
- \`swirl=<angle>\` — swirl
- \`wave=<ax>;<ay>;<px>;<py>;<phx>;<phy>;<speed>\` — wave warp
- \`ripple=<ax>;<ay>;<px>;<py>;<phx>;<phy>;<speed>\` — ripple
- \`rotate=<angle>\` — rotate
- \`zoom=<factor>\` — zoom
- \`tile=<cols>;<rows>\` — tile
- \`polar\` / \`depolar\` — polar warp
- \`sphere\` / \`desphere\` — sphere projection
- \`orb\` / \`deorb\` / \`orb2\` / \`deorb2\` / \`orb3\` / \`deorb3\`
- \`mirror=<angle>\` — mirror fold
- \`scroll=<xspeed>;<yspeed>\` — scroll

### frei0r Plugins
- \`cartoon=<triLevel>;<threshold>\` — cartoon effect (defaults 0.11;0.20)
- \`distort0r=<amount>;<tilt>\` — frei0r lens warp (defaults 0.2;0.5)
- \`nervous\` — random frame-swap glitch

### Motion / FX
- \`spin=<speed>\` — spinning
- \`wiggle=<amount>\` — shake/wiggle
- \`blur=<amount>\` — gaussian blur
- \`vignette=<amount>\` — vignette
- \`tvsim\` — TV signal simulation

### Raw FFmpeg
- \`ffmpeg=<filter_complex_string>\` — inject raw FFmpeg filtergraph (advanced)

---

## Tips for Writing Tags

1. **Use \`{arg:*}\` for pass-through**: \`&tag add myeffect {ihtx:{arg:*}}\`
2. **Math in params**: \`{ihtx:wave={arg:0};{arg:1};{math:{arg:0}*2}}\`
3. **Set variables for reuse**: \`{set:n|{arg:0}}{ihtx:pitch={get:n};{math:{get:n}+7}}\`
4. **Shell for custom FFmpeg**: wrap in \`{sh:...}\` with \`load {iv}\` and write to \`./output/\`
5. **Imagescript for multi-step**: use \`{imagescript:}\` when processing multiple clips
6. **{ihtxffmpeg} for escalation**: great for exponential effect videos

---

Always be specific with parameter syntax, show examples, and help users debug their tagscripts. When asked to write a tag, provide the full \`&tag add <name> <script>\` command ready to paste.
Remember: use \`{process:CODE}\` only when the user wants to actually execute something. Use markdown code blocks for all examples.`;

/**
 * Extract all {process:...} blocks from the AI response using balanced-brace parsing.
 * Returns the list of code strings and the response text with {process:...} blocks removed.
 */
function extractProcessBlocks(text: string): { codes: string[]; stripped: string } {
  const codes: string[] = [];
  let stripped = "";
  let i = 0;

  while (i < text.length) {
    if (text.startsWith("{process:", i)) {
      let depth = 1;
      let j = i + "{process:".length;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      // content is between "{process:" and the final matched "}"
      const code = text.slice(i + "{process:".length, j - 1);
      codes.push(code);
      // Don't append this block to stripped
      i = j;
    } else {
      stripped += text[i];
      i++;
    }
  }

  return { codes, stripped: stripped.trim() };
}

async function sendChunked(
  text: string,
  editMsg: Message,
  replyMsg: Message,
): Promise<void> {
  if (text.length <= DISCORD_MAX) {
    await editMsg.edit(text);
    return;
  }
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += DISCORD_MAX) {
    chunks.push(text.slice(i, i + DISCORD_MAX));
  }
  await editMsg.edit(chunks[0]!);
  for (const chunk of chunks.slice(1)) await replyMsg.reply(chunk);
}

export async function runAi(message: Message): Promise<void> {
  const raw = message.content.trim();
  let prompt = raw.slice("&ai".length).trim();

  // Detect and strip -debug flag (anywhere in prompt)
  const debugMode = /\s-debug\b/.test(prompt) || prompt.endsWith("-debug");
  prompt = prompt.replace(/\s*-debug\b/g, "").trim();

  if (!prompt) {
    await message.reply("Usage: `&ai <your question or prompt>`\nAdd `-debug` to receive the raw AI response as a text file.");
    return;
  }

  const statusMsg = await message.reply("⏳ Thinking…");

  try {
    logger.info({ prompt: prompt.slice(0, 100), debugMode }, "Running &ai command");

    const response = await client.chat.completions.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    });

    const rawText = response.choices[0]?.message?.content ?? "(no response)";

    // -debug: send raw AI response as a .txt file and stop
    if (debugMode) {
      const file = new AttachmentBuilder(Buffer.from(rawText, "utf-8"), {
        name: "ai_response.txt",
      });
      await statusMsg.edit({ content: "📄 Raw AI response:", files: [file] });
      return;
    }

    const { codes, stripped } = extractProcessBlocks(rawText);

    if (codes.length === 0) {
      // No {process:} blocks — show AI text as-is
      await sendChunked(rawText, statusMsg, message);
      return;
    }

    // Show the non-process part of the AI response first (if any)
    if (stripped) {
      await sendChunked(stripped, statusMsg, message);
    } else {
      await statusMsg.edit("⏳ Running tagscript…");
    }

    // Execute each {process:...} block in order
    for (const code of codes) {
      logger.info({ code: code.slice(0, 100) }, "AI executing {process:} block");

      const execMsg = stripped
        ? await message.reply("⏳ Running tagscript…")
        : statusMsg;

      try {
        const tsResult = await processTagscript(code, [], message);

        if (typeof tsResult === "string") {
          const out = tsResult || "(no output)";
          await sendChunked(out, execMsg, message);
        } else {
          const file = new AttachmentBuilder(tsResult.buffer, {
            name: `ai_result${tsResult.ext}`,
          });
          const caption =
            tsResult.type === "combined" ? tsResult.text.slice(0, DISCORD_MAX) : "";
          await execMsg.edit({ content: caption || null, files: [file] });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await editError(execMsg, `Tagscript error: \`${msg.slice(0, 300)}\``);
      }
    }
  } catch (err) {
    logger.error({ err }, "&ai command failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    await editError(statusMsg, `AI error: \`${msg.slice(0, 300)}\``);
  }
}
