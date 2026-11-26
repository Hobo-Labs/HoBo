# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
"""
Create GIFs from PNG frame sequences (steps and diffs).

This script builds an adaptive palette from a mosaic of thumbnails across all
frames to avoid "silhouette" artifacts when frames contain different colors.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image


def _sorted_steps(paths: list[Path]) -> list[Path]:
    def key(p: Path) -> tuple[int, str]:
        stem = p.stem
        num = -1
        for part in stem.split("_"):
            if part.startswith("step") and part[4:].isdigit():
                num = int(part[4:])
                break
        return (num, p.name)

    return sorted(paths, key=key)


def _load_frames(paths: list[Path], *, scale: float) -> list[Image.Image]:
    frames: list[Image.Image] = []
    for p in paths:
        img = Image.open(p)
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            rgba = img.convert("RGBA")
            bg = Image.new("RGBA", rgba.size, (0, 0, 0, 255))
            rgba = Image.alpha_composite(bg, rgba)
            img = rgba.convert("RGB")
        else:
            img = img.convert("RGB")

        if scale != 1.0:
            w = max(1, int(round(img.width * scale)))
            h = max(1, int(round(img.height * scale)))
            img = img.resize((w, h), resample=Image.Resampling.NEAREST)
        frames.append(img)
    return frames


def _build_palette_source(frames: list[Image.Image], *, colors: int, thumb_w: int = 288, thumb_h: int = 180, cols: int = 4) -> Image.Image:
    if not frames:
        raise ValueError("no frames")

    thumbs: list[Image.Image] = []
    for f in frames:
        t = f.copy()
        t.thumbnail((thumb_w, thumb_h), resample=Image.Resampling.NEAREST)
        thumbs.append(t)

    cols = max(1, int(cols))
    rows = (len(thumbs) + cols - 1) // cols
    w = cols * thumb_w
    h = rows * thumb_h
    mosaic = Image.new("RGB", (w, h), (0, 0, 0))
    for i, t in enumerate(thumbs):
        cx = (i % cols) * thumb_w
        cy = (i // cols) * thumb_h
        ox = cx + (thumb_w - t.width) // 2
        oy = cy + (thumb_h - t.height) // 2
        mosaic.paste(t, (ox, oy))

    return mosaic.convert("P", palette=Image.Palette.ADAPTIVE, colors=colors)


def _quantize(frames: list[Image.Image], *, colors: int) -> list[Image.Image]:
    if not frames:
        return []
    palette = _build_palette_source(frames, colors=colors)
    return [f.convert("RGB").quantize(palette=palette, dither=Image.Dither.FLOYDSTEINBERG) for f in frames]


def _write_gif(frames: list[Image.Image], out_path: Path, *, duration_ms: int, loop: int) -> None:
    if not frames:
        raise SystemExit("No frames to write.")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        out_path,
        save_all=True,
        append_images=frames[1:],
        duration=int(duration_ms),
        loop=int(loop),
        optimize=False,
        disposal=2,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Create GIFs from step/diff PNG sequences.")
    parser.add_argument("--frames", type=str, required=True, help="Glob for step frames (e.g. 'tmp/*step*_debug.png').")
    parser.add_argument("--out", type=Path, default=Path("tmp/steps.gif"))
    parser.add_argument("--diff-frames", type=str, default="", help="Glob for diff frames.")
    parser.add_argument("--out-diff", type=Path, default=Path("tmp/diffs.gif"))
    parser.add_argument("--duration-ms", type=int, default=140)
    parser.add_argument("--loop", type=int, default=0)
    parser.add_argument("--colors", type=int, default=256)
    parser.add_argument("--scale", type=float, default=1.0)
    args = parser.parse_args()

    frames_paths = _sorted_steps([p for p in Path(".").glob(args.frames)])
    if not frames_paths:
        raise SystemExit(f"No frames matched: {args.frames}")
    frames = _load_frames(frames_paths, scale=float(args.scale))
    frames_q = _quantize(frames, colors=int(args.colors))
    _write_gif(frames_q, args.out, duration_ms=int(args.duration_ms), loop=int(args.loop))
    print(f"Wrote {args.out} ({len(frames_q)} frames)")

    if args.diff_frames.strip():
        diff_paths = _sorted_steps([p for p in Path(".").glob(args.diff_frames)])
        if not diff_paths:
            raise SystemExit(f"No diff frames matched: {args.diff_frames}")
        diffs = _load_frames(diff_paths, scale=float(args.scale))
        diffs_q = _quantize(diffs, colors=int(args.colors))
        _write_gif(diffs_q, args.out_diff, duration_ms=int(args.duration_ms), loop=int(args.loop))
        print(f"Wrote {args.out_diff} ({len(diffs_q)} frames)")


if __name__ == "__main__":
    main()

