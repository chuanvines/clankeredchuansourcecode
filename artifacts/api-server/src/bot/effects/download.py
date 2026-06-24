import os
import subprocess
from urllib.request import urlopen, Request
from urllib.parse import urlparse

_YTDLP_HOSTS = ("youtube.com", "youtu.be", "music.youtube.com", "yt.be")

_DL_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    )
}

def download(outputPath, url, skip=None, delay=None, duration=None, video=True):
    if not url:
        return False

    def _apply_delay(path):
        if not delay:
            return
        tmp = path + ".delay_tmp.mp3"
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
             "-i", path, "-af", f"adelay={int(float(delay) * 1000)}:all=1", tmp],
            check=True
        )
        os.replace(tmp, path)

    def _is_valid_media(path):
        """True if the file exists, is non-empty, and ffprobe can open it.
        Defaults to True if ffprobe is unavailable or raises any error."""
        if not os.path.isfile(path) or os.path.getsize(path) == 0:
            return False
        try:
            r = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type",
                 "-of", "default=nw=1", "-i", path],
                capture_output=True, timeout=30
            )
            return r.returncode == 0
        except Exception:
            return True

    def _cleanup_partial():
        """Remove any leftover intermediate/partial files before a retry."""
        if not video:
            mp4_inter = outputPath.rsplit(".", 1)[0] + ".mp4"
            if os.path.isfile(mp4_inter):
                try:
                    os.remove(mp4_inter)
                except OSError:
                    pass
        if os.path.isfile(outputPath):
            try:
                os.remove(outputPath)
            except OSError:
                pass

    BASE_HEADERS_STR = (
        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    )

    def _ytdlp_cmd(extra_flags=None):
        cmd = ["yt-dlp", "--no-playlist", "-o", outputPath]
        if video:
            cmd += ["-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
                    "--merge-output-format", "mp4"]
        else:
            cmd += ["-x", "--audio-format", "mp3", "--audio-quality", "5"]
        if skip is not None:
            cmd += ["--download-sections", f"*{float(skip):.3f}-inf"]
        if duration is not None:
            cmd += ["--match-filter", f"duration <= {int(duration)}"]
        if extra_flags:
            cmd += extra_flags
        cmd.append(url)
        return cmd

    impersonate_flags = ["--impersonate", "chrome"]
    header_flags     = ["--add-headers", BASE_HEADERS_STR]

    for flags in [impersonate_flags, header_flags, []]:
        # Remove any partial files from the previous attempt before retrying
        _cleanup_partial()
        try:
            result = subprocess.run(_ytdlp_cmd(flags), capture_output=True, timeout=120)
            out_exists = (
                os.path.isfile(outputPath)
                or (video and os.path.isfile(outputPath.rsplit(".", 1)[0] + ".mp4"))
            )
            if result.returncode == 0 and out_exists:
                if video:
                    mp4_path = outputPath.rsplit(".", 1)[0] + ".mp4"
                    if os.path.isfile(mp4_path) and mp4_path != outputPath:
                        os.replace(mp4_path, outputPath)
                if not _is_valid_media(outputPath):
                    continue
                _apply_delay(outputPath)
                return True
        except FileNotFoundError:
            break
        except Exception:
            continue

    # urlretrieve fallback: skip YouTube URLs — they always return HTML, not media
    parsed = urlparse(url)
    is_yt = any(parsed.netloc.endswith(h) for h in _YTDLP_HOSTS)
    if is_yt:
        return False

    tmp_raw = outputPath + ".raw_tmp"
    try:
        if parsed.scheme in ("http", "https"):
            # Use a browser-like User-Agent so CDN hosts (Discord etc.) don't block us
            req = Request(url, headers=_DL_HEADERS)
            with urlopen(req, timeout=120) as resp:
                data = resp.read()
            with open(tmp_raw, "wb") as f:
                f.write(data)

            start_args = ["-ss", str(float(skip))] if skip is not None else []
            dur_args   = ["-t", str(int(duration))] if duration is not None else []
            if video:
                subprocess.run(
                    ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
                    + start_args + ["-i", tmp_raw] + dur_args
                    + ["-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", outputPath],
                    check=True
                )
            else:
                subprocess.run(
                    ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
                    + start_args + ["-i", tmp_raw] + dur_args
                    + ["-vn", "-acodec", "libmp3lame", "-q:a", "5", outputPath],
                    check=True
                )
            if _is_valid_media(outputPath):
                _apply_delay(outputPath)
                return True
    except Exception:
        pass
    finally:
        # Always clean up the raw temp file so stale HTML never confuses FFmpeg
        if os.path.isfile(tmp_raw):
            try:
                os.remove(tmp_raw)
            except OSError:
                pass

    return False
