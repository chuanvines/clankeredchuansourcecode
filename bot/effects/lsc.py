import asyncio
import os
import subprocess
import tempfile

from bot.utils.download import download_video
from bot.utils.catbox import upload_to_catbox


async def _get_duration(file_path: str) -> float:
    proc = await asyncio.create_subprocess_exec(
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        file_path,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    return float(stdout.decode().strip())


async def apply_lsc(text: str, video_url: str) -> str:
    with tempfile.TemporaryDirectory() as tmpdir:
        input_file = await download_video(video_url, tmpdir)
        output_file = os.path.join(tmpdir, "output.mp4")

        duration = await _get_duration(input_file)
        half = duration / 2

        safe_text = text.replace("'", r"\'").replace(":", r"\:")

        filter_complex = (
            f"[0:v]split=4[v1][v2][v3][v4];"
            f"[0:a]asplit=4[a1][a2][a3][a4];"
            f"[v1]trim=0:{half},setpts=PTS-STARTPTS[ia];"
            f"[v2]setpts=PTS-STARTPTS,setpts=0.5*PTS,scale=iw/2:ih/2[ia2];"
            f"[v3]trim={half},setpts=PTS-STARTPTS[ib];"
            f"[v4]setpts=PTS-STARTPTS,setpts=0.5*PTS,scale=iw/2:ih/2[ib2];"
            f"[ia][ia2]overlay=0:0[part1];"
            f"[ib][ib2]overlay=W/2:H/2[part2];"
            f"[part1][part2]concat=n=2:v=1:a=0,"
            f"drawtext=text='{safe_text}':fontsize=50:fontcolor=white"
            f":box=1:boxcolor=black@0.5:boxborderw=10:x=(w-tw-10):y=10[vout];"
            f"[a1]atrim=0:{half},asetpts=PTS-STARTPTS,loudnorm[aa];"
            f"[a2]asetpts=PTS-STARTPTS,atempo=2.0[aa2];"
            f"[a3]atrim={half},asetpts=PTS-STARTPTS,loudnorm[ab];"
            f"[a4]asetpts=PTS-STARTPTS,atempo=2.0[ab2];"
            f"[aa][aa2]amix=inputs=2[aout1];"
            f"[ab][ab2]amix=inputs=2[aout2];"
            f"[aout1][aout2]concat=n=2:v=0:a=1[aout]"
        )

        cmd = [
            "ffmpeg", "-y",
            "-i", input_file,
            "-i", input_file,
            "-i", input_file,
            "-i", input_file,
            "-filter_complex", filter_complex,
            "-map", "[vout]",
            "-map", "[aout]",
            "-t", str(duration),
            output_file,
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()

        if proc.returncode != 0:
            raise RuntimeError(
                f"ffmpeg failed:\n{stderr.decode()[-2000:]}"
            )

        result_url = await upload_to_catbox(output_file)
        return result_url.strip()
