# TagScript Documentation

TagScript is the templating/scripting language used by `&tag`. Scripts are stored per-tag and executed when the tag is invoked. Tags are invoked with `&<tagname> [args...]`.

---

## Tag Management Commands

| Command | Description |
|---|---|
| `&tag add <name> <script>` | Create or update a tag (owner or mod can overwrite) |
| `&tag del <name>` | Delete a tag (owner or server mod only) |
| `&tag forceremove <name>` | Delete any tag regardless of owner (bot owner only) |
| `&tag alias <newname> <srcname>` | Create an alias that calls another tag |
| `&tag list [page]` | List all tags (paginated, 10 per page) |
| `&tag search <query>` | Search tag names by substring |
| `&tag info <name>` | Show tag details (owner, dates, script) |
| `&tag random` | Invoke a random tag |
| `&tag help` | Show help |

Tags are stored globally. Reserved names: `add`, `del`, `delete`, `remove`, `forceremove`, `list`, `info`, `help`, `random`, `search`, `alias`.

---

## Variable Tags

### `{iv}` / `{av}` — Attached Media URL

Resolves to the URL of the attached/referenced media file.

**Resolution order:**
1. Attachment on the invoking message
2. Embed (video > image > thumbnail) on the invoking message
3. Attachment on the replied-to message
4. Embed on the replied-to message
5. Last attachment or embed found in the past 50 messages in the channel

`{av}` is an alias for `{iv}`.

**Multiple attachments:** `{iv1}`, `{iv2}`, `{iv3}` … access the Nth attachment (1-indexed). `{iv}` and `{iv1}` are the same.

**Error:** If `{iv}` or `{iv1}` cannot resolve, the tag returns an error message instead of executing.

---

### `{args}` — All Arguments

Replaced with the full raw argument string passed after the tag name.

```
&tag add greet Hello {args}!
&greet world       → Hello world!
```

### `{arg:N}` — Positional Argument

Replaced with the Nth argument (0-indexed). Supports a pipe fallback if the argument is missing.

```
{arg:0}            → first argument, or empty string
{arg:0|default}    → first argument, or "default" if missing
{arg:*}            → all arguments joined by space (same as {args})
{arg:*|,}          → all arguments joined by ","
{arg:1+}           → all arguments from index 1 onward joined by space
```

### `{argslen}` — Argument Count

Replaced with the number of arguments passed.

```
{argslen}          → "3" if 3 words were passed
```

---

## Math

### `{math:expression}`

Evaluates a math expression and replaces itself with the result. Uses a sandboxed VM with a rich math library.

```
{math:2+2}             → 4
{math:sqrt(144)}       → 12
{math:2^10}            → 1024   (^ is exponentiation)
{math:sin(pi/2)}       → 1
{math:log(1000)}       → 3      (log = log₁₀)
{math:ln(e)}           → 1      (ln = natural log)
{math:gcd(48,18)}      → 6
{math:lcm(4,6)}        → 12
```

**Available constants:** `e`, `pi`/`PI`, `tau`, `phi`

**Available functions:** `abs`, `sqrt`, `cbrt`, `pow`, `exp`, `sign`, `floor`, `ceil`, `round`, `min`, `max`, `log` (log₁₀), `log2`, `ln`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `csc`, `sec`, `cot`, `acsc`, `asec`, `acot`, `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`, `csch`, `sech`, `coth`, `gcd`, `lcm`, `mod`

---

## Variables

### `{set:varname|value}`

Store a value in a named variable. Produces no output.

```
{set:x|hello}
```

### `{get:varname}`

Retrieve a variable previously set with `{set:...}`.

```
{set:x|42}{get:x}    → 42
```

---

## Conditionals

### Inline `{if:...}` (single-line)

**Syntax 1 — truthy check:**
```
{if:condition|thenValue|elseValue}
```
Evaluates `condition` as a math expression; if truthy (non-zero, non-empty, not "false"), returns `thenValue`, otherwise `elseValue`.

```
{if:{arg:0}|Got an arg|No arg given}
{if:{math:{arg:0}>5}|big|small}
```

**Syntax 2 — comparison:**
```
{if:A|op|B|then:thenValue|else:elseValue}
{if:|VALUE|TARGET|then:thenValue|else:elseValue}
```

Operators: `=` / `==`, `!=` / `!==`, `>`, `<`, `>=`, `<=`

```
{if:{arg:0}|=|hello|then:hi|else:bye}
{if:|{arg:0}|hello|then:hi|else:bye}
```

### Block `{if:...}...{/if}` (multi-line)

```
{if:condition}
  ...content if true...
{elif:condition2}
  ...content if condition2 true...
{else}
  ...fallback content...
{/if}
```

Conditions are math expressions. Nested `{if:}...{/if}` blocks are supported. Tags inside branches are evaluated lazily (false branches never execute).

```
{if:{argslen}>0}
  Hello, {arg:0}!
{else}
  Hello, stranger!
{/if}
```

