# Tagscript, Imagescript & Mediascript Documentation

Complete reference for the tag scripting systems available in the Discord bot's `&tag` command.

---

## Table of Contents

1. [Tagscript Engine](#1-tagscript-engine)
2. [Imagescript (`{imagescript:}`)](#2-imagescript-imagescript)
3. [Mediascript (`{mediascript:}`)](#3-mediascript-mediascript)
4. [ihtx Effect Reference](#4-ihtx-effect-reference)
   - [Audio Effects](#41-audio-effects)
   - [Flip & Mirror](#42-flip--mirror)
   - [Color Effects](#43-color-effects)
   - [Geometry & Transform](#44-geometry--transform)
   - [Distortion Effects](#45-distortion-effects)
   - [Projection & 3D Effects](#46-projection--3d-effects)
   - [Overlay & Texture](#47-overlay--texture)
   - [Special & Complex Effects](#48-special--complex-effects)

---

## 1. Tagscript Engine

Tags are written in `{tag:content}` format. All tags are expanded iteratively (innermost first). Block-style `{if:}` is resolved before code blocks execute.

### 1.1 Input & Variables

| Tag | Description |
|---|---|
| `{iv}` / `{av}` | URL of the attached file (attachment → reply → channel history fallback) |
| `{iv1}`, `{iv2}`, … | Numbered media URLs (1-indexed) from the current message and its reply |
| `{args}` | All arguments joined by spaces |
| `{argslen}` | Number of arguments passed |
| `{arg:N}` | Argument at index N (0-based). `{arg:0\|default}` for fallback |
| `{arg:*}` | All args joined by spaces. `{arg:*\|,}` joins with a custom separator |
| `{arg:N+}` | Arguments from index N to end, joined by spaces |
| `{set:name\|value}` | Store a value in a local variable (no output) |
| `{get:name}` | Retrieve a stored variable |

### 1.2 Logic & Control Flow

| Tag | Description |
|---|---|
| `{if:cond}…{/if}` | Block conditional. Evaluates `cond` as a math expression |
| `{if:cond}…{elif:cond}…{else}…{/if}` | Multi-branch conditional |
| `{foreach:N\|template}` | Repeat `template` exactly N times (max 500) |

Conditions use the [math sandbox](#math-sandbox) — any truthy non-zero value is true.

### 1.3 Text Manipulation

| Tag | Description |
|---|---|
| `{upper:text}` | Uppercase |
| `{lower:text}` | Lowercase |
| `{len:text}` | Character count |
| `{replace:text\|find\|repl}` | Replace first occurrence of `find` with `repl` |
| `{substring:text\|start\|end}` | Substring by character index |
| `{indexof:text\|search}` | Index of `search` in `text` (-1 if not found) |

### 1.4 Random / Selection

| Tag | Description |
|---|---|
| `{choose:a\|b\|c}` | Pick a random option from the pipe-delimited list |
| `{or:a\|b}` | Return `a` if non-empty, otherwise `b` |
| `{range:min\|max}` | Random integer between min and max (inclusive) |

### 1.5 Math

```
{math:expr}
```

Evaluates a math expression in a safe sandbox. Supports standard operators plus:

| Symbol | Meaning |
|---|---|
| `^` | Exponentiation (alias for `**`) |
| `pi`, `PI`, `tau`, `e`, `phi` | Constants |
| `log(x)` | log₁₀; `ln(x)` = natural log; `log2(x)` |
| `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2` | Trig |
| `csc`, `sec`, `cot`, `acsc`, `asec`, `acot` | Reciprocal/inverse trig |
| `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh` | Hyperbolic |
| `csch`, `sech`, `coth` | Reciprocal hyperbolic |
| `gcd(a,b)`, `lcm(a,b)`, `mod(a,b)` | Integer helpers |
| `abs`, `sqrt`, `cbrt`, `pow`, `exp`, `sign` | Basics |
| `floor`, `ceil`, `round`, `min`, `max` | Rounding |

### 1.6 Code Execution Tags

These tags execute code and can return text or media files.

| Tag | Description |
|---|---|
| `{sh:...}` | Bash shell script. Write files to `output/` dir to return media. Use `load <url>` line to download URLs into `$FILE_1`, `$FILE_2`, … |
| `{py:...}` | Python 3 script. Save any image/video to cwd to return it as attachment |
| `{js:...}` | Node.js JavaScript |
| `{ts:...}` | TypeScript (compiled via tsx) |
| `{ihtx:effects}` | Apply [ihtx effects](#4-ihtx-effect-reference) to `{iv}` media |
| `{ihtxffmpeg:...}` | Raw ffmpeg filter complex applied to `{iv}` |
| `{imagescript:...}` / `{iscript:...}` | [Imagescript](#2-imagescript-imagescript) line-based media scripting |
| `{mediascript:...}` | [Mediascript](#3-mediascript-mediascript) ImageMagick-based scripting |
| `{attach:url}` | Download a URL and post it as a file attachment |
| `{runcodetxt:...}` | Run code fetched from a text file URL |
| `{veb:url}` | VEB effect on a media URL |
| `{tag:name}` | Inline-expand another tag by name |

### 1.7 `{sh:}` Special Syntax

Inside `{sh:}` blocks, a `load <url>` line (before any other commands) downloads a URL to a temp file and exposes it as `$FILE_1`, `$FILE_2`, etc.

```sh
{sh:
load https://example.com/video.mp4
ffmpeg -y -i $FILE_1 -vf hflip output/out.mp4
}
```

### 1.8 Math Sandbox (Variable `vd`)

In effect parameters within `{ihtx:}` and related tags, `vd` is replaced by the actual video duration in seconds before processing. Example: `hue=360*t/vd` rotates hue one full cycle over the video length.

---

## 2. Imagescript (`{imagescript:}`)

Aliases: `{iscript:}`. A line-based scripting language that applies [ihtx effects](#4-ihtx-effect-reference) to media variables.

### Syntax

```
load <url> <varname>
<effect>[=<p>;<p>] <var> [<numparams...>] [<dest>]
```

Lines starting with `//` or `#` are comments. `{iv}` resolves to the attached media URL and can be used as the URL for `load`.

### Commands

| Command | Description |
|---|---|
| `load <url> <var>` | Download URL into a variable (default var name: `i`) |
| `copy <src> <dst>` | Copy variable to a new name without processing |
| `join <var1> <var2> [dest]` | Stack two media horizontally (hstack). Output stored in `dest` (default: `var1`) |
| `concatmultiple <v1> <v2> ...` | Concatenate multiple media clips. All audio → `.mp3`; mixed → `.mp4` |
| `slide <var> [speed]` | Horizontally scroll. `speed` = fraction of width/frame (default `0.05`). Positive = right-to-left |
| `pitch <var> <s1> [s2...]` | Multi-pitch overlay. Each `sN` is semitones |
| `audiopitch <var> <factor>` | Pitch shift (factor, e.g. `2**(-1/12)` = 1 semitone down) |
| `volume <var> <amount>` | Adjust volume (1 = unchanged) |
| `vibrato <var> <freq> [depth]` | Vibrato effect |
| `audiodestroy <var>` | Extreme audio distortion (11× acontrast=100) |
| `speed <var> <rate>` | Playback speed (e.g. `2` = 2× faster) |
| `4ormulator=<dial> <var>` | Formant shift via rubberband |

### Applying ihtx Effects

Any [ihtx effect name](#4-ihtx-effect-reference) can be used directly as a command:

```
# Apply a single effect
hflip i

# Effect with parameter using =
hueshifthsv=180 i

# Effect with numeric params as positional args (become semicolons internally)
hueshifthsv i 180 0 0
```

If the effect name already contains `=`, the next token after the var is the destination variable:

```
hflip=1 i dest
```

### Imagescript Example

```
load {iv} i
load {iv2} i2
hflip i
join i i2 result
hueshifthsv=90 result
pitch result 7
```

---

## 3. Mediascript (`{mediascript:}`)

An ImageMagick-based line scripting language for frame-level media manipulation. Supports images, GIFs, and videos (≤ 2 minutes).

### Variables

Variables are named by you with `load`. Videos are automatically extracted into frames for per-frame processing. GIFs are stored as GIF files (applied directly via `-coalesce`). Variable dimensions are accessible in numeric expressions as `<varname>w` and `<varname>h` (e.g. `i2w`, `imageh`).

### Commands

#### Data Management

| Command | Description |
|---|---|
| `load <url> <var>` | Download URL into variable. Detects image/gif/video/audio automatically. Videos > 2 min are rejected. Audio files (`.mp3`, `.wav`, `.ogg`, `.flac`, `.aac`, `.m4a`, `.opus`) are normalised to mp3 and stored as an audio variable. Use with `audioputreplace` to swap audio onto a video/gif |
| `render <var>` | Output variable as the final attachment (implicit if omitted) |
| `copy <src> <dst>` | Duplicate a variable (deep copy of frames/audio) |

#### Composition

| Command | Description |
|---|---|
| `create <var> <w> <h> <r> <g> <b>` | Create a new solid-colour image. `w`/`h` are pixel dimensions; `r`/`g`/`b` are 0–255 colour components. Supports numeric expressions (e.g. `iw`, `(512/2)`) |
| `tti <var> <font_size> <wrap_width> <color> <text...>` | Render text to a transparent-background PNG using Arial. `wrap_width=0` = auto-width (no wrapping). `color` is any ImageMagick colour name or hex (`black`, `#ff0000`, etc.). Text may contain spaces |
| `overlay <base> <top> [x_pos] [y_pos] [opacity]` | Composite `top` onto `base`. Without `x_pos`/`y_pos` top is centred (default). With both, top is placed at that pixel offset from the top-left (`NorthWest` gravity). `opacity` is 0–1 (default `1`). Handles all type combinations (image/gif/video). Audio is mixed when both have audio tracks |
| `join <var1> <var2> [vertical]` | Stack two variables side-by-side (`vertical=false`, default) or top-to-bottom (`vertical=true`). Inputs are auto-scaled to match height (hstack) or width (vstack). Output stored in `var1`. Audio carried from `var1` if present |

#### ImageMagick Effects
*(work on image, gif, video)*

| Command | Description |
|---|---|
| `invert <var>` | Negate colors |
| `flip <var>` | Vertical flip |
| `flop <var>` | Horizontal flip |
| `swirl <var> <degrees>` | Swirl distortion (e.g. `swirl image 50`) |
| `explode <var> <n>` | Outward fisheye push (`-implode -n`) |
| `implode <var> <n>` | Inward fisheye pull (`-implode n`) |
| `magik <var>` | Content-aware liquid rescale to 50% |
| `demagik <var>` | Content-aware liquid rescale to 300%, then resize to 30% — repeated 2 times |
| `hueshifthsv <var> <h> <s> <l>` | Hue/saturation/lightness via `-modulate`. Values are offsets from 0 |
| `swaprgba <var> <pattern>` | Swap RGB channels. Pattern is 3 chars of `r`/`g`/`b`/`0` (e.g. `bgr`, `rrg`, `r00`) |
| `rotate <var> <angle>` | Rotate by degrees (black background fill) |
| `wave <var> <amplitude> <wavelength>` | Wave distortion (default: 10×64) |
| `resize <var> <w> <h>` | Resize to exact pixel dimensions. Supports expressions: `i2w`, `(i2w/2)` |
| `cover <var> <w> <h>` | Resize+center-crop to fill exact dimensions |
| `distort polar <var>` | Polar distortion (wrap into a disk) |
| `distort depolar <var>` | De-polar distortion (unroll disk to rectangle) |
| `contrast <var> <strength>` | Contrast adjustment via ffmpeg `eq=contrast` |

#### Video/GIF Commands

| Command | Description |
|---|---|
| `snip <var> <start> [end]` | Trim to time range in seconds. `end` defaults to clip end |
| `convert <var> <format>` | Convert format: `gif`, `mp4`, `png`, `jpg`, `webp` |
| `speed <var> <factor>` | Change playback speed. `>1` = faster, `<1` = slower (GIF frame delay; audio tempo via rubberband) |
| `volume <var> <factor>` | Adjust audio volume (requires audio track) |
| `mute <var>` | Remove audio track |
| `audioputreplace <var> <var2>` | Replace the audio of `var` with the audio from `var2`. Accepts audio, gif, or video variables as source. Extracts from srcVideo if needed. Errors if `var2` has no audio track |
| `reverse <var>` | Reverse frames and audio |
| `audiopitch <var> <factor>` | Pitch shift. Factor is a multiplier: `2**(-1/12)` = one semitone down |
| `slide <var> <speed>` | Horizontal scroll. Positive = right-to-left. Speed = fraction of width per frame |
| `spin <var> [speed] [crop]` | Continuous rotation via `rotate=PI*t*speed`. `speed` multiplies rotation rate (default `1` = one full rotation per 2 s). `crop` = `true` (default) keeps original canvas size; `false` expands canvas to fit the full rotated frame (no corner clipping) |

### Mediascript Example

```
load {iv} image
snip image 0 10
explode image 1
hueshifthsv image -130 0 0
overlay image image
render image
```

```
load {iv} vid
load {iv2} logo
convert vid gif
speed vid 2
overlay vid logo
render vid
```

---

## 4. ihtx Effect Reference

Used by `{ihtx:effects}`, imagescript, and the `&ihtx` / `&canvas` commands.

**Effect string syntax:**
```
effectname                        # no parameter
effectname=value                  # one parameter
effectname=p1;p2;p3              # multiple semicolon-separated subparams
effectname(value)                 # parenthesis syntax (ignores commas inside)
effect1,effect2,effect3           # chain multiple effects
```

---

### 4.1 Audio Effects

| Effect | Parameters | Description |
|---|---|---|
| `pitch` | `=<semitones>[;<semitones>…]` | Multi-pitch overlay via rubberband. Each value is semitones (e.g. `pitch=7` = perfect 5th up). Prefix `i` for inharmonic mode: `pitch=i;7` (adds ±0.12 st detune for chorus texture) |
| `audiopitch` | `=<subparams>` | Alias for `pitch` |
| `volume` | `=<factor>` | Volume multiplier. `2` = double, `0.5` = half |
| `vibrato` | `=<freq>[;<depth>]` | Vibrato modulation. Default freq=5 Hz, depth=0.5 |
| `audiovibrato` | `=<freq>[;<depth>]` | Alias for `vibrato` |
| `acontrast` | `=<0-100>` | Audio contrast. Default 33 |
| `adestroy` | *(none)* | 5× `acontrast=100` — strong clipping/distortion |
| `audiodestroy` | *(none)* | 11× `acontrast=100` — extreme destruction |
| `areverse` | *(none)* | Reverse audio stream |
| `vreverse` | *(none)* | Reverse video frames |
| `4ormulator` | `=<dial>` | Formant shift via rubberband. Default dial=712923000. Use large values for strong effect |
| `audioequalizer` | `=<subbass>;<bass>;<lowmids>;<mids>;<highmids>` | 5-band parametric EQ in dB. Bands at 40, 150, 375, 1000, 3000 Hz |
| `autotune` | `=<url>` | Pitch-shift audio to match carrier from URL or YouTube link |
| `avflip` | *(none)* | Experimental FFT frequency-domain flip (extreme pitch artifact effect) |
| `speed` | `=<factor>` | Playback speed (0.25–16). Adjusts video PTS and audio tempo |

---

### 4.2 Flip & Mirror

| Effect | Parameters | Description |
|---|---|---|
| `hflip` / `flop` | *(none)* | Horizontal flip |
| `vflip` / `flip` | *(none)* | Vertical flip |
| `haah` | *(none)* | Mirror: left half + its horizontal reflection → fills frame |
| `waaw` | *(none)* | Mirror: right half + its horizontal reflection |
| `hooh` | *(none)* | Mirror: top half + its vertical reflection |
| `woow` | *(none)* | Mirror: bottom half + its vertical reflection |
| `copy` | *(none)* | Duplicate side-by-side (hstack) |
| `vcopy` | *(none)* | Duplicate stacked vertically |
| `quad` | *(none)* | 2×2 grid of four copies |
| `leftsplit` | `=<effects>` | Apply `effects` to the left half only (default: `hflip`) |
| `rightsplit` | `=<effects>` | Apply `effects` to the right half only (default: `hflip`) |

---

### 4.3 Color Effects

| Effect | Parameters | Description |
|---|---|---|
| `invert` | *(none)* | Negate all colors |
| `invlum` | *(none)* | Invert luminosity only (built-in LUT) |
| `invertrgb` | `=<r>;<g>;<b>` | Selectively invert channels. `1` = invert, `0` = keep (e.g. `invertrgb=1;0;0` = invert red only) |
| `grayscale` | *(none)* | Remove saturation |
| `sepia` | *(none)* | Sepia tone |
| `hue` | `=<degrees>` | Hue rotate — YUV-accurate chroma rotation |
| `huehsv` / `hueshifthsv` | `=<degrees>` | Hue rotate — ImageMagick HSV modulate method |
| `ffmpeghue` | `=<degrees>` | Raw ffmpeg `hue=h=` filter |
| `brightness` | `=<value>` | Brightness offset (-1 to 1). Default 0.1 |
| `contrast` | `=<value>` | Contrast multiplier. Default 1.5 |
| `saturation` | `=<value>` | Saturation multiplier. Default 1.5 |
| `channelblend` | `=<srcR>;<srcG>;<srcB>` | Route channel source. Each is `r`, `g`, or `b` (e.g. `channelblend=b;g;r` = swap R↔B) |
| `swapuv` | *(none)* | Swap U and V chroma channels |
| `swaprgba` | `=<order>` | Reorder RGB channels (e.g. `swaprgba=bgr`, `swaprgba=rrg`) |
| `deepfry` | `=<intensity>` | Deep-fry: oversaturated, over-sharpened. Default 1 |
| `kek` | `=<saturation>` | Aggressive green/yellow color grade. Default sat=3.5 |
| `exo` | *(none)* | Sobel edge detection blended over original (screen mode) |
| `gm4` | *(none)* | Selective color — boost whites and blacks |
| `realgm4` | *(none)* | Curves inversion (all=0/0 0.5/1 1/0) |
| `gradientmap` | `=<JSON>` | Map luminance to a color gradient. JSON: `[[r,g,b,a],[r,g,b,a]]` with ≥ 2 stops |
| `lut` | `=<url>` | Apply a `.cube` LUT file from URL |
| `watermark` | `=<url>` | Overlay an image (scale-matched, looped) |
| `ring` | `[=<url>]` | Ring-style watermark overlay (default: built-in catbox ring image) |
| `miui` | *(none)* | MIUI watermark overlay |
| `reddit` | *(none)* | Reddit watermark overlay |
| `solarize` | `=<0-255>` | Invert pixels above threshold. Default 128 |
| `threshold` | `=<0-255>` | Binary black/white at threshold. Default 128 |
| `posterize` | `=<levels>` | Reduce to N color levels (2–64). Default 4 |
| `rainbow` | `=<speed>` | Animated hue cycle. `speed` = degrees/second. Default 30 |
| `🥸🥸` | *(none)* | Hue shift by π radians |
| `﷽` | *(none)* | Equirectangular → ball → fisheye |
| `𒐫` | *(none)* | Ball → hammer projection |

---

### 4.4 Geometry & Transform

| Effect | Parameters | Description |
|---|---|---|
| `rotate` | `=<degrees>` | Rotate. Output canvas expands to avoid clipping |
| `zoom` | `=<factor>` | Zoom into center. `2` = 2× zoom (crops edges). Default 2 |
| `mirror` | `=<angle>[;<cx>;<cy>]` | Fold image along an angled axis. `cx`/`cy` = fold center (0–1). Default angle=90 (vertical fold) |
| `tile` | `=<tx>[;<ty>]` | Tile the image `tx`×`ty` times. Default 2×2 |
| `stretch` | `=<w>[;<h>]` | Scale to dimensions. Supports ffmpeg expressions: `iw*2`, `ih/2`. Default `iw*2:ih` |
| `transpose` | `=<0-7>` | ffmpeg transpose modes (0=CCW+flip, 1=CW, 2=CCW, 3=CW+flip, …) |
| `pan` | `=<x>;<y>` | Pixel offset (static crop shift) |
| `slide` | `=<speed>` | Continuous horizontal scroll (fraction of width per frame). Default 0.5 |
| `spin` | `=<speed>` | Continuous rotation. `speed` multiplies radians/second |
| `caption` | `=<text>` | Burn text caption at top of frame (white with black border) |
| `timecode` | *(none)* | Burn-in SMPTE timecode overlay (bottom-right) |

---

### 4.5 Distortion Effects

| Effect | Parameters | Description |
|---|---|---|
| `swirl` | `=<angle>[;<cx>;<cy>;<r>]` | Swirl distortion. `angle` in degrees, `cx`/`cy` = center (0–1), `r` = radius fraction. Default 90° |
| `wave` | `=<xw>;<yw>;<xa>;<ya>[;<xphase>;<yphase>;<speed>]` | Sinusoidal wave displacement. `xw`/`yw` = frequency, `xa`/`ya` = amplitude (pixels×10), `speed` = animation speed |
| `ripple` | `=<speed>;<freq>;<amplitude>;<phase>` | Radial ripple from center. Default 1;30;10;0 |
| `fisheye` | `=<s>[;<cx>;<cy>;<r>]` | Fisheye/bulge lens. `s` = strength, `cx`/`cy` = center (0–1), `r` = radius fraction |
| `explode` | `=<n>` | Gaussian outward push from center. Default 1 |
| `implode` | `=<n>` | Gaussian inward pull toward center. Default 1 |
| `distort` | `=<k>` | Barrel (`k<0`) or pincushion (`k>0`) distortion. Default -0.5 |
| `wiggle` | `=<strength>` | Animated sinusoidal pixel displacement. Default 5 |
| `scroll` | `=<h>[;<v>]` | Continuous scroll (0–1 per axis). Also supports animated pan: `scroll=x1;y1;x2;y2;dur` |
| `depolar` | *(none)* | Polar → rectangular (unroll a disk into a strip) |
| `polar` | *(none)* | Rectangular → polar (roll a strip into a disk) |
| `shakeh` | `=<pixels>` | Pseudo-random horizontal jitter per frame. Default 5 |
| `shakev` | `=<pixels>` | Pseudo-random vertical jitter per frame. Default 5 |
| `shake` | `=<pixels>` | Combined horizontal + vertical jitter. Default 5 |
| `gm91deform` | *(none)* | Perspective + barrel deformation at 640×360 |

---

### 4.6 Projection & 3D Effects

| Effect | Parameters | Description |
|---|---|---|
| `vebfisheye` | `[=<count>]` | Equirectangular → ball projection (v360). Apply `count` times |
| `vebdefisheye` | `[=<count>]` | Ball → equirectangular |
| `vebfisheye2` | `[=<count>]` | Equirectangular → hammer |
| `vebdefisheye2` | `[=<count>]` | Hammer → equirectangular |
| `vebfisheye3` | `[=<count>]` | Fisheye 22:7 projection |
| `vebdefisheye3` | `[=<count>]` | Inverse fisheye 22:7 |
| `tunnel` | *(none)* | Equirectangular → cylinder-LR |
| `detunnel` | *(none)* | Cylinder-LR → equirectangular |
| `orb` | *(none)* | Equirectangular → fisheye with horizontal scroll (horizontal orbit) |
| `orb2` | *(none)* | Same as `orb` but vertical scroll |
| `orb3` | *(none)* | Same as `orb` but diagonal scroll |
| `deorb` | *(none)* | Inverse of `orb` |
| `deorb2` / `deorb3` | *(none)* | Inverse of `orb2` / `orb3` |
| `sphere` | *(none)* | Spinning `orb` (rotation + scroll) |
| `desphere` | *(none)* | Inverse `sphere` |

---

### 4.7 Overlay & Texture

| Effect | Parameters | Description |
|---|---|---|
| `blur` | `=<radius>` | Box blur. Radius in pixels. Default 5 |
| `sharpen` | `=<strength>` | Unsharp mask (0.1–10). Default 1.5 |
| `emboss` | `=<strength>` | Emboss convolution. Default 1 |
| `edge` | `=<lo>[;<hi>]` | Canny edge detection. Values 0–255. Default 50;150 |
| `sobel` | *(none)* | Sobel edge filter |
| `prewitt` | *(none)* | Prewitt edge filter |
| `noise` | `=<strength>` | Random per-pixel noise (1–200). Default 25 |
| `pixelate` | `=<blocksize>` | Pixelation. Block size in pixels. Default 16 |
| `dither` | *(none)* | 8-bit RGB palette dither |
| `bloom` | `=<radius>` | Glow/bloom — blurred bright overlay (screen blend). Default 10 |
| `scanlines` | `=<gap>` | CRT scanlines. Dark line every `gap` pixels. Default 4 |
| `vhs` | *(none)* | VHS analog look: RGB chroma offset + noise + saturation |
| `glitch` | `=<pixels>` | RGB channel horizontal offset (chromatic aberration). Default 10 |
| `chromashift` | *(none)* | Automatic chroma channel shift with desaturation |
| `vignette` | `=<strength>` | Radial vignette darkening. Default 1 |
| `rays` | `=<steps>` | Light rays radiating from center (screen blend). Default 4, max 20 |
| `cartoon` | `=<triLevel>[;<threshold>]` | Frei0r cartoon shader. Default 0.11;0.20 |
| `distort0r` | `=<amount>[;<tilt>]` | Frei0r distort0r. Default 0.2;0.5 |
| `nervous` | *(none)* | Frei0r nervous: randomly substitutes past frames (glitch) |

---

### 4.8 Special & Complex Effects

| Effect | Parameters | Description |
|---|---|---|
| `radar` | *(none)* | Composite waveform + histogram + vectorscope overlay (4-panel) |
| `tvsim` | `=<linesync>[;<zoomgrill>]` | TV simulation using an external displacement map. `linesync` 0–1 = contrast of the horizontal sync artifact. `zoomgrill` = crop of displacement map |
| `lsc` | `=<text>[;<url>]` | Left-split comparison: first half + thumbnail overlay of `{iv}`, second half + thumbnail, with a text label. `url` = optional separate main video |
| `leftsplit` | `=<effects>` | Apply inner effects to left half only, then reassemble (default inner: `hflip`) |
| `rightsplit` | `=<effects>` | Apply inner effects to right half only (default inner: `hflip`) |
| `sierpinskiransomware` | *(none)* | 2×2 split-screen with different speeds (1×, 2×+negate, 4/3×+negate, 0.5×) |
| `nbfxearthquake` | *(none)* | Apply vidstab motion data from a preloaded earthquake source video |
| `wmm3dripple` | *(none)* | 3D radial ripple effect (scales to 640×640, applies geq ripple, restores dimensions) |
| `ffmpeg` | `=<raw args>` or `=<vf-filter>` | Raw ffmpeg pass-through. If starts with `-`: parse `-vf` and `-filter_complex` flags; otherwise treat subparams as direct vf filter strings |

---

## Effect Chaining Examples

```
# Flip + hue shift + bloom
{ihtx:hflip,huehsv=180,bloom=15}

# Pitch up 7 semitones with vibrato
{ihtx:pitch=7,vibrato=6;0.7}

# VHS look with scanlines
{ihtx:vhs,scanlines=3}

# Spiral spin with rainbow
{ihtx:spin=2,rainbow=60}

# Imagescript: load two images and stack with effects
{imagescript:
load {iv} a
load {iv2} b
hflip a
hueshifthsv=90 b
join a b result
}

# Mediascript: trim video and apply IM effects
{mediascript:
load {iv} v
snip v 0 8
swirl v 90
hueshifthsv v -60 20 0
render v
}
```
