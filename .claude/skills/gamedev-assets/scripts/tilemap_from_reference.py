# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
"""
Generate a tilemap (tile indices) from a reference PNG + tileset (manifest-driven).

This is a best-effort heuristic using naive brute-force matching (RGB MSE) per tile
cell, optionally row-by-row across multiple layers. It is designed to bootstrap a
reconstruction so you can fix remaining mismatches manually.

Inputs:
  - assets_index.json (manifest)
  - tileset key
  - reference image (often high-res)
  - optional backdrop (single PNG or composited layers)

Outputs:
  - reference_small.png + reference_grid.png (for alignment validation)
  - reconstruction_map.json (layered, empty base)
  - steps/step_XX.json (placements)
  - resolved_map.json (layered grids after steps)
  - tilemap.json (single-layer {meta,data}, compatible with asset_tilemap_editor.py)

Notes:
  - If the reference includes non-tile pixels (hand-painting, sprites, postprocess),
    perfect reconstruction may be impossible.
  - If you do not supply a backdrop (or at least a correct solid bg), matching will
    often fail because "empty" differs from the reference everywhere.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from PIL import Image, ImageChops, ImageDraw, ImageFont


def _int(v: Any, default: int) -> int:
    if isinstance(v, (int, float)):
        return int(v)
    return default


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


def _parse_hex_color(s: str) -> tuple[int, int, int, int]:
    t = s.strip()
    if not t.startswith("#") or len(t) not in (7, 9):
        raise SystemExit("Color must be #RRGGBB or #RRGGBBAA")
    r = int(t[1:3], 16)
    g = int(t[3:5], 16)
    b = int(t[5:7], 16)
    a = int(t[7:9], 16) if len(t) == 9 else 255
    return (r, g, b, a)


def _resolve_asset_path(manifest_path: Path, manifest: dict[str, Any], rel: str, *, root_override: Path | None) -> Path:
    manifest_dir = manifest_path.parent.resolve()
    meta = manifest.get("meta")
    root = meta.get("root") if isinstance(meta, dict) else None
    base = (manifest_dir / root).resolve() if isinstance(root, str) else manifest_dir
    p = Path(rel)
    if p.is_absolute():
        return p.resolve()
    extra_assets_root = (Path.cwd() / "assets").resolve() if (Path.cwd() / "assets").exists() else None
    candidates: list[Path | None] = [
        (root_override / p).resolve() if root_override is not None else None,
        (base / p).resolve(),
        (manifest_dir / p).resolve(),
        (Path.cwd() / p).resolve(),
        (extra_assets_root / p).resolve() if extra_assets_root is not None else None,
    ]
    for c in candidates:
        if c is not None and c.exists():
            return c
    return (candidates[0] or candidates[1]).resolve()


def _lookup_tileset(manifest: dict[str, Any], tileset_key: str) -> dict[str, Any]:
    tilesets = manifest.get("tilesets")
    if not isinstance(tilesets, dict):
        raise SystemExit("Manifest missing `tilesets` object.")
    cur: Any = tilesets
    for part in tileset_key.split("."):
        if not isinstance(cur, dict) or part not in cur:
            raise SystemExit(f"Tileset not found in manifest at key: {tileset_key!r}")
        cur = cur[part]
    if not isinstance(cur, dict) or not isinstance(cur.get("path"), str):
        raise SystemExit(f"Tileset entry must be an object with string `path`: {tileset_key!r}")
    return cur


@dataclass(frozen=True)
class TilesetMeta:
    path: Path
    tile_w: int
    tile_h: int
    columns: int
    rows: int
    margin: int
    spacing: int

    def col_row_from_tile_id(self, tile_id: int) -> tuple[int, int]:
        if tile_id <= 0:
            return 0, 0
        idx0 = tile_id - 1
        row0 = idx0 // self.columns
        col0 = idx0 - row0 * self.columns
        return col0, row0

    def crop_box(self, tile_id: int) -> tuple[int, int, int, int]:
        col0, row0 = self.col_row_from_tile_id(tile_id)
        x = self.margin + col0 * (self.tile_w + self.spacing)
        y = self.margin + row0 * (self.tile_h + self.spacing)
        return (x, y, x + self.tile_w, y + self.tile_h)


@dataclass(frozen=True)
class GridSpec:
    downscale: int
    canvas_w: int
    canvas_h: int
    grid_w: int
    grid_h: int
    origin_x: int
    origin_y: int
    pad_left: int
    pad_top: int
    pad_right: int
    pad_bottom: int


def _tileset_meta_from_manifest(manifest_path: Path, manifest: dict[str, Any], tileset_key: str, *, root_override: Path | None) -> TilesetMeta:
    ts = _lookup_tileset(manifest, tileset_key)
    path = _resolve_asset_path(manifest_path, manifest, str(ts["path"]), root_override=root_override)
    if not path.exists():
        raise SystemExit(f"Tileset file not found: {path}")
    tile_w = _int(ts.get("tileWidth") or ts.get("tileW"), 16)
    tile_h = _int(ts.get("tileHeight") or ts.get("tileH"), 16)
    margin = _int(ts.get("margin"), 0)
    spacing = _int(ts.get("spacing"), 0)
    with Image.open(path) as img:
        img_w, img_h = img.size
    columns = _int(ts.get("columns"), 0)
    rows = _int(ts.get("rows"), 0)
    if columns <= 0:
        denom = tile_w + spacing
        columns = (img_w - 2 * margin + spacing) // denom if denom > 0 else 0
    if rows <= 0:
        denom = tile_h + spacing
        rows = (img_h - 2 * margin + spacing) // denom if denom > 0 else 0
    if columns <= 0 or rows <= 0:
        raise SystemExit(f"Invalid tileset grid: columns={columns} rows={rows}")
    return TilesetMeta(path=path, tile_w=tile_w, tile_h=tile_h, columns=columns, rows=rows, margin=margin, spacing=spacing)


def _infer_downscale(reference: Image.Image, *, tile_w: int, tile_h: int, max_factor: int) -> int:
    w, h = reference.size
    best: tuple[int, int] | None = None  # (pad_y, -factor)
    best_factor = 0
    for f in range(1, max_factor + 1):
        if w % f != 0 or h % f != 0:
            continue
        sw = w // f
        sh = h // f
        if sw % tile_w != 0:
            continue
        pad_y = sh % tile_h
        score = (pad_y, -f)
        if best is None or score < best:
            best = score
            best_factor = f
    if best_factor <= 0:
        raise SystemExit(
            "Could not infer integer downscale. Provide --downscale explicitly, or choose tile-aligned sizes manually."
        )
    return best_factor


def _strip_variance(img: Image.Image, box: tuple[int, int, int, int]) -> float:
    # Simple variance proxy: mean absolute deviation in RGB vs the average color.
    crop = img.crop(box).convert("RGB")
    px = list(crop.getdata())
    if not px:
        return 0.0
    mr = sum(p[0] for p in px) / len(px)
    mg = sum(p[1] for p in px) / len(px)
    mb = sum(p[2] for p in px) / len(px)
    mad = sum(abs(p[0] - mr) + abs(p[1] - mg) + abs(p[2] - mb) for p in px) / len(px)
    return float(mad)


def _infer_grid(reference_small: Image.Image, *, tile_w: int, tile_h: int, padding_side: str) -> GridSpec:
    w, h = reference_small.size
    if w % tile_w != 0:
        raise SystemExit(f"Reference-small width {w} is not divisible by tile width {tile_w}.")
    grid_w = w // tile_w

    grid_h = h // tile_h
    pad_y = h - grid_h * tile_h

    if pad_y == 0:
        return GridSpec(
            downscale=1,
            canvas_w=w,
            canvas_h=h,
            grid_w=grid_w,
            grid_h=grid_h,
            origin_x=0,
            origin_y=0,
            pad_left=0,
            pad_top=0,
            pad_right=0,
            pad_bottom=0,
        )

    pad_top = 0
    pad_bottom = 0
    if padding_side == "top":
        pad_top = pad_y
    elif padding_side == "bottom":
        pad_bottom = pad_y
    else:
        # auto: pick the more "uniform" strip as padding.
        top_var = _strip_variance(reference_small, (0, 0, w, pad_y))
        bot_var = _strip_variance(reference_small, (0, h - pad_y, w, h))
        if bot_var <= top_var:
            pad_bottom = pad_y
        else:
            pad_top = pad_y

    origin_y = pad_top
    return GridSpec(
        downscale=1,
        canvas_w=w,
        canvas_h=h,
        grid_w=grid_w,
        grid_h=grid_h,
        origin_x=0,
        origin_y=origin_y,
        pad_left=0,
        pad_top=pad_top,
        pad_right=0,
        pad_bottom=pad_bottom,
    )


def _compose_backdrop(
    *,
    reference_size: tuple[int, int],
    reference_small_size: tuple[int, int],
    downscale: int,
    backdrop: Path | None,
    backdrop_layers: list[Path],
    bg_rgba: tuple[int, int, int, int],
) -> Image.Image:
    if backdrop is None and not backdrop_layers:
        return Image.new("RGBA", reference_small_size, bg_rgba)

    layers: list[Image.Image] = []
    if backdrop is not None:
        layers.append(Image.open(backdrop).convert("RGBA"))
    for p in backdrop_layers:
        layers.append(Image.open(p).convert("RGBA"))

    if not layers:
        return Image.new("RGBA", reference_small_size, bg_rgba)

    # If layers are hi-res, downscale them all first.
    def to_small(img: Image.Image) -> Image.Image:
        if img.size == reference_small_size:
            return img
        if img.size == reference_size:
            return img.resize(reference_small_size, resample=Image.Resampling.NEAREST)
        raise SystemExit(f"Backdrop layer has unexpected size {img.size}; expected {reference_size} or {reference_small_size}")

    small_layers = [to_small(img) for img in layers]
    base = small_layers[0].copy()
    for img in small_layers[1:]:
        if img.size != base.size:
            raise SystemExit("Backdrop layers must all be the same size after downscale.")
        base.alpha_composite(img)
    return base


def _grid_overlay(img: Image.Image, *, tile_w: int, tile_h: int, grid: GridSpec) -> Image.Image:
    out = img.convert("RGBA").copy()
    draw = ImageDraw.Draw(out, "RGBA")
    font = _load_font(10)

    grid_c = (255, 255, 255, 90)
    bold = (47, 230, 255, 170)
    ox, oy = grid.origin_x, grid.origin_y
    w = grid.grid_w * tile_w
    h = grid.grid_h * tile_h

    for c in range(grid.grid_w + 1):
        x = ox + c * tile_w
        draw.line([(x, oy), (x, oy + h)], fill=grid_c, width=1)
    for r in range(grid.grid_h + 1):
        y = oy + r * tile_h
        draw.line([(ox, y), (ox + w, y)], fill=grid_c, width=1)
    draw.rectangle([ox, oy, ox + w, oy + h], outline=bold, width=2)

    if grid.pad_top:
        draw.rectangle([0, 0, grid.canvas_w, grid.pad_top], fill=(0, 0, 0, 60))
        _draw_text(draw, (4, 1), f"top padding ({grid.pad_top}px)", fill=(255, 255, 255, 220), outline=(0, 0, 0, 255), font=font)
    if grid.pad_bottom:
        y0 = grid.canvas_h - grid.pad_bottom
        draw.rectangle([0, y0, grid.canvas_w, grid.canvas_h], fill=(0, 0, 0, 60))
        _draw_text(
            draw,
            (4, y0 + 1),
            f"bottom padding ({grid.pad_bottom}px)",
            fill=(255, 255, 255, 220),
            outline=(0, 0, 0, 255),
            font=font,
        )
    return out


def _mse_rgb(a: list[tuple[int, int, int, int]], b: list[tuple[int, int, int, int]]) -> float:
    if len(a) != len(b):
        raise ValueError("patch size mismatch")
    s = 0
    for (ar, ag, ab, _aa), (br, bg, bb, _ba) in zip(a, b):
        dr = ar - br
        dg = ag - bg
        db = ab - bb
        s += dr * dr + dg * dg + db * db
    return s / (len(a) * 3)


def _composite_patch(backdrop: list[tuple[int, int, int, int]], tile: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    out: list[tuple[int, int, int, int]] = []
    for (br, bg, bb, ba), (tr, tg, tb, ta) in zip(backdrop, tile):
        if ta == 0:
            out.append((br, bg, bb, ba))
            continue
        if ta == 255:
            out.append((tr, tg, tb, 255))
            continue
        a = ta / 255.0
        r = int(tr * a + br * (1 - a))
        g = int(tg * a + bg * (1 - a))
        b = int(tb * a + bb * (1 - a))
        out.append((r, g, b, 255))
    return out


def _non_empty_tile_ids(sheet: Image.Image, ts: TilesetMeta) -> list[int]:
    ids: list[int] = []
    for tid in range(1, ts.columns * ts.rows + 1):
        patch = sheet.crop(ts.crop_box(tid)).getdata()
        if any(px[3] > 0 for px in patch):
            ids.append(tid)
    return ids


def _new_layer(w: int, h: int) -> list[list[int]]:
    return [[0 for _ in range(w)] for _ in range(h)]


def _apply_placement(grid: list[list[int]], *, x: int, y: int, tid: int) -> None:
    if 0 <= y < len(grid) and 0 <= x < len(grid[y]):
        grid[y][x] = tid


def _write_step(path: Path, name: str, placements: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"name": name, "placements": placements}
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Infer a tilemap.json from reference + tileset (best-effort).")
    parser.add_argument("--manifest", type=Path, required=True, help="assets_index.json")
    parser.add_argument("--tileset", type=str, required=True, help="Tileset key (supports dot paths).")
    parser.add_argument("--root", type=Path, default=(Path("assets") if Path("assets").exists() else None), help="Optional asset root for resolving manifest paths.")

    parser.add_argument("--reference", type=Path, required=True, help="Reference PNG (often high-res).")
    parser.add_argument("--downscale", type=int, default=0, help="Optional integer downscale factor (0=infer).")
    parser.add_argument("--max-downscale", type=int, default=16, help="Max factor to try when inferring downscale.")
    parser.add_argument("--padding-side", choices=["auto", "top", "bottom"], default="auto")

    parser.add_argument("--backdrop", type=Path, default=None, help="Optional backdrop PNG (hi-res or small).")
    parser.add_argument("--backdrop-layers", nargs="*", type=Path, default=[], help="Optional backdrop layers to alpha-composite (in order).")
    parser.add_argument("--bg", type=str, default="#00000000", help="Fallback bg color if no backdrop (#RRGGBB or #RRGGBBAA).")

    parser.add_argument("--layers", type=str, default="background,ground,foreground", help="Comma-separated layer order.")
    parser.add_argument("--min-improve", type=float, default=1.0, help="Min MSE improvement over empty to place a tile.")
    parser.add_argument("--candidate-ids", type=Path, default=None, help="Optional JSON list of tile IDs to consider.")
    parser.add_argument("--from-top", action="store_true", help="Fill rows top->bottom (default is bottom->top).")

    parser.add_argument("--out-dir", type=Path, default=Path("tmp/tile_recon"))
    parser.add_argument("--out-tilemap", type=Path, default=None, help="Output tilemap.json (default: <out-dir>/tilemap.json).")
    parser.add_argument("--out-map", type=Path, default=None, help="Output layered base map JSON (default: <out-dir>/reconstruction_map.json).")
    parser.add_argument("--out-resolved-map", type=Path, default=None, help="Output resolved layered map JSON (default: <out-dir>/resolved_map.json).")
    parser.add_argument("--out-steps", type=Path, default=None, help="Steps directory (default: <out-dir>/steps).")
    parser.add_argument("--out-reference-small", type=Path, default=None, help="Output small reference (default: <out-dir>/reference_small.png).")
    parser.add_argument("--out-reference-grid", type=Path, default=None, help="Output grid overlay (default: <out-dir>/reference_grid.png).")
    args = parser.parse_args()

    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    out_tilemap = args.out_tilemap or (out_dir / "tilemap.json")
    out_map = args.out_map or (out_dir / "reconstruction_map.json")
    out_resolved = args.out_resolved_map or (out_dir / "resolved_map.json")
    out_steps = args.out_steps or (out_dir / "steps")
    out_ref_small = args.out_reference_small or (out_dir / "reference_small.png")
    out_ref_grid = args.out_reference_grid or (out_dir / "reference_grid.png")

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise SystemExit("Manifest JSON must be an object.")

    ts = _tileset_meta_from_manifest(args.manifest, manifest, args.tileset, root_override=args.root)
    reference = Image.open(args.reference).convert("RGBA")

    ds = int(args.downscale)
    if ds <= 0:
        ds = _infer_downscale(reference, tile_w=ts.tile_w, tile_h=ts.tile_h, max_factor=int(args.max_downscale))

    w, h = reference.size
    if w % ds != 0 or h % ds != 0:
        raise SystemExit(f"Reference size {w}x{h} is not divisible by downscale {ds}.")

    reference_small = reference.resize((w // ds, h // ds), resample=Image.Resampling.NEAREST)
    reference_small.save(out_ref_small)

    # Infer grid, padding, origin in small space.
    grid = _infer_grid(reference_small, tile_w=ts.tile_w, tile_h=ts.tile_h, padding_side=args.padding_side)

    # Compose backdrop in small space.
    bg_rgba = _parse_hex_color(args.bg)
    backdrop_small = _compose_backdrop(
        reference_size=reference.size,
        reference_small_size=reference_small.size,
        downscale=ds,
        backdrop=args.backdrop,
        backdrop_layers=list(args.backdrop_layers),
        bg_rgba=bg_rgba,
    )

    # Export reference grid overlay (small).
    grid_img = _grid_overlay(reference_small, tile_w=ts.tile_w, tile_h=ts.tile_h, grid=grid)
    grid_img.save(out_ref_grid)

    layer_names = [s.strip() for s in args.layers.split(",") if s.strip()]
    if not layer_names:
        raise SystemExit("--layers must include at least one layer name.")

    base_map: dict[str, Any] = {
        "meta": {
            "gridWidth": grid.grid_w,
            "gridHeight": grid.grid_h,
            "tileOriginX": grid.origin_x,
            "tileOriginY": grid.origin_y,
            "canvasWidth": grid.canvas_w,
            "canvasHeight": grid.canvas_h,
            "layerOrder": layer_names,
            "downscale": ds,
        },
        "layers": {name: _new_layer(grid.grid_w, grid.grid_h) for name in layer_names},
    }
    out_map.write_text(json.dumps(base_map, indent=2) + "\n", encoding="utf-8")

    # Candidate tiles + cache.
    with Image.open(ts.path) as sheet:
        sheet = sheet.convert("RGBA")
        candidates = _non_empty_tile_ids(sheet, ts)
        if args.candidate_ids is not None:
            payload = json.loads(args.candidate_ids.read_text(encoding="utf-8"))
            if not isinstance(payload, list) or not all(isinstance(x, (int, float)) for x in payload):
                raise SystemExit("--candidate-ids must be a JSON list of integers.")
            candidates = [int(x) for x in payload if int(x) > 0]
        tile_cache = {tid: list(sheet.crop(ts.crop_box(tid)).getdata()) for tid in candidates}

        # Working canvas for matching.
        current = backdrop_small.copy().convert("RGBA")
        layers_out: dict[str, list[list[int]]] = {name: _new_layer(grid.grid_w, grid.grid_h) for name in layer_names}

        out_steps.mkdir(parents=True, exist_ok=True)
        _write_step(out_steps / "step_00.json", "step_00 (empty)", [])

        step_idx = 1
        y_iter: Iterable[int] = range(0, grid.grid_h) if args.from_top else range(grid.grid_h - 1, -1, -1)

        for y in y_iter:
            placements: list[dict[str, Any]] = []
            row_top = grid.origin_y + y * ts.tile_h
            for layer in layer_names:
                for x in range(grid.grid_w):
                    left = grid.origin_x + x * ts.tile_w
                    target_patch = list(reference_small.crop((left, row_top, left + ts.tile_w, row_top + ts.tile_h)).getdata())
                    base_patch = list(current.crop((left, row_top, left + ts.tile_w, row_top + ts.tile_h)).getdata())

                    empty_score = _mse_rgb(base_patch, target_patch)
                    best_tid = 0
                    best_score = empty_score
                    for tid in candidates:
                        comp = _composite_patch(base_patch, tile_cache[tid])
                        score = _mse_rgb(comp, target_patch)
                        if score < best_score:
                            best_score = score
                            best_tid = tid

                    if best_tid > 0 and (empty_score - best_score) >= float(args.min_improve):
                        placements.append({"layer": layer, "x": x, "y": y, "tile_id": best_tid})
                        _apply_placement(layers_out[layer], x=x, y=y, tid=best_tid)
                        tile_img = sheet.crop(ts.crop_box(best_tid))
                        current.alpha_composite(tile_img, dest=(left, row_top))

            _write_step(out_steps / f"step_{step_idx:02d}.json", f"row y={y}", placements)
            step_idx += 1

    # Write resolved layered map.
    resolved = dict(base_map)
    resolved["layers"] = layers_out
    out_resolved.write_text(json.dumps(resolved, indent=2) + "\n", encoding="utf-8")

    # Write a single-layer tilemap.json (flatten by layer order, later layers override earlier).
    data_out = _new_layer(grid.grid_w, grid.grid_h)
    for lname in layer_names:
        g2 = layers_out.get(lname)
        if g2 is None:
            continue
        for y in range(grid.grid_h):
            for x in range(grid.grid_w):
                tid = int(g2[y][x])
                if tid > 0:
                    data_out[y][x] = tid

    tilemap = {
        "meta": {
            "version": 1,
            "tileset": args.tileset,
            "tileWidth": ts.tile_w,
            "tileHeight": ts.tile_h,
            "width": grid.grid_w,
            "height": grid.grid_h,
        },
        "data": data_out,
    }
    out_tilemap.write_text(json.dumps(tilemap, indent=2) + "\n", encoding="utf-8")

    print(f"Wrote {out_ref_small}")
    print(f"Wrote {out_ref_grid}")
    print(f"Wrote {out_map}")
    print(f"Wrote {out_steps} (steps)")
    print(f"Wrote {out_resolved}")
    print(f"Wrote {out_tilemap}")


if __name__ == "__main__":
    main()