---

## String Operations

### `{upper:text}` / `{lower:text}`
Convert to upper or lower case.

```
{upper:hello}    → HELLO
{lower:WORLD}    → world
```

### `{len:text}`
Returns the character length of `text`.

```
{len:hello}      → 5
```

### `{replace:find|replacement|source}`
Replace every occurrence of `find` in `source` with `replacement`.

```
{replace:o|0|foobar}    → f00bar
```

### `{substring:source|start|end}`
Extract a substring (0-indexed, `end` is exclusive and optional).

```
{substring:hello|1|3}    → el
{substring:hello|2}      → llo
```

### `{indexof:needle|haystack}`
Returns the 0-based index of `needle` in `haystack`, or `-1` if not found.

```
{indexof:l|hello}    → 2
```

---

## Randomness

### `{choose:option1|option2|option3}`
Pick one option at random.

```
{choose:heads|tails}
{choose:red|green|blue}
```

### `{range:min|max}`
Return a random number between `min` and `max` (inclusive for integers, 4 decimal places for floats).

```
{range:1|6}         → random integer 1–6
{range:0.0|1.0}     → random float like 0.4271
```

### `{or:value|fallback}`
Return `value` if it is non-empty (after trimming), otherwise `fallback`.

```
{or:{arg:0}|nothing provided}
```

---

## Repetition & Iteration

### `{repeat:N:text}`
Repeat `text` exactly N times (max 500).

```
{repeat:3:ha}    → hahaha
```

### `{foreach:template|item1|item2|...}`
For each item, substitute `@` in `template` with the item. Joined by newline by default.

```
{foreach:- @|apple|banana|cherry}
→
- apple
- banana
- cherry
```

**Custom separator:** Prefix the template with `sep~` where `sep` is the join string. Use `\n` for newline, `\t` for tab.

```
{foreach:, ~@|a|b|c}    → a, b, c
```

### `{foreach:N|template}`
Repeat `template` exactly N times (max 500). Used for count-based loops. Tags inside `template` are processed each iteration.

```
{foreach:3|{choose:a|b|c}}    → three random picks
```

---

## Sub-tag & External Script

### `{tag:tagname}`
Invoke another saved tag inline. Arguments and attached media from the current invocation are forwarded.

```
{tag:myothertag}
```

### `{runcodetxt:url}`
Fetch a plain-text file from `url` and run it as a TagScript. The result (text or media) is returned. Arguments and attached media are forwarded.

```
{runcodetxt:https://example.com/myscript.txt}
```

---

## Media Attachment

### `{attach:url}`
Download the file at `url` and send it as a Discord attachment. Replaces itself with nothing (the file is the output).

```
{attach:https://example.com/image.png}
```

---

## Code Execution Tags

All code tags time out after **10 seconds** (shell/python/JS: 60 seconds for the subprocess itself). stdout/stderr is captured and returned as message text.

### `{js:code}`
Run JavaScript (Node.js ESM module). Use `console.log()` to produce output.

Attached media files are available as environment variables `$FILE_1`, `$FILE_2`, … downloaded to temp paths before execution.

```
{js:console.log(2 + 2)}    → 4
{js:
const x = [1,2,3];
console.log(x.map(n => n * n).join(', '));
}
```

### `{ts:code}`
Same as `{js:...}` but runs as TypeScript via a bundled runner.

### `{py:code}`
Run Python 3. Use `print()` to produce output. Any image/media file saved in the working directory (`.png`, `.jpg`, `.gif`, `.mp4`, `.webm`, `.pdf`) is sent as an attachment.

`MPLBACKEND=Agg` is set automatically (headless matplotlib).

Attached media files available as `$FILE_1`, `$FILE_2`, …

```
{py:
import math
print(math.factorial(10))
}
```

```
{py:
import matplotlib.pyplot as plt
plt.plot([1,2,3],[1,4,9])
plt.savefig("graph.png")
}
```

### `{sh:code}`
Run a bash script. Attached media files are auto-downloaded as `$FILE_1`, `$FILE_2`, …

Any file saved to the `output/` subdirectory is returned as a Discord attachment. stdout alongside an output file is sent as accompanying text.

**Special syntax inside the script:**
```
load <url>
```
Downloads `url` to a temp file and sets the next `$FILE_N` variable.

```
{sh:
ffmpeg -y -i "$FILE_1" -vf "hflip" output/flipped.mp4
}
```

---

## Video Effect Tags

### `{ihtx:effects|rep|dur}`

Apply the bot's built-in `&ihtx` effect pipeline to the attached media file.

| Parameter | Description |
|---|---|
| `effects` | Effect string (same syntax as `&ihtx`) |
| `rep` | Number of times to apply (1–200, default 1) |
| `dur` | Trim duration in seconds (optional) |

Requires an attachment on the message or a reply with an attachment.

