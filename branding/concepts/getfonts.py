#!/usr/bin/env python3
"""Download candidate faces, mapping weight -> url by PARSING the css, and prove
the cuts really differ by measuring rendered ink coverage (a named family whose
bold is a separate file falls back to regular with no error otherwise)."""
import re, subprocess, os, sys
from PIL import Image, ImageDraw, ImageFont

OUT = "/tmp/bfonts"
FAMILIES = ["Audiowide", "Poppins", "Nunito", "Quicksand", "Manrope", "Outfit"]
os.makedirs(OUT, exist_ok=True)

BLOCK = re.compile(r"@font-face\s*\{(.*?)\}", re.S)


def fetch(url, dest):
    subprocess.run(["curl", "-sS", "-m", "30", "-A", "Mozilla/5.0", url, "-o", dest], check=True)


def ink_coverage(path, size=80):
    """Fraction of the ink box that is actually ink: this is what separates a
    real bold cut from a regular one silently standing in for it."""
    font = ImageFont.truetype(path, size)
    box = font.getbbox("Etherplay")
    w, h = box[2] - box[0], box[3] - box[1]
    img = Image.new("L", (w + 4, h + 4), 0)
    ImageDraw.Draw(img).text((-box[0] + 2, -box[1] + 2), "Etherplay", font=font, fill=255)
    px = list(img.getdata())
    return sum(px) / (255.0 * len(px))


for fam in FAMILIES:
    css = os.path.join(OUT, f"{fam}.css")
    fetch(f"https://fonts.googleapis.com/css2?family={fam}:wght@400;700&display=swap", css)
    seen = {}
    for body in BLOCK.findall(open(css).read()):
        wm = re.search(r"font-weight:\s*(\d+)", body)
        um = re.search(r"url\((https://[^)]+)\)", body)
        if not wm or not um:
            continue
        weight = wm.group(1)
        if weight in seen:            # first block per weight is enough (latin)
            continue
        seen[weight] = um.group(1)
    for weight, url in sorted(seen.items()):
        dest = os.path.join(OUT, f"{fam}-{weight}.ttf")
        fetch(url, dest)
        print(f"{fam:10s} {weight}  coverage={ink_coverage(dest):.4f}  {os.path.basename(url)}")
