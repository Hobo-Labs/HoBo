# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10"]
# ///
"""Compose the style references a generation run is given.

A model matches a style it can see far better than one it is told about, so
every brief in `media/scripts/jobs/` attaches a board of the art the new
drawing has to sit beside: Bo's own frames for a character, the approved props
for a prop. They are recomposited on the same flat chroma ground the brief
asks for, so the reference demonstrates the ground as well as the ink.

Outputs go to the run folder (gitignored) — they are inputs to a generation,
not art in their own right, and rebuild from shipped files alone:

    uv run media/scripts/build-style-refs.py trail-cast-r1
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
PARALLAX = ROOT / "site" / "public" / "parallax"
GROUND = (0, 255, 0, 255)


def row(images: list[Image.Image], gap: int, margin: int) -> Image.Image:
	height = max(i.height for i in images)
	width = sum(i.width for i in images) + gap * (len(images) + 1)
	sheet = Image.new("RGBA", (width, height + margin * 2), GROUND)
	x = gap
	for image in images:
		# Bottom-aligned: everything in a reference stands on one line.
		sheet.alpha_composite(image, (x, margin + height - image.height))
		x += image.width + gap
	return sheet


def main() -> None:
	if len(sys.argv) != 2:
		raise SystemExit(__doc__)
	out = ROOT / "media" / "runs" / sys.argv[1] / "refs"
	out.mkdir(parents=True, exist_ok=True)

	walk = Image.open(PARALLAX / "bo-walk.png").convert("RGBA")
	idle = Image.open(PARALLAX / "bo-idle.png").convert("RGBA")
	frames = [
		walk.crop((c * 160, r * 157, (c + 1) * 160, (r + 1) * 157)).resize((480, 471), Image.LANCZOS)
		for r, c in [(0, 0), (1, 3), (3, 4)]
	]
	frames.append(idle.crop((0, 0, 207, 230)).resize((424, 471), Image.LANCZOS))
	row(frames, 60, 60).convert("RGB").save(out / "style-bo-green.png")

	props = [Image.open(p).convert("RGBA") for p in sorted((PARALLAX / "landmarks").glob("*.png"))]
	row(props, 50, 50).convert("RGB").save(out / "style-props-green.png")
	print(f"wrote {out.relative_to(ROOT)}/style-bo-green.png, style-props-green.png")


if __name__ == "__main__":
	main()
