#!/usr/bin/env bash
# Contact sheet: per row, mark @256 on light, mark @256 on dark, then the icon
# at true 64 / 32 / 16 (each shown at true size AND nearest-neighbour magnified,
# because 16px is unjudgeable on a screenshot otherwise).
set -euo pipefail
cd "$(dirname "$0")"

INK_LIGHT='#13171f'
INK_DARK='#f4f6fb'
BG_LIGHT='#ffffff'
BG_DARK='#13171f'
SHEET="${1:-sheet.png}"
ROWS="${ROWS:-d1 d2 d3 d4}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

ink() { # ink <src.svg> <hex> <dst.svg>
  sed "s/color:#13171f/color:$2/" "$1" > "$3"
}

cell_label() { # cell_label <text> <width>
  magick -background '#e9edf3' -fill '#3b4252' -font DejaVu-Sans -pointsize 15 \
    -size "$2"x24 -gravity center label:"$1" miff:-
}

row_files=()
for d in $ROWS; do
  ink "$d-mark.svg" "$INK_LIGHT" "$tmp/$d-m-l.svg"
  ink "$d-mark.svg" "$INK_DARK"  "$tmp/$d-m-d.svg"
  ink "$d-icon.svg" "$INK_LIGHT" "$tmp/$d-i-l.svg"

  magick -background none "$tmp/$d-m-l.svg" -resize 256x256 \
    -background "$BG_LIGHT" -alpha remove -alpha off \
    -bordercolor "$BG_LIGHT" -border 16 "$tmp/$d-c1.png"
  magick -background none "$tmp/$d-m-d.svg" -resize 256x256 \
    -background "$BG_DARK" -alpha remove -alpha off \
    -bordercolor "$BG_DARK" -border 16 "$tmp/$d-c2.png"

  # icon column: true size on top, magnified below, so the silhouette is judgeable
  small=()
  for s in 64 32 16; do
    magick -background none "$tmp/$d-i-l.svg" -resize "${s}x${s}" \
      -background "$BG_LIGHT" -alpha remove -alpha off "$tmp/$d-i$s.png"
    magick "$tmp/$d-i$s.png" -filter point -resize 128x128 "$tmp/$d-i$s-big.png"
    magick "$tmp/$d-i$s.png" -background "$BG_LIGHT" -gravity center -extent 128x128 \
      "$tmp/$d-i$s-true.png"
    magick "$tmp/$d-i$s-true.png" "$tmp/$d-i$s-big.png" -background '#c9d2e0' \
      -append -bordercolor '#c9d2e0' -border 4 "$tmp/$d-col$s.png"
    small+=("$tmp/$d-col$s.png")
  done

  magick "$tmp/$d-c1.png" "$tmp/$d-c2.png" "${small[@]}" \
    -background '#c9d2e0' -gravity center +append "$tmp/$d-row.png"

  w=$(magick identify -format '%w' "$tmp/$d-row.png")
  cell_label "$d   |   mark on light   |   mark on dark   |   icon 64 / 32 / 16 (true size above, magnified below)" "$w" > "$tmp/$d-lab.miff"
  magick "$tmp/$d-lab.miff" "$tmp/$d-row.png" -background '#c9d2e0' -append "$tmp/$d-full.png"
  row_files+=("$tmp/$d-full.png")
done

magick "${row_files[@]}" -background '#8f9bb0' -gravity west -append \
  -bordercolor '#8f9bb0' -border 6 "$SHEET"
echo "wrote $SHEET"
magick identify "$SHEET"
