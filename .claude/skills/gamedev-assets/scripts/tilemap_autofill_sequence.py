# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0.0"]
# ///
"""
Generate a full row-by-row step sequence to reconstruct a reference image from a tileset.

This uses the same naive brute-force matching approach as tilemap_autofill_row.py.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image


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


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


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


def _extract_map_meta(payload: dict[str, Any], *, tile_w: int, tile_h: int) -> MapMeta:
    meta = payload.get("meta")
    if not isinstance(meta, dict):
        meta = {}
    origin_x = _int(meta.get("tileOriginX"), 0)
    origin_y = _int(meta.get("tileOriginY"), 0)
    layers = payload.get("layers")
    if not isinstance(layers, dict):
        raise SystemExit("Expected layered map JSON with `layers`.")

    grid_w = _int(meta.get("gridWidth") or meta.get("width"), 0)
    grid_h = _int(meta.get("gridHeight") or meta.get("height"), 0)
    for _name, layer in layers.items():
        if not isinstance(layer, list):
            continue
        grid_h = max(grid_h, len(layer))
        for row in layer:
            if isinstance(row, list):
                grid_w = max(grid_w, len(row))

    if grid_w <= 0 or grid_h <= 0:
        raise SystemExit("Map grid dimensions are missing or invalid.")

    canvas_w = _int(meta.get("canvasWidth") or meta.get("pixelWidth"), origin_x + grid_w * tile_w)
    canvas_h = _int(meta.get("canvasHeight") or meta.get("pixelHeight"), origin_y + grid_h * tile_h)
    return MapMeta(grid_w=grid_w, grid_h=grid_h, origin_x=origin_x, origin_y=origin_y, canvas_w=canvas_w, canvas_h=canvas_h)


def _tileset_meta_from_manifest(
    manifest_path: Path,
    manifest: dict[str, Any],
    tileset_key: str,
    *,
    root_override: Path | None,
) -> TilesetMeta:
    ts = _lookup_tileset(manifest, tileset_key)
    path = _resolve_asset_path(manifest_path, manifest, str(ts["path"]), root_override=root_override)
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


def _write_step(path: Path, name: str, placements: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"name": name, "placements": placements}
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Autofill a full row-by-row step sequence.")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--tileset", type=str, required=True)
    parser.add_argument("--root", type=Path, default=None, help="Optional asset root folder for resolving manifest paths.")
    parser.add_argument("--map", type=Path, required=True, help="Layered base map JSON (for size/origin/layers).")
    parser.add_argument("--backdrop", type=Path, required=True)
    parser.add_argument("--reference-small", type=Path, required=True)
    parser.add_argument("--out-steps", type=Path, required=True)
    parser.add_argument("--layers", type=str, default="", help="Comma-separated layer order to fill within each row.")
    parser.add_argument("--min-improve", type=float, default=1.0)
    parser.add_argument("--from-top", action="store_true", help="Fill rows top->bottom (default is bottom->top).")
    args = parser.parse_args()

    manifest = _load_json(args.manifest)
    if not isinstance(manifest, dict):
        raise SystemExit("Manifest must be a JSON object.")
    ts = _tileset_meta_from_manifest(args.manifest, manifest, args.tileset, root_override=args.root)

    map_payload = _load_json(args.map)
    if not isinstance(map_payload, dict) or not isinstance(map_payload.get("layers"), dict):
        raise SystemExit("--map must be a layered JSON with `layers`.")

    backdrop = Image.open(args.backdrop).convert("RGBA")
    ref = Image.open(args.reference_small).convert("RGBA")
    if backdrop.size != ref.size:
        raise SystemExit("Backdrop and reference-small must be the same size.")

    # If the map doesn't specify canvas size, prefer the reference/backdrop size.
    meta = map_payload.get("meta")
    if isinstance(meta, dict):
        meta.setdefault("canvasWidth", ref.width)
        meta.setdefault("canvasHeight", ref.height)

    map_meta = _extract_map_meta(map_payload, tile_w=ts.tile_w, tile_h=ts.tile_h)
    layers_raw = map_payload["layers"]
    layer_names = [k for k in layers_raw.keys() if isinstance(k, str)]
    if args.layers.strip():
        fill_layers = [s.strip() for s in args.layers.split(",") if s.strip()]
    else:
        # Default: preserve common names if present else stable order.
        preferred = ["background", "ground", "foreground"]
        fill_layers = [k for k in preferred if k in layer_names] + [k for k in sorted(layer_names) if k not in preferred]

    if ref.size != (map_meta.canvas_w, map_meta.canvas_h):
        raise SystemExit(
            f"Backdrop/reference-small size {ref.size} must match map canvas {map_meta.canvas_w}x{map_meta.canvas_h}. "
            "Set meta.canvasWidth/canvasHeight in the map (or omit them and let this tool default them)."
        )

    with Image.open(ts.path) as sheet:
        sheet = sheet.convert("RGBA")
        candidates = _non_empty_tile_ids(sheet, ts)
        tile_cache: dict[int, list[tuple[int, int, int, int]]] = {tid: list(sheet.crop(ts.crop_box(tid)).getdata()) for tid in candidates}

        # Working state: layered grids + current canvas.
        grids: dict[str, list[list[int]]] = {name: _normalize_grid(layers_raw.get(name), map_meta.grid_w, map_meta.grid_h) for name in fill_layers}
        current = backdrop.copy().convert("RGBA")

        _write_step(args.out_steps / "step_00.json", "step_00 (backdrop only)", [])

        step_idx = 1
        y_range = range(0, map_meta.grid_h) if args.from_top else range(map_meta.grid_h - 1, -1, -1)
        for y in y_range:
            placements: list[dict[str, Any]] = []
            row_top = map_meta.origin_y + y * ts.tile_h
            for layer in fill_layers:
                for x in range(map_meta.grid_w):
                    left = map_meta.origin_x + x * ts.tile_w
                    target_patch = list(ref.crop((left, row_top, left + ts.tile_w, row_top + ts.tile_h)).getdata())
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
                        grids[layer][y][x] = best_tid
                        tile_img = sheet.crop(ts.crop_box(best_tid))
                        current.alpha_composite(tile_img, dest=(left, row_top))

            _write_step(args.out_steps / f"step_{step_idx:02d}.json", f"row y={y}", placements)
            print(f"Wrote step_{step_idx:02d}.json for row y={y} with {len(placements)} placements")
            step_idx += 1

    print(f"Done. Steps written to {args.out_steps}")


if __name__ == "__main__":
    main()
