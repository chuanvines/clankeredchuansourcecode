import aiohttp
import aiofiles
import os
import tempfile


async def download_video(url: str, dest_dir: str) -> str:
    filename = os.path.join(dest_dir, "input.mp4")
    async with aiohttp.ClientSession() as session:
        async with session.get(url) as resp:
            resp.raise_for_status()
            async with aiofiles.open(filename, "wb") as f:
                async for chunk in resp.content.iter_chunked(1024 * 64):
                    await f.write(chunk)
    return filename