```
{ihtx:reverse}
{ihtx:speed=0.5|3}
{ihtx:hue=90|1|5}
```

### `{ihtxffmpeg:powers|dur|ffmpegflags}`

Apply raw ffmpeg filter flags to the attached media, stack `powers` copies concatenated together.

| Parameter | Description |
|---|---|
| `powers` | Number of copies to generate and concat (1–50) |
| `dur` | Duration per copy in seconds, or `vidlen` to use original length |
| `ffmpegflags` | Raw ffmpeg arguments (filters, mappings, etc.) |

Inside `ffmpegflags`, shell variables probed from the input are available:
- `$sr` — sample rate
- `$fr` — frame rate
- `$d` — duration
- `$w` / `$h` — width / height
- `$fc` — frame count

```
{ihtxffmpeg:4|vidlen|-vf "hflip"}
{ihtxffmpeg:2|5|-vf "eq=saturation=2"}
```

### `{veb:effectstring}`

Apply VideoEdit Python effects (`videoEdit.py`) to the attached media.

```
{veb:reverse}
```

---

## Imagescript (`{imagescript:...}` / `{iscript:...}`)

A line-based media scripting mini-language for chaining effects across multiple files.

Comments start with `//` or `#`. Lines are whitespace-trimmed.

### Variables

Variables hold media (URL or processed buffer). Default variable name is `i`. You can use any name.

### Commands

#### `load <url> <varname>`
Download a URL into a variable. Use `{iv}` as the URL to load the attached video.

```
load {iv} i
load https://example.com/img.png bg
```

#### `copy <src> <dest>`
Copy a variable to another name without re-processing.

```
copy i backup
```

#### `join <var1> <var2> [dest]`
Stack `var1` and `var2` side-by-side (hstack). Result is stored in `dest` (defaults to `var1`). Works with images and videos.

```
join i backup result
```

#### `concatmultiple <var1> <var2> [var3 ...]`
Concatenate two or more media variables sequentially. All are normalized to MP4 first. Result is stored back in `var1`.

- Images → converted to 3-second video clip
- Audio-only → placed on a black video frame
- Videos/GIFs without audio → silence is added

```
concatmultiple a b c
```

#### `pitch <var> <semitones> [semitones2 ...]`
Apply pitch shifting. Multiple semitone values create a multipitch overlay.

```
pitch i 3
pitch i 3 0 -3
```

#### `volume <var> <amount>`
Adjust audio volume (e.g. `2` = double, `0.5` = half).

```
volume i 1.5
```

#### `vibrato <var> <freq> [depth]`
Apply vibrato audio effect. `freq` in Hz, `depth` 0–1.

```
vibrato i 5 0.8
```

#### `speed <var> <rate>`
Change playback speed (e.g. `2` = 2× faster, `0.5` = half speed).

```
speed i 2
```

#### `<effect>[=<p1>;<p2>] <var> [numparams...] [dest]`
Apply any `&ihtx` effect by name. Parameters can be passed:
- After `=` in the effect name: `hueshifthsv=180`
- As trailing numeric tokens on the line: `hueshifthsv i 180`
- First non-numeric trailing token is treated as the destination variable name.

```
hueshifthsv i 180
reverse i
speed=2 i
blur=5 i blurred
```

### Full Imagescript Example

```
load {iv} i
load https://example.com/other.mp4 j
pitch i 3
speed i 1.5
join i j result
```

---

## Evaluation Order

1. `{iv}`/`{av}`/`{ivN}` are resolved upfront (and again each loop if introduced by substitution).
2. `{args}` / `{argslen}` are resolved.
3. Each loop iteration:
   a. Re-resolve `{iv}`/`{av}`/`{ivN}` if present.
   b. Expand `{foreach:N|template}` count blocks.
   c. Expand block `{if:...}...{/if}` (only when condition contains no unresolved braces).
   d. Resolve the innermost `{tag:...}` (INNERMOST_TAG_RE — content must have no nested braces).
   e. If nothing matched, extract and run the first code block tag (`sh`, `js`, `ts`, `py`, `ihtxffmpeg`, `imagescript`, `iscript`, `runcodetxt`, `attach`) using balanced-brace matching (supports inner `{}`).
4. Loop ends when no changes occur, or after 500 iterations.

This ordering ensures that substitution tags like `{arg:0}` inside `{if:...}` conditions are always resolved before the condition is evaluated.

---

## Limits & Notes

| Item | Limit |
|---|---|
| Max iterations per script | 500 |
| Max `{repeat:N:...}` / `{foreach:N\|...}` | 500 |
| Max `{ihtx:...\|rep\|...}` rep | 200 |
| Max `{ihtxffmpeg:powers\|...\|...}` | 50 |
| Subprocess stdout cap | 512 KB |
| Code tag timeout | 10 s (inner subprocess: 60 s) |
| Math expression timeout | 2 s |
| Condition eval timeout | 500 ms |
