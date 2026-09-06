#!/usr/bin/env bash
# Regenerate every generated branding asset from the authored sources.
# Authored:  logo.svg  icon.svg  icon-maskable.svg  card.src.svg  fonts/
# Generated: card.svg  preview.png  icon.png  web/*
#
# Run it twice and diff the hashes: it is meant to be byte-for-byte deterministic.
set -euo pipefail
cd "$(dirname "$0")"

# ---------------------------------------------------------------- tooling ----
# ImageMagick will happily rasterise an SVG through its own weak internal
# delegate, so a build written for Inkscape silently produces soft, mis-scaled
# output on a machine without it. Refuse rather than ship that.
command -v inkscape >/dev/null || { echo "error: inkscape is required" >&2; exit 1; }
command -v magick   >/dev/null || { echo "error: imagemagick 7 is required" >&2; exit 1; }
echo "rasteriser: $(inkscape --version 2>/dev/null | head -1)"

# ------------------------------------------------------------------ drift ----
# The same mark lives in several files because each needs different ink and
# framing. That rots silently, so compare the load-bearing path data and fail
# BEFORE rendering anything.
#
# The two-bar icon geometry is deliberately NOT the three-bar logo geometry:
# three bars turn to mush at 16px. So the bars are compared icon-to-maskable,
# and only the chevron is compared across the whole set.
chevron() { grep -o 'd="M136 48 L216 128 L136 208"' "$1" | sort -u; }
bars3()   { grep -o 'd="M26 [0-9]* H[0-9]*"'        "$1" | sort;   }
bars2()   { grep -o 'd="M30 [0-9]* H[0-9]*"'        "$1" | sort;   }

fail() { echo "error: $1" >&2; exit 1; }

for f in icon.svg icon-maskable.svg card.src.svg card.svg; do
	[ -f "$f" ] || continue
	[ "$(chevron logo.svg)" = "$(chevron "$f")" ] || {
		diff <(chevron logo.svg) <(chevron "$f") >&2 || true
		fail "the chevron in $f has drifted from logo.svg"
	}
done

for f in card.src.svg card.svg; do
	[ -f "$f" ] || continue
	[ "$(bars3 logo.svg)" = "$(bars3 "$f")" ] || {
		diff <(bars3 logo.svg) <(bars3 "$f") >&2 || true
		fail "the bars in $f have drifted from logo.svg"
	}
done

[ "$(bars2 icon.svg)" = "$(bars2 icon-maskable.svg)" ] || {
	diff <(bars2 icon.svg) <(bars2 icon-maskable.svg) >&2 || true
	fail "the bars in icon-maskable.svg have drifted from icon.svg"
}
echo "drift check: ok"

# ------------------------------------------------------------------ card -----
# card.src.svg holds LIVE TEXT and is the editable source; card.svg is it with
# the text outlined, so nothing downstream needs a font installed.
python3 outline-text.py

# ---------------------------------------------------------------- render -----
# Always render at 2x and downsample: hard-edged geometry stairsteps when
# rasterised straight to size, and the downsample kills most gradient banding.
render() { # render <svg> <2x-width> <final-width> <out.png>
	inkscape "$1" -o "/tmp/_ec_$$.png" -w "$2" >/dev/null 2>&1
	magick "/tmp/_ec_$$.png" -resize "$3" -strip "$4"
	rm -f "/tmp/_ec_$$.png"
}

render card.svg 2560 1280x640 preview.png
render icon.svg 1024 512x512   icon.png

mkdir -p web
render icon.svg          1024 512x512 web/icon-512.png
render icon.svg           768 192x192 web/icon-192.png
render icon.svg           720 180x180 web/apple-touch-icon.png
render icon-maskable.svg 1024 512x512 web/icon-maskable-512.png
render icon.svg           384  48x48  web/_ico48.png
render icon.svg           256  32x32  web/_ico32.png
render icon.svg           128  16x16  web/_ico16.png
magick web/_ico16.png web/_ico32.png web/_ico48.png web/favicon.ico
rm -f web/_ico16.png web/_ico32.png web/_ico48.png

echo "generated:"
for f in card.svg preview.png icon.png web/favicon.ico web/icon-192.png web/icon-512.png \
         web/apple-touch-icon.png web/icon-maskable-512.png; do
	printf '  %-32s %s\n' "$f" "$(md5sum "$f" | cut -c1-12)"
done
