import aiohttp
import os


CATBOX_URL = "https://catbox.moe/user/api.php"


async def upload_to_catbox(file_path: str) -> str:
    userhash = os.environ.get("CATBOX_USERHASH", "")
    async with aiohttp.ClientSession() as session:
        with open(file_path, "rb") as f:
            form = aiohttp.FormData()
            form.add_field("reqtype", "fileupload")
            form.add_field("userhash", userhash)
            form.add_field(
                "fileToUpload",
                f,
                filename=os.path.basename(file_path),
                content_type="video/mp4",
            )
            async with session.post(CATBOX_URL, data=form) as resp:
                resp.raise_for_status()
                return await resp.text()
