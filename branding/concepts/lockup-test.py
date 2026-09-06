#!/usr/bin/env python3
"""One weight vs two for the wordmark, on light and on dark."""
import subprocess
from PIL import Image, ImageDraw, ImageFont

CAP = 56
MARK_H = 96
OUT = "lockup-test.png"
F900 = "/tmp/bfonts/Nunito-900.ttf"
F600 = "/tmp/bfonts/Nunito-600.ttf"


def cap_h(f):
    b = f.getbbox("E")
    return b[3] - b[1]


def solve(path, target=CAP):
    lo, hi, best = 4, 400, 12
    while lo <= hi:
        m = (lo + hi) // 2
        h = cap_h(ImageFont.truetype(path, m))
        if h < target: best, lo = m, m + 1
        elif h > target: hi = m - 1
        else: return m
    return best


def mark(ink):
    src = "A-mark.svg"
    tmp = "/tmp/bfonts/_m.svg"
    open(tmp, "w").write(open(src).read().replace("color:#13171f", f"color:{ink}"))
    subprocess.run(["magick", "-background", "none", "-density", "900", tmp,
                    "-trim", "+repage", "-resize", f"x{MARK_H}", "/tmp/bfonts/_m.png"], check=True)
    return Image.open("/tmp/bfonts/_m.png").convert("RGBA")


def draw_runs(runs, ink):
    """runs: [(text, fontpath)] laid out on a shared baseline, spaced by ink box"""
    imgs = []
    for text, path in runs:
        f = ImageFont.truetype(path, solve(path))
        b = f.getbbox(text)
        im = Image.new("RGBA", (b[2] - b[0] + 8, b[3] - b[1] + 8), (0, 0, 0, 0))
        ImageDraw.Draw(im).text((-b[0] + 4, -b[1] + 4), text, font=f, fill=ink + (255,))
        imgs.append(im.crop(im.getbbox()))
    gap = 18
    w = sum(i.width for i in imgs) + gap * (len(imgs) - 1)
    h = max(i.height for i in imgs)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    x = 0
    for i in imgs:
        out.paste(i, (x, h - i.height), i)   # bottom-aligned: no descenders in these runs
        x += i.width + gap
    return out


def row(runs, bg, ink_rgb, ink_hex, label):
    m = mark(ink_hex)
    word = draw_runs(runs, ink_rgb)
    W = m.width + 40 + word.width + 100
    H = 170
    im = Image.new("RGB", (W, H), bg)
    im.paste(m, (50, (H - m.height) // 2), m)
    im.paste(word, (50 + m.width + 40, (H - word.height) // 2), word)
    lab = Image.new("RGB", (W, 26), (233, 237, 243))
    f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 14)
    ImageDraw.Draw(lab).text((12, 5), label, font=f, fill=(59, 66, 82))
    out = Image.new("RGB", (W, H + 26), bg)
    out.paste(lab, (0, 0)); out.paste(im, (0, 26))
    return out


rows = [
    row([("Etherplay Connect", F900)], (255, 255, 255), (19, 23, 31), "#13171f",
        "one weight: Nunito 900 throughout"),
    row([("Etherplay", F600), ("Connect", F900)], (255, 255, 255), (19, 23, 31), "#13171f",
        "two weights: Etherplay 600 + Connect 900 (family, then member)"),
    row([("Etherplay Connect", F900)], (19, 23, 31), (244, 246, 251), "#f4f6fb",
        "one weight, on dark"),
    row([("Etherplay", F600), ("Connect", F900)], (19, 23, 31), (244, 246, 251), "#f4f6fb",
        "two weights, on dark"),
]
W = max(r.width for r in rows)
sheet = Image.new("RGB", (W, sum(r.height + 6 for r in rows)), (143, 155, 176))
y = 0
for r in rows:
    sheet.paste(r, (0, y)); y += r.height + 6
sheet.save(OUT)
print("wrote", OUT, sheet.size)
