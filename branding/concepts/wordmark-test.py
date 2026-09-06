#!/usr/bin/env python3
"""How short can the wordmark get? Same mark, same measured cap height, six strings.
Bottom block repeats the finalists at social-card thumbnail scale, which is the
context-free surface where a short name has to survive on its own."""
import subprocess
from PIL import Image, ImageDraw, ImageFont

CAP = 56
MARK_H = 96
BLACK = "/home/wighawag/dev/github/wighawag/etherplay-connect/branding/fonts/Nunito-Black.ttf"
INK_L = (19, 23, 31)
MUTED_L = (138, 148, 166)
INK_D = (244, 246, 251)
MUTED_D = (142, 151, 168)
OUT = "wordmark-test.png"


def cap_h(f):
    b = f.getbbox("E")
    return b[3] - b[1]


def solve(path, target):
    lo, hi, best = 4, 400, 12
    while lo <= hi:
        m = (lo + hi) // 2
        h = cap_h(ImageFont.truetype(path, m))
        if h < target: best, lo = m, m + 1
        elif h > target: hi = m - 1
        else: return m
    return best


def mark(ink_hex, height):
    src = "/home/wighawag/dev/github/wighawag/etherplay-connect/branding/logo.svg"
    tmp = "/tmp/bfonts/_wm.svg"
    open(tmp, "w").write(open(src).read().replace("color:#13171f", f"color:{ink_hex}"))
    subprocess.run(["inkscape", tmp, "-o", "/tmp/bfonts/_wm.png", "-h", str(height * 4)],
                   check=True, capture_output=True)
    im = Image.open("/tmp/bfonts/_wm.png").convert("RGBA")
    return im.resize((round(im.width / 4), height), Image.LANCZOS)


def runs_img(runs, cap):
    """runs: [(text, rgb)] set on one baseline in one face/size"""
    size = solve(BLACK, cap)
    font = ImageFont.truetype(BLACK, size)
    full = "".join(t for t, _ in runs)
    b = font.getbbox(full)
    img = Image.new("RGBA", (b[2] - b[0] + 12, b[3] - b[1] + 12), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x = -b[0] + 6
    for text, rgb in runs:
        d.text((x, -b[1] + 6), text, font=font, fill=rgb + (255,))
        x += d.textlength(text, font=font)
    return img.crop(img.getbbox())


def row(runs, cap, mark_h, bg, ink_hex, label, labelled=True):
    m = mark(ink_hex, mark_h)
    word = runs_img(runs, cap)
    pad = round(mark_h * 0.5)
    W = pad + m.width + round(mark_h * 0.42) + word.width + pad
    H = round(mark_h * 1.75)
    im = Image.new("RGB", (W, H), bg)
    im.paste(m, (pad, (H - m.height) // 2), m)
    im.paste(word, (pad + m.width + round(mark_h * 0.42), (H - word.height) // 2), word)
    if not labelled:
        return im
    lab = Image.new("RGB", (W, 26), (233, 237, 243))
    f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 14)
    ImageDraw.Draw(lab).text((12, 5), label, font=f, fill=(59, 66, 82))
    out = Image.new("RGB", (W, H + 26), bg)
    out.paste(lab, (0, 0)); out.paste(im, (0, 26))
    return out


L = (255, 255, 255)
D = (19, 23, 31)
rows = [
    row([("Etherplay Connect", INK_L)], CAP, MARK_H, L, "#13171f", "1  Etherplay Connect"),
    row([("Connect", INK_L)], CAP, MARK_H, L, "#13171f", "2  Connect"),
    row([("connect", INK_L)], CAP, MARK_H, L, "#13171f", "3  connect"),
    row([("@etherplay/", MUTED_L), ("connect", INK_L)], CAP, MARK_H, L, "#13171f",
        "4  @etherplay/connect, scope muted"),
    row([("etherplay/", MUTED_L), ("connect", INK_L)], CAP, MARK_H, L, "#13171f",
        "5  etherplay/connect, scope muted"),
    row([("@etherplay/connect", INK_L)], CAP, MARK_H, L, "#13171f", "6  @etherplay/connect, one ink"),
    # thumbnail test: the card scaled to how a timeline actually shows it
    row([("Connect", INK_D)], 22, 38, D, "#f4f6fb", "2 at thumbnail scale, on dark"),
    row([("etherplay/", MUTED_D), ("connect", INK_D)], 22, 38, D, "#f4f6fb",
        "5 at thumbnail scale, on dark"),
    row([("Etherplay Connect", INK_D)], 22, 38, D, "#f4f6fb", "1 at thumbnail scale, on dark"),
]
W = max(r.width for r in rows)
sheet = Image.new("RGB", (W, sum(r.height + 6 for r in rows)), (143, 155, 176))
y = 0
for r in rows:
    sheet.paste(r, (0, y)); y += r.height + 6
sheet.save(OUT)
print("wrote", OUT, sheet.size)
