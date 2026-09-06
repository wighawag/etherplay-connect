#!/usr/bin/env python3
"""Type candidates for the wordmark, each solved to a MEASURED cap height
(never to a nominal point size, which is not comparable across faces)."""
import subprocess, sys, glob, os
from PIL import Image, ImageDraw, ImageFont

WORD = "Etherplay Connect"
CAP_TARGET = 56          # measured cap height of "E", in px
MARK_H = 96              # mark ink-box height, in px
INK = (19, 23, 31)
BG = (255, 255, 255)
LABEL_BG = (233, 237, 243)
OUT = sys.argv[1] if len(sys.argv) > 1 else "typesheet.png"

# Files come from getfonts.py, which maps weight -> url by parsing the css and
# proves the cuts differ by measured ink coverage. Never pick these by eye.
# Weights are SOLVED, not chosen: the mark's stroke is 14px at cap height 56 in
# this lockup, and each face below is the cut whose measured stem hits 14px.
# Quicksand cannot reach it at any weight, so it is out.
CANDIDATES = [
    ("Audiowide 400 (brand intent; stem 10px, cannot go heavier)", "Audiowide-400.ttf"),
    ("Poppins 700 (stem 14px)", "Poppins-700.ttf"),
    ("Nunito 900 (stem 14px, rounded terminals)", "Nunito-900.ttf"),
    ("Outfit 800 (stem 14px)", "Outfit-800.ttf"),
]
FONTDIR = "/tmp/bfonts"


def cap_height(font):
    """Measured ink height of a capital E, not the nominal size."""
    box = font.getbbox("E")
    return box[3] - box[1]


def ink_coverage(path, size=80):
    font = ImageFont.truetype(path, size)
    box = font.getbbox("Etherplay")
    w, h = box[2] - box[0], box[3] - box[1]
    img = Image.new("L", (w + 4, h + 4), 0)
    ImageDraw.Draw(img).text((-box[0] + 2, -box[1] + 2), "Etherplay", font=font, fill=255)
    px = list(img.getdata())
    return sum(px) / (255.0 * len(px))


def solve_size(path, target):
    lo, hi = 4, 400
    best = 12
    while lo <= hi:
        mid = (lo + hi) // 2
        h = cap_height(ImageFont.truetype(path, mid))
        if h < target:
            best, lo = mid, mid + 1
        elif h > target:
            hi = mid - 1
        else:
            return mid
    return best


def render_word(path, size):
    font = ImageFont.truetype(path, size)
    box = font.getbbox(WORD)                      # ink box, not the em box
    w, h = box[2] - box[0], box[3] - box[1]
    img = Image.new("RGBA", (w + 8, h + 8), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((-box[0] + 4, -box[1] + 4), WORD, font=font, fill=INK + (255,))
    return img.crop(img.getbbox())


def mark_png():
    subprocess.run(["magick", "-background", "none", "-density", "900", "A-mark.svg",
                    "-trim", "+repage", "-resize", f"x{MARK_H}", "/tmp/bfonts/_mark.png"],
                   check=True)
    return Image.open("/tmp/bfonts/_mark.png").convert("RGBA")


def label(text, w):
    img = Image.new("RGB", (w, 26), LABEL_BG)
    f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 14)
    ImageDraw.Draw(img).text((12, 5), text, font=f, fill=(59, 66, 82))
    return img


mark = mark_png()
rows = []
for name, pattern in CANDIDATES:
    hits = glob.glob(os.path.join(FONTDIR, pattern))
    if not hits:
        print(f"missing: {pattern}", file=sys.stderr)
        continue
    path = hits[0]
    size = solve_size(path, CAP_TARGET)
    word = render_word(path, size)
    gap = 40
    row_w = mark.width + gap + word.width + 80
    row_h = max(mark.height, word.height) + 56
    row = Image.new("RGB", (row_w, row_h), BG)
    row.paste(mark, (40, (row_h - mark.height) // 2), mark)
    row.paste(word, (40 + mark.width + gap, (row_h - word.height) // 2), word)
    measured = cap_height(ImageFont.truetype(path, size))
    cov = ink_coverage(path)
    rows.append((label(f"{name}   |   size {size}px solved to cap height {measured}px   |   ink coverage {cov:.3f}",
                       row_w), row))

width = max(r.width for _, r in rows)
total = sum(l.height + r.height + 6 for l, r in rows)
sheet = Image.new("RGB", (width, total), (143, 155, 176))
y = 0
for lab, row in rows:
    sheet.paste(lab.resize((width, lab.height)), (0, y)); y += lab.height
    sheet.paste(row, (0, y)); y += row.height + 6
sheet.save(OUT)
print("wrote", OUT, sheet.size)
