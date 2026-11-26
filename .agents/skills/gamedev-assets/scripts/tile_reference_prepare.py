# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
"""
Prepare a tile-aligned reference image:

- Downscale a high-res reference PNG by an integer factor (NEAREST).
- Overlay a tile grid + (x,y) labels to validate alignment (origin, padding).
- Optionally mark a bottom padding strip (non-tile area).

This script does not assume any engine; it only produces PNGs for inspection.
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


def _grid_overlay(
    img: Image.Image,
    *,
    tile: int,
    cols: int,
    rows: int,
    origin_x: int,
    origin_y: int,
) -> Image.Image:
    out = img.convert("RGBA").copy()
    draw = ImageDraw.Draw(out, "RGBA")
    font = _load_font(10)

    grid = (255, 255, 255, 90)
    bold = (47, 230, 255, 170)

    for c in range(cols + 1):
        x = origin_x + c * tile
        draw.line([(x, origin_y), (x, origin_y + rows * tile)], fill=grid, width=1)
    for r in range(rows + 1):
        y = origin_y + r * tile
        draw.line([(origin_x, y), (origin_x + cols * tile, y)], fill=grid, width=1)
    draw.rectangle([origin_x, origin_y, origin_x + cols * tile, origin_y + rows * tile], outline=bold, width=2)

    # minimal (x,y) labels inside the first cell for quick orientation
    _draw_text(draw, (origin_x + 2, origin_y + 2), "x0,y0", fill=(255, 255, 255, 255), outline=(0, 0, 0, 255), font=font)
    _draw_text(
        draw,
        (origin_x + 2, origin_y + (rows - 1) * tile + 2),
        f"x0,y{rows-1}",
        fill=(255, 255, 255, 255),
        outline=(0, 0, 0, 255),
        font=font,
    )

    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare a tile-aligned reference image + grid overlays.")
    parser.add_argument("--reference", type=Path, required=True, help="High-res reference PNG.")
    parser.add_argument("--downscale", type=int, required=True, help="Integer downscale factor (NEAREST).")
    parser.add_argument("--tile", type=int, default=16)
    parser.add_argument("--grid-cols", type=int, required=True)
    parser.add_argument("--grid-rows", type=int, required=True)
    parser.add_argument("--grid-origin-x", type=int, default=0)
    parser.add_argument("--grid-origin-y", type=int, default=0)
    parser.add_argument("--padding-bottom-px", type=int, default=0, help="Optional bottom padding strip (pixels).")
    parser.add_argument("--out-small", type=Path, default=Path("tmp/reference_small.png"))
    parser.add_argument("--out-grid", type=Path, default=Path("tmp/reference_grid.png"))
    parser.add_argument("--out-grid-scaled", type=Path, default=Path("tmp/reference_grid_scaled.png"))
    args = parser.parse_args()

    ref = Image.open(args.reference).convert("RGBA")
    ds = max(1, int(args.downscale))
    w, h = ref.size
    if w % ds != 0 or h % ds != 0:
        raise SystemExit(f"Reference size {w}x{h} is not divisible by downscale {ds}.")

    small = ref.resize((w // ds, h // ds), resample=Image.Resampling.NEAREST)
    args.out_small.parent.mkdir(parents=True, exist_ok=True)
    small.save(args.out_small)

    grid = _grid_overlay(
        small,
        tile=int(args.tile),
        cols=int(args.grid_cols),
        rows=int(args.grid_rows),
        origin_x=int(args.grid_origin_x),
        origin_y=int(args.grid_origin_y),
    )

    pad = max(0, int(args.padding_bottom_px))
    if pad:
        draw = ImageDraw.Draw(grid, "RGBA")
        y0 = grid.height - pad
        draw.rectangle([0, y0, grid.width, grid.height], fill=(0, 0, 0, 60))
        _draw_text(
            draw,
            (4, y0 + 1),
            f"bottom padding ({pad}px)",
            fill=(255, 255, 255, 220),
            outline=(0, 0, 0, 255),
            font=_load_font(10),
        )

    args.out_grid.parent.mkdir(parents=True, exist_ok=True)
    grid.save(args.out_grid)

    grid_scaled = grid.resize((grid.width * ds, grid.height * ds), resample=Image.Resampling.NEAREST)
    args.out_grid_scaled.parent.mkdir(parents=True, exist_ok=True)
    grid_scaled.save(args.out_grid_scaled)

    print(f"Wrote {args.out_small} ({small.width}x{small.height})")
    print(f"Wrote {args.out_grid} ({grid.width}x{grid.height})")
    print(f"Wrote {args.out_grid_scaled} ({grid_scaled.width}x{grid_scaled.height})")


if __name__ == "__main__":
    main()

