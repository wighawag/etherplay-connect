#!/usr/bin/env python3
"""Solve the card's layout against the REAL renderer, then rewrite card.src.svg.

Why this exists: nominal font-size is not comparable across faces, SVG places text
by baseline while the design is specified as ink boxes, and the wordmark's width
changes whenever the copy does. So every number is measured back out of Inkscape
and corrected, rather than guessed.

The wordmark's SIZE is fixed, not solved: it was approved at this size and the
whole point of the short scoped name is that `connect` stays large. The width it
happens to occupy is then an input to the centring, not a target to squeeze into.
Re-run after any copy change, then run outline-text.py (build.sh does both).
"""
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "card.src.svg"
TMP = Path("/tmp/etherplay-connect-fc")

CARD_W = 1280.0
WORDMARK_SIZE = 71.117       # approved optical size; do not solve this away
MARK_INK_W = 288.75          # 252 tall at the mark's own 220x192 aspect
MARK_INK_LEFT_IN_GROUP = 12 * 1.3125      # the mark's ink starts inset in its own box
MARK_INK_TOP_IN_GROUP = 32 * 1.3125
MARK_TOP = 194.0             # ink box 252 tall, centred on y=320
GAP = 64.0                   # mark ink box to type ink box
TAGLINE_W = 560.0
WORDMARK_INK_BOTTOM = 317.0  # puts the type block's centre on 320, where the mark's is
TAGLINE_INK_TOP = 373.0


def env_with_vendored_fonts():
    TMP.mkdir(parents=True, exist_ok=True)
    (TMP / "fonts.conf").write_text(
        '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n'
        f"<fontconfig><dir>{HERE / 'fonts'}</dir><dir>/usr/share/fonts</dir>"
        f"<cachedir>{TMP / 'cache'}</cachedir></fontconfig>\n"
    )
    env = dict(os.environ)
    env["FONTCONFIG_FILE"] = str(TMP / "fonts.conf")
    return env


ENV = env_with_vendored_fonts()


def query(el):
    out = subprocess.run(["inkscape", str(SRC), f"--query-id={el}", "--query-all"],
                         capture_output=True, text=True, env=ENV, check=True).stdout
    for line in out.splitlines():
        parts = line.split(",")
        if parts[0] == el:
            return [float(v) for v in parts[1:5]]
    sys.exit(f"no bbox for {el}")


def get_attr(el, attr):
    m = re.search(rf'id="{el}"[^>]*?\b{attr}="([^"]+)"', SRC.read_text())
    if not m:
        sys.exit(f"no {attr} on #{el}")
    return m.group(1)


def set_attr(el, attr, value):
    txt = SRC.read_text()
    v = f"{value:g}" if isinstance(value, float) else str(value)
    txt, n = re.subn(rf'(id="{el}"[^>]*?\b{attr}=")[^"]+(")',
                     lambda m: f"{m.group(1)}{v}{m.group(2)}", txt, count=1)
    if n != 1:
        sys.exit(f"could not set {attr} on #{el}")
    SRC.write_text(txt)


# 1. wordmark at its fixed size; measure what it now occupies
set_attr("wordmark", "font-size", WORDMARK_SIZE)
_, _, word_w, _ = query("wordmark")

# 2. centre the WHOLE lockup as a group, so longer copy re-centres the composition
block_w = max(word_w, TAGLINE_W)
group_w = MARK_INK_W + GAP + block_w
left = (CARD_W - group_w) / 2.0
type_left = left + MARK_INK_W + GAP

set_attr("mark", "transform",
         f"translate({left - MARK_INK_LEFT_IN_GROUP:g} {MARK_TOP - MARK_INK_TOP_IN_GROUP:g}) "
         f"scale(1.3125)")

# 3. tagline size to its own width target
for _ in range(3):
    _, _, tw, _ = query("tagline")
    size = float(get_attr("tagline", "font-size"))
    if abs(tw - TAGLINE_W) < 0.5:
        break
    set_attr("tagline", "font-size", size * TAGLINE_W / tw)

# 4. x corrects for side bearing, y converts a designed ink edge into a baseline
for el, ink_edge, target in (("wordmark", "bottom", WORDMARK_INK_BOTTOM),
                             ("tagline", "top", TAGLINE_INK_TOP)):
    x, y, w, h = query(el)
    set_attr(el, "x", float(get_attr(el, "x")) + (type_left - x))
    x, y, w, h = query(el)
    have = (y + h) if ink_edge == "bottom" else y
    set_attr(el, "y", float(get_attr(el, "y")) + (target - have))

# 5. the accent rule ties the block together, so it shares the measured left edge
wx, _, _, _ = query("wordmark")
set_attr("rule", "x", wx)

print(f"{'element':10s} {'size':>8s} {'ink w':>8s} {'ink h':>7s}   ink box")
for el in ("wordmark", "tagline"):
    x, y, w, h = query(el)
    print(f"{el:10s} {float(get_attr(el, 'font-size')):8.3f} {w:8.2f} {h:7.2f}   "
          f"x {x:.1f}..{x + w:.1f}  y {y:.1f}..{y + h:.1f}")
mx, my, mw, mh = query("mark")
print(f"{'mark':10s} {'-':>8s} {mw:8.2f} {mh:7.2f}   x {mx:.1f}..{mx + mw:.1f}  y {my:.1f}..{my + mh:.1f}")
print(f"group centred: left margin {mx:.1f}, right margin {CARD_W - max(mx + mw, wx + query('wordmark')[2]):.1f}")
