# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
"""
Compose a scene backdrop by alpha-compositing multiple same-sized layers.

Use when a reference image includes background layers that are not tiles and must
be reproduced deterministically before tile diffs make sense.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def main() -> None:
    parser = argparse.ArgumentParser(description="Compose backdrop PNG by alpha-compositing layers.")
    parser.add_argument(
        "--layers",
        nargs="+",
        type=Path,
        required=True,
        help="Backdrop layers in draw order (base first, top last).",
    )
    parser.add_argument("--out", type=Path, default=Path("tmp/backdrop.png"))
    parser.add_argument("--scale", type=int, default=6, help="Scale factor for the optional scaled output.")
    parser.add_argument("--out-scaled", type=Path, default=Path("tmp/backdrop_x6.png"))
    args = parser.parse_args()

    base = Image.open(args.layers[0]).convert("RGBA")
    for layer in args.layers[1:]:
        img = Image.open(layer).convert("RGBA")
        if img.size != base.size:
            raise SystemExit(f"Layer size mismatch: {layer} is {img.size}, expected {base.size}")
        base.alpha_composite(img)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    base.save(args.out)

    scale = max(1, int(args.scale))
    scaled = base.resize((base.width * scale, base.height * scale), resample=Image.Resampling.NEAREST)
    args.out_scaled.parent.mkdir(parents=True, exist_ok=True)
    scaled.save(args.out_scaled)

    print(f"Wrote {args.out} ({base.width}x{base.height})")
    print(f"Wrote {args.out_scaled} ({scaled.width}x{scaled.height})")


if __name__ == "__main__":
    main()

