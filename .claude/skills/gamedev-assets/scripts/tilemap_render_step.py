# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
"""
Render a tilemap reconstruction step against a reference image.

Outputs (by default, alongside --out-prefix):
  - <out>_render.png
  - <out>_debug.png                 (tile IDs + map coords + tileset coords)
  - <out>_diff.png                  (reference-colored overlay diff)
  - <out>_diff_tiles_debug.png      (debug + outlines on tiles with diffs)
  - <out>_diff_tiles.json           (list of mismatching {x,y} tile cells)

This tool is engine-agnostic and manifest-driven (assets_index.json).
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFont


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


def _resolve_asset_path(manifest_path: Path, manifest: dict[str, Any], rel: str, *, root_override: Path | None) -> Path:
    manifest_dir = manifest_path.parent.resolve()
    meta = manifest.get("meta")
    root = meta.get("root") if isinstance(meta, dict) else None
    base = (manifest_dir / root).resolve() if isinstance(root, str) else manifest_dir
    p = Path(rel)
    if p.is_absolute():
        return p.resolve()
    extra_assets_root = (Path.cwd() / "assets").resolve() if (Path.cwd() / "assets").exists() else None
    candidates = [
        (root_override / p).resolve() if root_override is not None else None,
        (base / p).resolve(),
        (manifest_dir / p).resolve(),
        (Path.cwd() / p).resolve(),
        (extra_assets_root / p).resolve() if extra_assets_root is not None else None,
    ]
    for c in candidates:
        if c is not None and c.exists():
            return c
    return candidates[0]


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


def _int(v: Any, default: int) -> int:
    if isinstance(v, (int, float)):
        return int(v)
    return default


@dataclass(frozen=True)
class TilesetMeta:
    path: Path
    tile_w: int
    tile_h: int
    columns: int
    rows: int
    margin: int
    spacing: int

    def tile_id_from_col_row(self, col0: int, row0: int) -> int:
        if col0 < 0 or row0 < 0 or col0 >= self.columns or row0 >= self.rows:
            return 0
        return row0 * self.columns + col0 + 1

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
class MapMeta:
    grid_w: int
    grid_h: int
    origin_x: int
    origin_y: int
    canvas_w: int
    canvas_h: int


def _parse_hex_color(s: str) -> tuple[int, int, int, int]:
    t = s.strip()
    if not t.startswith("#") or len(t) not in (7, 9):
        raise SystemExit("Color must be #RRGGBB or #RRGGBBAA")
    r = int(t[1:3], 16)
    g = int(t[3:5], 16)
    b = int(t[5:7], 16)
    a = int(t[7:9], 16) if len(t) == 9 else 255
    return (r, g, b, a)


def _normalize_grid(data: Any, w: int, h: int) -> list[list[int]]:
    out = [[0 for _ in range(w)] for _ in range(h)]
    if not isinstance(data, list):
        return out
    for y in range(min(h, len(data))):
        row = data[y]
        if not isinstance(row, list):
            continue
        for x in range(min(w, len(row))):
            v = row[x]
            if isinstance(v, (int, float)):
                out[y][x] = int(v)
    return out


def _load_map_payload(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit(f"Map must be a JSON object: {path}")
    return payload


def _map_is_layered(payload: dict[str, Any]) -> bool:
    layers = payload.get("layers")
    return isinstance(layers, dict)


def _extract_map_meta(payload: dict[str, Any], *, default_tile_w: int, default_tile_h: int) -> MapMeta:
    meta = payload.get("meta")
    if not isinstance(meta, dict):
        meta = {}

    origin_x = _int(meta.get("tileOriginX"), 0)
    origin_y = _int(meta.get("tileOriginY"), 0)

    # Determine grid size.
    grid_w = 0
    grid_h = 0
    if _map_is_layered(payload):
        grid_w = _int(meta.get("gridWidth") or meta.get("width"), 0)
        grid_h = _int(meta.get("gridHeight") or meta.get("height"), 0)
        layers = payload["layers"]
        # Use the largest dimensions across layers.
        for _name, layer in layers.items():
            if not isinstance(layer, list):
                continue
            grid_h = max(grid_h, len(layer))
            for row in layer:
                if isinstance(row, list):
                    grid_w = max(grid_w, len(row))
    else:
        data = payload.get("data")
        if isinstance(data, list):
            grid_h = len(data)
            grid_w = max((len(r) for r in data if isinstance(r, list)), default=0)
        # Allow meta overrides for width/height.
        grid_w = _int(meta.get("gridWidth") or meta.get("width"), grid_w)
        grid_h = _int(meta.get("gridHeight") or meta.get("height"), grid_h)

    if grid_w <= 0 or grid_h <= 0:
        raise SystemExit("Map grid dimensions are missing or invalid.")

    canvas_w = _int(meta.get("canvasWidth") or meta.get("pixelWidth"), origin_x + grid_w * default_tile_w)
    canvas_h = _int(meta.get("canvasHeight") or meta.get("pixelHeight"), origin_y + grid_h * default_tile_h)
    if canvas_w <= 0 or canvas_h <= 0:
        raise SystemExit("Map canvas size is missing/invalid (canvasWidth/canvasHeight).")

    return MapMeta(grid_w=grid_w, grid_h=grid_h, origin_x=origin_x, origin_y=origin_y, canvas_w=canvas_w, canvas_h=canvas_h)


def _default_layer_order(layers: dict[str, Any]) -> list[str]:
    # Prefer common conventions if present, else sorted keys.
    preferred = ["background", "ground", "midground", "foreground", "ui"]
    out = [k for k in preferred if k in layers]
    rest = [k for k in sorted(layers.keys()) if k not in out]
    return out + rest


def _load_steps(steps_dir: Path, max_step: int) -> list[dict[str, Any]]:
    if max_step < 0:
        return []
    steps: list[dict[str, Any]] = []
    for i in range(max_step + 1):
        p = steps_dir / f"step_{i:02d}.json"
        if not p.exists():
            raise SystemExit(f"Missing step file: {p}")
        payload = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise SystemExit(f"Invalid step JSON: {p}")
        steps.append(payload)
    return steps


def _apply_steps_to_layers(layers: dict[str, Any], *, steps: list[dict[str, Any]]) -> None:
    for step in steps:
        placements = step.get("placements")
        if not isinstance(placements, list):
            continue
        for pl in placements:
            if not isinstance(pl, dict):
                continue
            layer = pl.get("layer")
            x = pl.get("x")
            y = pl.get("y")
            tid = pl.get("tile_id")
            if not isinstance(layer, str) or layer not in layers:
                raise SystemExit(f"Unknown layer in placement: {layer!r}")
            if not isinstance(x, int) or not isinstance(y, int) or not isinstance(tid, int):
                raise SystemExit(f"Invalid placement (needs ints): {pl}")
            grid = layers[layer]
            if not isinstance(grid, list) or y < 0 or y >= len(grid) or not isinstance(grid[y], list):
                raise SystemExit(f"Placement out of bounds (y): {pl}")
            if x < 0 or x >= len(grid[y]):
                raise SystemExit(f"Placement out of bounds (x): {pl}")
            grid[y][x] = tid


def _tileset_meta_from_manifest(
    manifest_path: Path,
    manifest: dict[str, Any],
    tileset_key: str,
    *,
    root_override: Path | None,
) -> TilesetMeta:
    ts = _lookup_tileset(manifest, tileset_key)
    rel = str(ts["path"])
    path = _resolve_asset_path(manifest_path, manifest, rel, root_override=root_override)
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


def _render(
    *,
    tileset_meta: TilesetMeta,
    sheet: Image.Image,
    map_meta: MapMeta,
    layers: dict[str, list[list[int]]],
    layer_order: list[str],
    backdrop: Image.Image | None,
    bg_rgba: tuple[int, int, int, int],
) -> tuple[Image.Image, list[tuple[int, int, int, int, int]]]:
    canvas = Image.new("RGBA", (map_meta.canvas_w, map_meta.canvas_h), bg_rgba)
    if backdrop is not None:
        if backdrop.size != canvas.size:
            raise SystemExit(f"Backdrop size {backdrop.size} must match canvas size {canvas.size}")
        canvas = backdrop.convert("RGBA").copy()

    # Keep only the topmost tile label for each (x,y) cell (the visible tile).
    label_by_cell: dict[tuple[int, int], tuple[int, int, int]] = {}

    for layer_name in layer_order:
        grid = layers.get(layer_name)
        if grid is None:
            continue
        for y in range(map_meta.grid_h):
            if y >= len(grid) or not isinstance(grid[y], list):
                continue
            row = grid[y]
            for x in range(map_meta.grid_w):
                if x >= len(row):
                    continue
                tid = int(row[x])
                if tid <= 0:
                    continue
                box = tileset_meta.crop_box(tid)
                tile = sheet.crop(box)
                dx = map_meta.origin_x + x * tileset_meta.tile_w
                dy = map_meta.origin_y + y * tileset_meta.tile_h
                canvas.alpha_composite(tile, dest=(dx, dy))
                tsc, tsr = tileset_meta.col_row_from_tile_id(tid)
                label_by_cell[(x, y)] = (tid, tsc, tsr)

    labels: list[tuple[int, int, int, int, int]] = []
    for (x, y), (tid, tsc, tsr) in sorted(label_by_cell.items()):
        labels.append((x, y, tid, tsc, tsr))
    return canvas, labels


def _add_debug_overlay(img_scaled: Image.Image, *, map_meta: MapMeta, tileset_meta: TilesetMeta, labels: list[tuple[int, int, int, int, int]], scale: int) -> Image.Image:
    out = img_scaled.copy().convert("RGBA")
    draw = ImageDraw.Draw(out, "RGBA")
    font = _load_font(max(10, 10 * scale // 3))

    grid = (255, 255, 255, 70)
    bold = (47, 230, 255, 150)
    step_x = tileset_meta.tile_w * scale
    step_y = tileset_meta.tile_h * scale
    ox = map_meta.origin_x * scale
    oy = map_meta.origin_y * scale

    for c in range(map_meta.grid_w + 1):
        x = ox + c * step_x
        draw.line([(x, oy), (x, oy + map_meta.grid_h * step_y)], fill=grid, width=1)
    for r in range(map_meta.grid_h + 1):
        y = oy + r * step_y
        draw.line([(ox, y), (ox + map_meta.grid_w * step_x, y)], fill=grid, width=1)
    draw.rectangle([ox, oy, ox + map_meta.grid_w * step_x, oy + map_meta.grid_h * step_y], outline=bold, width=2)

    for x, y, tid, tsc, tsr in labels:
        px = ox + x * step_x + 3
        py = oy + y * step_y + 3
        _draw_text(draw, (px, py), f"{x},{y}", fill=(255, 255, 255, 255), outline=(0, 0, 0, 255), font=font)
        _draw_text(draw, (px, py + font.size + 1), f"id:{tid}", fill=(255, 255, 255, 255), outline=(0, 0, 0, 255), font=font)
        _draw_text(draw, (px, py + (font.size + 1) * 2), f"ts:{tsc},{tsr}", fill=(255, 255, 255, 255), outline=(0, 0, 0, 255), font=font)

    return out


def _diff_overlay(
    *,
    reference: Image.Image,
    rendered: Image.Image,
    tile_area: tuple[int, int, int, int],
    threshold: int,
    color_rgba: tuple[int, int, int, int],
) -> tuple[Image.Image, Image.Image]:
    # Returns (diff_visual_full, diff_mask_full)
    ref_crop = reference.crop(tile_area).convert("RGB")
    out_crop = rendered.crop(tile_area).convert("RGB")
    diff_rgb = ImageChops.difference(ref_crop, out_crop)

    r, g, b = diff_rgb.split()
    mx = ImageChops.lighter(ImageChops.lighter(r, g), b)
    thr = 0 if threshold < 0 else (255 if threshold > 255 else threshold)
    mask = mx.point(lambda v: 255 if v > thr else 0)

    base = reference.crop(tile_area).convert("RGBA")
    overlay = Image.new("RGBA", base.size, color_rgba)
    base.paste(overlay, (0, 0), mask=mask)

    diff_full = Image.new("RGBA", reference.size, (0, 0, 0, 255))
    diff_full.paste(base, tile_area[:2])

    mask_full = Image.new("L", reference.size, 0)
    mask_full.paste(mask, tile_area[:2])
    return diff_full, mask_full


def _tile_diff_cells(mask_full: Image.Image, *, map_meta: MapMeta, tileset_meta: TilesetMeta, scale: int) -> list[dict[str, int]]:
    ox = map_meta.origin_x * scale
    oy = map_meta.origin_y * scale
    step_x = tileset_meta.tile_w * scale
    step_y = tileset_meta.tile_h * scale

    tiles: list[dict[str, int]] = []
    for y in range(map_meta.grid_h):
        for x in range(map_meta.grid_w):
            box = (ox + x * step_x, oy + y * step_y, ox + (x + 1) * step_x, oy + (y + 1) * step_y)
            if mask_full.crop(box).getbbox() is None:
                continue
            tiles.append({"x": x, "y": y})
    return tiles


def main() -> None:
    parser = argparse.ArgumentParser(description="Render a tilemap reconstruction step + debug/diff outputs.")
    parser.add_argument("--manifest", type=Path, required=True, help="assets_index.json")
    parser.add_argument("--tileset", type=str, required=True, help="Tileset key (supports dot paths).")
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="Optional asset root folder to resolve manifest `path`s (useful when manifest is not adjacent to assets).",
    )
    parser.add_argument("--map", type=Path, required=True, help="Base map JSON (layered or {meta,data}).")
    parser.add_argument("--steps", type=Path, default=None, help="Directory with step_XX.json files.")
    parser.add_argument("--step", type=int, default=-1, help="Apply steps 0..N; -1 means none.")
    parser.add_argument("--out-prefix", type=Path, default=Path("tmp/recon_step"))
    parser.add_argument("--backdrop", type=Path, default=None, help="Optional backdrop PNG (must match canvas size).")
    parser.add_argument("--bg", type=str, default="#00000000", help="Background color if no backdrop (#RRGGBB or #RRGGBBAA).")
    parser.add_argument("--scale", type=int, default=6, help="Scale factor for output (NEAREST).")
    parser.add_argument("--layer-order", type=str, default="", help="Comma-separated layer draw order (layered maps only).")
    parser.add_argument("--reference", type=Path, default=None, help="Reference PNG (required for diff outputs).")
    parser.add_argument(
        "--out-resolved-map",
        type=Path,
        default=None,
        help="Optional output path to write the resolved layered map JSON (after applying steps).",
    )
    parser.add_argument(
        "--out-tilemap",
        type=Path,
        default=None,
        help="Optional output path to write a single-layer tilemap.json compatible with asset_tilemap_editor.py.",
    )
    parser.add_argument(
        "--tilemap-mode",
        choices=["flatten", "layer"],
        default="flatten",
        help="When writing --out-tilemap from layered maps: flatten uses layer order to pick the topmost non-empty tile; layer exports a single named layer.",
    )
    parser.add_argument(
        "--tilemap-layer",
        type=str,
        default="",
        help="Layer name to export when --tilemap-mode=layer.",
    )

    parser.add_argument("--write-diff", action="store_true")
    parser.add_argument("--diff-threshold", type=int, default=6)
    parser.add_argument(
        "--diff-tile-threshold",
        type=int,
        default=None,
        help="Threshold for marking a tile as mismatching (defaults to --diff-threshold).",
    )
    parser.add_argument("--diff-overlay-color", type=str, default="#ff4d6d")
    parser.add_argument("--diff-overlay-alpha", type=int, default=120)
    parser.add_argument("--write-diff-tiles-debug", action="store_true")
    parser.add_argument("--diff-tile-outline", type=str, default="#00ffff")
    parser.add_argument("--diff-tile-width", type=int, default=3)
    args = parser.parse_args()

    manifest_path = args.manifest
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise SystemExit("Manifest JSON must be an object at top-level.")

    tileset_meta = _tileset_meta_from_manifest(manifest_path, manifest, args.tileset, root_override=args.root)
    with Image.open(tileset_meta.path) as sheet:
        sheet = sheet.convert("RGBA")

        map_payload = _load_map_payload(args.map)

        backdrop_img: Image.Image | None = None
        if args.backdrop:
            backdrop_img = Image.open(args.backdrop).convert("RGBA")
            # If the map doesn't specify canvas size, prefer the backdrop size.
            meta = map_payload.get("meta")
            if isinstance(meta, dict):
                meta.setdefault("canvasWidth", backdrop_img.width)
                meta.setdefault("canvasHeight", backdrop_img.height)

        map_meta = _extract_map_meta(map_payload, default_tile_w=tileset_meta.tile_w, default_tile_h=tileset_meta.tile_h)
        bg_rgba = _parse_hex_color(args.bg)

        # Normalize layers.
        if _map_is_layered(map_payload):
            raw_layers = map_payload["layers"]
            layers: dict[str, list[list[int]]] = {}
            for name, grid in raw_layers.items():
                if not isinstance(name, str):
                    continue
                layers[name] = _normalize_grid(grid, map_meta.grid_w, map_meta.grid_h)
        else:
            layers = {"main": _normalize_grid(map_payload.get("data"), map_meta.grid_w, map_meta.grid_h)}

        # Apply steps if provided.
        if args.steps is not None and args.step >= 0:
            if not _map_is_layered(map_payload):
                raise SystemExit("--steps requires a layered map (map JSON with `layers`).")
            steps = _load_steps(args.steps, args.step)
            _apply_steps_to_layers(layers, steps=steps)

        # Determine layer order.
        if args.layer_order.strip():
            order = [s.strip() for s in args.layer_order.split(",") if s.strip()]
        else:
            meta = map_payload.get("meta")
            meta_order = meta.get("layerOrder") if isinstance(meta, dict) else None
            if isinstance(meta_order, list) and all(isinstance(x, str) for x in meta_order):
                order = list(meta_order)
            else:
                order = _default_layer_order(layers)

        # Render in base space and scale.
        rendered_small, labels = _render(
            tileset_meta=tileset_meta,
            sheet=sheet,
            map_meta=map_meta,
            layers=layers,
            layer_order=order,
            backdrop=backdrop_img,
            bg_rgba=bg_rgba,
        )

    scale = max(1, int(args.scale))
    rendered = rendered_small.resize((rendered_small.width * scale, rendered_small.height * scale), resample=Image.Resampling.NEAREST)

    out_prefix = args.out_prefix
    out_prefix.parent.mkdir(parents=True, exist_ok=True)
    out_render = out_prefix.parent / f"{out_prefix.name}_render.png"
    out_debug = out_prefix.parent / f"{out_prefix.name}_debug.png"
    rendered.save(out_render)

    debug = _add_debug_overlay(rendered, map_meta=map_meta, tileset_meta=tileset_meta, labels=labels, scale=scale)
    debug.save(out_debug)

    print(f"Wrote {out_render}")
    print(f"Wrote {out_debug}")

    # Optional: write resolved map payloads for downstream tools/editing.
    if args.out_resolved_map is not None:
        # Preserve existing meta, but ensure common fields exist.
        meta = map_payload.get("meta")
        meta = meta if isinstance(meta, dict) else {}
        meta = dict(meta)
        meta.setdefault("gridWidth", map_meta.grid_w)
        meta.setdefault("gridHeight", map_meta.grid_h)
        meta.setdefault("tileOriginX", map_meta.origin_x)
        meta.setdefault("tileOriginY", map_meta.origin_y)
        meta.setdefault("canvasWidth", map_meta.canvas_w)
        meta.setdefault("canvasHeight", map_meta.canvas_h)
        meta.setdefault("layerOrder", order)

        out_payload: dict[str, Any]
        if _map_is_layered(map_payload):
            out_payload = {"meta": meta, "layers": layers}
        else:
            out_payload = {"meta": meta, "data": layers.get("main", [])}

        args.out_resolved_map.parent.mkdir(parents=True, exist_ok=True)
        args.out_resolved_map.write_text(json.dumps(out_payload, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote {args.out_resolved_map}")

    if args.out_tilemap is not None:
        # Export a single-layer `{meta,data}` tilemap for the tilemap editor.
        meta_out = {
            "version": 1,
            "tileset": args.tileset,
            "tileWidth": tileset_meta.tile_w,
            "tileHeight": tileset_meta.tile_h,
            "width": map_meta.grid_w,
            "height": map_meta.grid_h,
        }
        if not _map_is_layered(map_payload):
            data_out = layers.get("main", _normalize_grid(map_payload.get("data"), map_meta.grid_w, map_meta.grid_h))
        else:
            if args.tilemap_mode == "layer":
                name = args.tilemap_layer.strip()
                if not name or name not in layers:
                    raise SystemExit("--tilemap-mode=layer requires --tilemap-layer to name an existing layer.")
                data_out = layers[name]
            else:
                # Flatten: later layers in order override earlier ones when non-zero.
                data_out = [[0 for _ in range(map_meta.grid_w)] for _ in range(map_meta.grid_h)]
                for lname in order:
                    grid = layers.get(lname)
                    if grid is None:
                        continue
                    for y in range(map_meta.grid_h):
                        for x in range(map_meta.grid_w):
                            tid = int(grid[y][x])
                            if tid > 0:
                                data_out[y][x] = tid

        args.out_tilemap.parent.mkdir(parents=True, exist_ok=True)
        args.out_tilemap.write_text(json.dumps({"meta": meta_out, "data": data_out}, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote {args.out_tilemap}")

    if args.write_diff or args.write_diff_tiles_debug:
        if args.reference is None:
            raise SystemExit("--reference is required when writing diff outputs.")
        reference = Image.open(args.reference).convert("RGBA")
        if reference.size != rendered.size:
            raise SystemExit(f"Reference size mismatch: {reference.size} vs render {rendered.size}")

        a = max(0, min(255, int(args.diff_overlay_alpha)))
        c = args.diff_overlay_color.strip()
        if not (len(c) == 7 and c.startswith("#")):
            raise SystemExit("--diff-overlay-color must be #RRGGBB")
        cr = int(c[1:3], 16)
        cg = int(c[3:5], 16)
        cb = int(c[5:7], 16)
        overlay_rgba = (cr, cg, cb, a)

        tile_area = (
            map_meta.origin_x * scale,
            map_meta.origin_y * scale,
            (map_meta.origin_x + map_meta.grid_w * tileset_meta.tile_w) * scale,
            (map_meta.origin_y + map_meta.grid_h * tileset_meta.tile_h) * scale,
        )

        diff_img, diff_mask = _diff_overlay(
            reference=reference,
            rendered=rendered,
            tile_area=tile_area,
            threshold=int(args.diff_threshold),
            color_rgba=overlay_rgba,
        )

        out_diff = out_prefix.parent / f"{out_prefix.name}_diff.png"
        diff_img.save(out_diff)
        print(f"Wrote {out_diff}")

        if args.write_diff_tiles_debug:
            tile_thr = int(args.diff_threshold) if args.diff_tile_threshold is None else int(args.diff_tile_threshold)
            # Recompute a mask for tile-cell mismatch detection at tile_thr.
            ref_crop = reference.crop(tile_area).convert("RGB")
            out_crop = rendered.crop(tile_area).convert("RGB")
            diff_rgb = ImageChops.difference(ref_crop, out_crop)
            r, g, b = diff_rgb.split()
            mx = ImageChops.lighter(ImageChops.lighter(r, g), b)
            thr = 0 if tile_thr < 0 else (255 if tile_thr > 255 else tile_thr)
            mask_tile = mx.point(lambda v: 255 if v > thr else 0)
            mask_full = Image.new("L", reference.size, 0)
            mask_full.paste(mask_tile, tile_area[:2])

            tiles = _tile_diff_cells(mask_full, map_meta=map_meta, tileset_meta=tileset_meta, scale=scale)

            outline = args.diff_tile_outline.strip()
            if not (len(outline) == 7 and outline.startswith("#")):
                raise SystemExit("--diff-tile-outline must be #RRGGBB")
            or_ = int(outline[1:3], 16)
            og_ = int(outline[3:5], 16)
            ob_ = int(outline[5:7], 16)
            width = max(1, int(args.diff_tile_width))

            out_tiles = debug.copy().convert("RGBA")
            d = ImageDraw.Draw(out_tiles, "RGBA")
            ox = map_meta.origin_x * scale
            oy = map_meta.origin_y * scale
            step_x = tileset_meta.tile_w * scale
            step_y = tileset_meta.tile_h * scale
            for t in tiles:
                x = t["x"]
                y = t["y"]
                x0 = ox + x * step_x
                y0 = oy + y * step_y
                x1 = x0 + step_x
                y1 = y0 + step_y
                d.rectangle([x0 + 1, y0 + 1, x1 - 2, y1 - 2], outline=(or_, og_, ob_, 230), width=width)

            font = _load_font(max(12, 12 * scale // 3))
            _draw_text(
                d,
                (6, 6),
                f"diff tiles: {len(tiles)} (tile_thr>{thr})",
                fill=(255, 255, 255, 240),
                outline=(0, 0, 0, 255),
                font=font,
            )

            out_tiles_debug_path = out_prefix.parent / f"{out_prefix.name}_diff_tiles_debug.png"
            out_tiles.save(out_tiles_debug_path)
            print(f"Wrote {out_tiles_debug_path}")

            out_tiles_json_path = out_prefix.parent / f"{out_prefix.name}_diff_tiles.json"
            out_tiles_json_path.write_text(json.dumps({"tiles": tiles}, indent=2) + "\n", encoding="utf-8")
            print(f"Wrote {out_tiles_json_path}")


if __name__ == "__main__":
    main()
