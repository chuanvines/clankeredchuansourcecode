from PIL import Image, ImageDraw, ImageFont

def _blank(w, h):
    return Image.new("RGBA", (w, h), (0, 0, 0, 0))

def normalcaption(w, h, cap="", resourceDir=".."):
    img = _blank(w, max(40, h // 6))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w, img.height], fill="white")
    try:
        font = ImageFont.truetype(f"{resourceDir}/fonts/impact.ttf", size=max(16, img.height - 8))
    except Exception:
        font = ImageFont.load_default()
    d.text((w // 2, img.height // 2), str(cap), fill="black", font=font, anchor="mm")
    return img

def impact(w, h, toptext="", bottomtext="", resourceDir=".."):
    img = _blank(w, h)
    d = ImageDraw.Draw(img)
    fsize = max(16, w // 12)
    try:
        font = ImageFont.truetype(f"{resourceDir}/fonts/impact.ttf", size=fsize)
    except Exception:
        font = ImageFont.load_default()
    def draw_outlined(text, y):
        for ox, oy in [(-2,0),(2,0),(0,-2),(0,2)]:
            d.text((w//2+ox, y+oy), text, fill="black", font=font, anchor="mt")
        d.text((w//2, y), text, fill="white", font=font, anchor="mt")
    if toptext:
        draw_outlined(str(toptext), 4)
    if bottomtext:
        draw_outlined(str(bottomtext), h - fsize - 4)
    return img

def poster(w, h, cap="", bottomcap="", resourceDir=".."):
    pad = max(40, h // 6)
    img = _blank(w, h + pad * (1 + bool(bottomcap)))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w, pad], fill="white")
    try:
        font = ImageFont.truetype(f"{resourceDir}/fonts/impact.ttf", size=max(16, pad - 8))
    except Exception:
        font = ImageFont.load_default()
    d.text((w//2, pad//2), str(cap), fill="black", font=font, anchor="mm")
    return img

def cap(w, h, cap="", resourceDir=".."):
    return normalcaption(w, h, cap=cap, resourceDir=resourceDir)
