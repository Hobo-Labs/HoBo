# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
"""
Generate a tileset reference image with per-cell labels:
- 1-based tile ID (row-major)
- tileset (col,row) (0-based)

Use this as a fast "tile picker" when editing step JSON files by hand.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Menlo.ttc",
        "/System/Library/Fonts/Supplemental/Menlo.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
    ]
    for p in candidates:
        try:
            return ImageFont.truetype(p, size=size)
        except Exception:
            pass
    return ImageFont.load_default()


def _draw_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    *,
    fill: tuple[int, int, int, int],
    outline: tuple[int, int, int, int],
    font: ImageFont.ImageFont,
) -> None:
    x, y = xy
    for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]:
        draw.text((x + dx, y + dy), text, fill=outline, font=font)
    draw.text((x, y), text, fill=fill, font=font)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a tileset ID reference sheet.")
    parser.add_argument("--tileset", type=Path, required=True, help="Tileset PNG (grid-based).")
    parser.add_argument("--tile", type=int, default=16, help="Tile size in pixels (assumes square tiles).")
    parser.add_argument("--scale", type=int, default=6, help="Scale factor for readability.")
    parser.add_argument("--out", type=Path, default=Path("tmp/tileset_ids.png"))
    args = parser.parse_args()

    img = Image.open(args.tileset).convert("RGBA")
    w, h = img.size
    tile = int(args.tile)
    if w % tile != 0 or h % tile != 0:
        raise SystemExit(f"Tileset size {w}x{h} is not divisible by tile size {tile}.")

    cols = w // tile
    rows = h // tile

    scale = max(1, int(args.scale))
    scaled = img.resize((w * scale, h * scale), resample=Image.Resampling.NEAREST)

    header_h = max(18 * scale // 2, 24)
    gutter_w = max(36 * scale // 2, 42)
    canvas = Image.new("RGBA", (scaled.size[0] + gutter_w, scaled.size[1] + header_h), (0, 0, 0, 255))
    canvas.paste(scaled, (gutter_w, header_h))

    draw = ImageDraw.Draw(canvas, "RGBA")
    font = _load_font(size=max(10, 10 * scale // 3))
    font_small = _load_font(size=max(9, 9 * scale // 3))

    grid_color = (255, 255, 255, 110)
    grid_strong = (255, 255, 255, 180)
    origin_x, origin_y = gutter_w, header_h
    tile_px = tile * scale

    for c in range(cols + 1):
        x = origin_x + c * tile_px
        color = grid_strong if c % 4 == 0 else grid_color
        draw.line([(x, origin_y), (x, origin_y + rows * tile_px)], fill=color, width=1)
    for r in range(rows + 1):
        y = origin_y + r * tile_px
        color = grid_strong if r % 4 == 0 else grid_color
        draw.line([(origin_x, y), (origin_x + cols * tile_px, y)], fill=color, width=1)

    # Column headers.
    for c in range(cols):
        label = str(c)
        bbox = draw.textbbox((0, 0), label, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        x = origin_x + c * tile_px + tile_px // 2 - tw // 2
        y = header_h // 2 - th // 2
        _draw_text(draw, (x, y), label, fill=(255, 255, 255, 255), outline=(0, 0, 0, 255), font=font)

    # Row headers.
    for r in range(rows):
        label = str(r)
        bbox = draw.textbbox((0, 0), label, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        x = gutter_w // 2 - tw // 2
        y = origin_y + r * tile_px + tile_px // 2 - th // 2
        _draw_text(draw, (x, y), label, fill=(255, 255, 255, 255), outline=(0, 0, 0, 255), font=font)

    for r in range(rows):
        for c in range(cols):
            tile_id = r * cols + c + 1
            x0 = origin_x + c * tile_px
            y0 = origin_y + r * tile_px
            _draw_text(
                draw,
                (x0 + 3, y0 + 3),
                f"id:{tile_id}",
                fill=(255, 255, 255, 255),
                outline=(0, 0, 0, 255),
                font=font_small,
            )
            _draw_text(
                draw,
                (x0 + 3, y0 + 3 + font_small.size + 1),
                f"{c},{r}",
                fill=(255, 255, 255, 255),
                outline=(0, 0, 0, 255),
                font=font_small,
            )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(args.out)
    print(f"Wrote {args.out} (cols={cols}, rows={rows}, tile={tile}, scale={scale})")


if __name__ == "__main__":
    main()

