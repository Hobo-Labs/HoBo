---
name: gamedev-assets
description: "Asset pipeline utilities for 2D game projects: validate an asset manifest against PNGs on disk, probe sprite sheets/tilesets to find non-empty grid frames, and report PNG dimensions; plus tilemap/tileset debugging and reconstruction workflows (render a tilemap against a reference image, generate debug overlays, overlay diffs, highlight mismatched tiles, and optionally brute-force autofill tiles). Use when adding/updating art, debugging missing/unused assets, auditing sprite sheets, building frame/size metadata, debugging tileset grids, or recreating a scene image from tilemaps."
---

# Gamedev Assets

Use the bundled scripts in `scripts/` to keep your game's art pipeline consistent and debuggable.

## Asset Index Learnings (from Rocky Roads)

Keep a short “worked example” doc in your own repo whenever you establish an asset-index convention.

In this repo, the practical “what worked / what didn’t” notes from building a Love2D asset index live at:
- `docs/asset-index-learnings.md`

Key takeaways to apply when building/managing an asset index:
- Prefer a **native** manifest format (Lua table for Love2D), but keep it **JSON-shaped** for export.
- Categorize by **how you use the asset** (`backgrounds`, `tilesets`, `images`, `spritesheets`), not by size alone.
- Pick a **tile size** first for tilesets (this pack is consistently **16×16**), then derive `columns/rows`.
- Treat many sprite sheets as **sparse**: compute and store **non-empty** `{col,row}` frames (alpha-based) instead of assuming a full grid.
- Use **stable, sanitized keys**; keep `path` as the on-disk truth (case + spaces preserved).
- Always run a **coverage check** after asset changes so the manifest stays trustworthy.

## Animation Normalization Learnings

When importing AI-generated sprite strips or extracted video frames into game-sized animation frames:

- Use one **approved in-game frame** as the target size reference.
- Use one **shared runtime anchor** from metadata for placement.
- Use one **shared scale** for the whole sequence. Do not scale each frame independently unless the source is genuinely inconsistent.
- Choose the shared-scale reference deliberately:
  - use a **baseline / median-lower** pose height for states like attack or hurt, where some frames are taller but the character should not be rescaled per pose
  - use the **first frame** for crouch-like states, where frame `01` should match idle height and later frames should remain visibly shorter
- For video-frame imports, compute one **union crop** across the full frame set and crop every frame with that same box.
- Align frames with a stable rule such as **fixed center + fixed bottom** or your known runtime anchor. Do not re-center each frame from its own local silhouette unless the source frames were hand-authored as isolated cells.

Why this matters:

- per-frame cropping/alignment often creates fake sideways drift or "skateboarding"
- per-frame scaling often shrinks tall poses like raised weapons or hurt reactions
- many apparent animation problems are actually registration problems introduced during import
- keeping every extracted frame from a source video often gives you repeated cycles rather than one usable game loop

Practical rule:

- preserve sequence framing first
- normalize second
- derive collision/body bounds only after the normalized export exists

For strip importers that support explicit scaling modes, prefer:

- `median-lower` for attack, hurt, or other states with upward pose variation
- `first-frame` for crouch or other enter-and-lower states that begin from an idle-like standing pose

For video-derived animation specifically:

1. Use a dense extraction first if you need to inspect the motion clearly.
2. Normalize that dense sequence with one shared crop, one shared scale, and one shared anchor.
3. Treat that result as analysis material.
4. Curate one clean loop cycle for the runtime asset.

This repo's run-animation experiments established an important distinction:

- dense import is good for diagnosis
- curated single-cycle export is better for the actual game asset

If an animation looks like it is "skating" or sliding sideways, check these in order:

1. whether frames were cropped independently
2. whether frames were centered independently
3. whether tall poses were scaled differently from short poses
4. whether the source motion itself contains true root-motion drift

If a character looks like it is **floating above its shadow** or standing at different heights by direction, check the visible alpha bounds:

1. measure the lowest non-transparent pixel for each frame
2. compare the bottom baseline across directions and states
3. normalize the PNG frames so feet land on a shared baseline, commonly `bottomY = frameHeight - 1`
4. only then tune engine-side sprite origin or shadow offsets

Do not use the asset manifest as the first fix for bad foot placement. Manifests can describe frame size, atlas size, frame count, fps, and sometimes engine pivots, but they do not repair transparent padding inside the PNG. Prefer fixing the runtime spritesheet unless the engine has deliberate per-animation pivot metadata and the team has standardized on using it.

Nearest-neighbor import preserves pixels. If the in-between poses still look soft after correct normalization, the softness is usually already present in the source frames.

## Asset Index Theory

An asset index (manifest) is a structured metadata file that serves as the single source of truth for all game art. It enables:
- **Centralized loading** - One place to reference all assets by logical name
- **Frame metadata** - Grid dimensions, animation sequences, timing
- **Validation** - Ensure disk files match what code expects

### Output Formats

- **JSON** (preferred) - Universal, works with any engine
- **Lua table** - For Love2D or other Lua-based projects

### Asset Categories

| Category | Purpose | Key metadata |
|----------|---------|--------------|
| `backgrounds` | Parallax/scrolling layers, static backdrops | `path`, `width`, `height` |
| `tilesets` | Grid-based level tiles | `path`, `tileWidth`, `tileHeight`, `columns`, `rows`, `margin`, `spacing` |
| `images` | Static sprites (no animation) | `path`, `width`, `height` |
| `spritesheets` | Animated sprites | `path`, `frameWidth`, `frameHeight`, `fps`, `frames` or `animations` |

### Manifest Structure

```json
{
  "meta": {
    "version": 1,
    "root": "assets/game",
    "defaultFps": 10
  },
  "backgrounds": {
    "clouds": { "path": "Backgrounds/clouds.png", "width": 256, "height": 128 }
  },
  "tilesets": {
    "desert": {
      "path": "Tilesets/desert.png",
      "width": 192, "height": 96,
      "tileWidth": 16, "tileHeight": 16,
      "columns": 12, "rows": 6
    }
  },
  "images": {
    "deco": {
      "bush": { "path": "Deco/bush.png", "width": 32, "height": 16 }
    }
  },
  "spritesheets": {
    "enemies": {
      "chicken": {
        "path": "Enemies/chicken.png",
        "width": 224, "height": 64,
        "frameWidth": 32, "frameHeight": 32,
        "columns": 7, "rows": 2,
        "animations": {
          "idle": { "fps": 6, "frames": [[0,0], [1,0]] },
          "run": { "fps": 10, "frames": [[0,1], [1,1], [2,1], [3,1]] }
        }
      }
    }
  }
}
```

### Frame Coordinates

Frames are referenced as `[column, row]` pairs within the sprite sheet grid:
- **Zero-based indexing** - First cell is `[0, 0]`
- **Grid defined by frame dimensions** - `frameWidth × frameHeight` subdivides the image
- **Sparse sheets** - When not all cells contain content, use explicit `frames` array
- **Named animations** - Group frame sequences with timing under `animations` object

### Workflow: Building an Asset Index

1. **Inventory** - Run `asset_sizes.py` to get dimensions of all PNGs
2. **Probe sheets** - Run `asset_sheet_probe.py --frame WxH --list` to find non-empty cells
3. **Categorize** - Determine if each asset is background, tileset, static image, or spritesheet
4. **Define animations** - For spritesheets, identify frame sequences and fps
5. **Write manifest** - Create JSON (or Lua for Love2D projects)
6. **Validate** - Run `asset_manifest_check.py` to ensure manifest ↔ disk sync

## Quick Start (recommended: `uv`)

Run from repo root:

```bash
# 1) Check manifest coverage (manifest ↔ disk)
uv run .codex/skills/gamedev-assets/scripts/asset_manifest_check.py --manifest path/to/assets_index.lua --root assets

# 1b) Export Lua manifest to portable JSON (recommended for non-Lua engines/tools)
uv run .codex/skills/gamedev-assets/scripts/asset_manifest_export_json.py --manifest path/to/assets_index.lua --out path/to/assets_index.json

# 2) List PNG sizes
uv run .codex/skills/gamedev-assets/scripts/asset_sizes.py --root assets --json tmp/asset_sizes.json

# 3) Probe sprite sheet for non-empty frames
uv run .codex/skills/gamedev-assets/scripts/asset_sheet_probe.py path/to/sheet.png --frame 32x32 --list --json tmp/probe.json

# 3b) Audit/fix visible foot baselines inside sprite frames
uv run .codex/skills/gamedev-assets/scripts/asset_sprite_baseline.py assets/characters --frame 256x256 --json tmp/baselines.json
uv run .codex/skills/gamedev-assets/scripts/asset_sprite_baseline.py assets/characters --frame 256x256 --target-bottom 255 --out-dir tmp/baseline-fixed

# 4) Debug tilesets / tilemaps with a manifest-driven GUI editor
uv run .codex/skills/gamedev-assets/scripts/asset_tilemap_editor.py --manifest path/to/assets_index.json
```

Without `uv`: Python 3.11+ with Pillow installed.

All Python scripts shipped with this skill include PEP 723 metadata (`# /// script ...`) so `uv run <script.py>` installs dependencies automatically (no manual `pip install` steps).

## Asset Index Export (Lua → JSON)

If you have an existing `assets_index.lua` (Love2D-style), export it to a portable `assets_index.json`:

```bash
uv run .codex/skills/gamedev-assets/scripts/asset_manifest_export_json.py \
  --manifest path/to/assets_index.lua \
  --out path/to/assets_index.json
```

By default the exporter rewrites all `path` entries to be relative to the output manifest folder and sets `meta.root` to `"."`, so the resulting folder can be copied/zip'd and still work.

## Tilemap Debugging (Python tileset/tilemap editor)

Use the manifest-driven editor to verify:
- `tileWidth`/`tileHeight` grid math and `columns`/`rows`
- that cursor movement is exactly 1 cell per keypress
- that saving/loading a JSON tilemap preserves the same layout

Run:

```bash
uv run .codex/skills/gamedev-assets/scripts/asset_tilemap_editor.py --manifest path/to/assets_index.json
```

Note: this GUI uses `tkinter`, which is provided by your Python distribution/OS (it’s not installed via `uv`/pip).

Headless exports (no `tkinter` required):

```bash
# Export a grid-overlay PNG for a tileset
uv run .codex/skills/gamedev-assets/scripts/asset_tilemap_editor.py \
  --manifest path/to/assets_index.json --tileset <tileset_name> \
  --export-tileset-grid tmp/tileset_grid.png --label-ids --scale 6 --trim

# Generate a self-test tilemap (all non-empty tiles in-place) and render it
uv run .codex/skills/gamedev-assets/scripts/asset_tilemap_editor.py \
  --manifest path/to/assets_index.json --tileset <tileset_name> \
  --make-selftest-map tmp/selftest.json
uv run .codex/skills/gamedev-assets/scripts/asset_tilemap_editor.py \
  --manifest path/to/assets_index.json --map tmp/selftest.json \
  --export-map-render tmp/selftest.png --scale 6 --trim

# Optional: set a background color and fill rectangles behind tiles (useful for concept mockups)
uv run .codex/skills/gamedev-assets/scripts/asset_tilemap_editor.py \
  --manifest path/to/assets_index.json --map tmp/selftest.json \
  --export-map-render tmp/selftest_bg.png --scale 6 --bg '#77cfd8' --fill-rect '0,40,24,6,#12a7d5'
```

Controls:
- Arrows: move cursor cell-by-cell
- `WASD`: move palette selection on the tileset
- `Space/Enter`: paint, `X/Backspace`: erase
- `[` / `]`: switch tileset, `+/-`: zoom map
- `F5`: quick-save (`tilemap.json` by default), `F9`: quick-load (requires `--map`)
- `G`: grid, `H`: help

## Scene Reconstruction (Tilemap → Reference Image)

Use these scripts when you have a **reference PNG** that was assembled from tiles (and possibly backdrops), and you want to reconstruct it from a tileset + tilemap so you can:
- iterate row-by-row (often from “ground” upward)
- verify with deterministic renders
- see exactly which tiles still differ (and where)

See `references/tilemap_to_reference.md` for heuristics (alignment/padding/backdrops) and `references/autofill_notes.md` for autofill tuning + future acceleration ideas.

**Workflow (manifest-driven, engine-agnostic)**

1) Export/prepare `assets_index.json` (if you start from Lua):

```bash
uv run .codex/skills/gamedev-assets/scripts/asset_manifest_export_json.py \
  --manifest path/to/assets_index.lua \
  --out tmp/assets_index.json
```

2) Compose a backdrop (optional; if your reference image includes background layers that are *not* tiles):

```bash
uv run .codex/skills/gamedev-assets/scripts/tile_backdrop_compose.py \
  --layers path/to/layer0.png path/to/layer1.png path/to/layer2.png \
  --out tmp/backdrop.png --scale 6 --out-scaled tmp/backdrop_x6.png
```

3) Prepare a tile-aligned reference (downscale + grid overlay):

```bash
uv run .codex/skills/gamedev-assets/scripts/tile_reference_prepare.py \
  --reference path/to/reference.png --downscale 6 \
  --tile 16 --grid-cols 18 --grid-rows 11 --grid-origin-y 0 \
  --out-small tmp/ref_small.png --out-grid tmp/ref_grid.png --out-grid-scaled tmp/ref_grid_x6.png
```

4) Generate a tileset ID sheet (quick “tile picker” for manual fixes):

```bash
uv run .codex/skills/gamedev-assets/scripts/tile_tileset_ids.py \
  --tileset path/to/tileset.png --tile 16 --scale 6 --out tmp/tileset_ids.png
```

5) Create a base layered map JSON (you keep editing this + step files):

```json
{
  "meta": {
    "gridWidth": 18,
    "gridHeight": 11,
    "tileOriginX": 0,
    "tileOriginY": 0,
    "canvasWidth": 288,
    "canvasHeight": 180,
    "layerOrder": ["background", "ground", "foreground"]
  },
  "layers": {
    "background": [[0,0],[0,0]],
    "ground": [[0,0],[0,0]],
    "foreground": [[0,0],[0,0]]
  }
}
```

6) Render a step with debug overlay + diff + mismatched-tile highlighting:

```bash
uv run .codex/skills/gamedev-assets/scripts/tilemap_render_step.py \
  --manifest tmp/assets_index.json --root assets --tileset your_tileset_key \
  --map path/to/recreation_map.json --steps path/to/steps --step 11 \
  --backdrop tmp/backdrop.png --reference path/to/reference.png --scale 6 \
  --out-prefix tmp/recon_step11 --write-diff --write-diff-tiles-debug \
  --diff-threshold 6 --diff-tile-threshold 6
```

Outputs:
- `*_render.png`: clean render
- `*_debug.png`: map coords + tile IDs + tileset coords (for targeted fixes)
- `*_diff.png`: reference-colored overlay showing mismatched pixels
- `*_diff_tiles_debug.png` + `*_diff_tiles.json`: outlines + `{x,y}` list of mismatching tile cells

If you want the resolved indices written as a `tilemap.json` (for loading into `asset_tilemap_editor.py`), add:

```bash
  --out-tilemap tmp/tilemap.json
```

7) (Optional) Autofill a row (naive brute force; good for bootstrapping):

```bash
uv run .codex/skills/gamedev-assets/scripts/tilemap_autofill_row.py \
  --manifest tmp/assets_index.json --root assets --tileset your_tileset_key \
  --map path/to/recreation_map.json --steps path/to/steps --base-step 3 \
  --reference-small tmp/ref_small.png --backdrop tmp/backdrop.png \
  --row 10 --layer ground --min-improve 1.0 --out-step path/to/steps/step_04.json
```

8) Make GIFs for review:

```bash
uv run .codex/skills/gamedev-assets/scripts/make_gifs.py \
  --frames 'tmp/*step*_debug.png' --out tmp/steps_debug.gif \
  --diff-frames 'tmp/*step*_diff.png' --out-diff tmp/steps_diff.gif
```

## No tilemap? Generate `tilemap.json` from a reference (best-effort)

If you *don’t* have a tilemap yet, you can generate a first-pass `tilemap.json` directly from:
- a tileset (via `assets_index.json`)
- a reference image (and ideally a backdrop)

This uses naive brute-force matching and may not be perfect (or even solvable) if the reference contains non-tile pixels. It’s meant to **bootstrap** a map so you can fix mismatches with the debug/diff tools.

```bash
uv run .codex/skills/gamedev-assets/scripts/tilemap_from_reference.py \
  --manifest tmp/assets_index.json --root assets --tileset your_tileset_key \
  --reference path/to/reference.png \
  --backdrop-layers path/to/bg0.png path/to/bg1.png path/to/bg2.png \
  --out-dir tmp/recon_out --min-improve 1.0
```

Outputs include:
- `tmp/recon_out/tilemap.json` (indices)
- `tmp/recon_out/steps/step_*.json` (placements you can refine)

## Tilemap Debugging (Love2D test scenes)

When tile sizes / tileset grids don’t line up in-engine, use the built-in Love2D scenes in this repo to verify:
- the tileset grid math (tileW/tileH, columns/rows, margin/spacing)
- that your cursor moves exactly 1 cell per keypress
- that saved `.lua` maps load back identically

Run from repo root:

```bash
love .
```

Controls:
- `1` Tileset Inspector: arrows move selection cell-by-cell; `[`/`]` switch tilesets; `g` grid; `+/-` zoom
- `2` Tilemap Editor:
  - arrows move map cursor cell-by-cell
  - `WASD` moves the palette (selected tile) on the tileset sheet
  - `Space/Enter` paints, `X/Backspace` erases
  - `Ctrl+S` quick-save, `Ctrl+L` quick-load (`F5`/`F9` also work)
  - saved maps go to `maps/` in Love’s save directory (shown after saving)

## Tools

### 1) Manifest Coverage Check (`asset_manifest_check.py`)

Verify every PNG on disk appears in manifest and vice versa.

```bash
uv run .codex/skills/gamedev-assets/scripts/asset_manifest_check.py
uv run .codex/skills/gamedev-assets/scripts/asset_manifest_check.py --json tmp/coverage.json
```

### 1b) Manifest Export (`asset_manifest_export_json.py`)

Export `assets_index.lua` to `assets_index.json` (portable across engines/tooling):

```bash
uv run .codex/skills/gamedev-assets/scripts/asset_manifest_export_json.py --manifest path/to/assets_index.lua --out path/to/assets_index.json
```

### 2) Sprite-Sheet Probe (`asset_sheet_probe.py`)

Find non-empty cells in a sprite sheet grid. Essential for building `frames` arrays.

```bash
uv run .codex/skills/gamedev-assets/scripts/asset_sheet_probe.py image.png --frame 32x32
uv run .codex/skills/gamedev-assets/scripts/asset_sheet_probe.py folder/ --frame 16x16 --list --json tmp/probe.json
```

### 2b) Sprite Baseline Audit/Fix (`asset_sprite_baseline.py`)

Audit visible alpha bounds inside a spritesheet grid and optionally write baseline-corrected copies.

Use this when:
- a character floats above its shadow in one direction but not another
- a directional idle was made from an attack frame
- AI-generated sheets have inconsistent transparent padding under the feet
- engine origins are correct, but visual foot placement still differs

```bash
# Report per-frame alpha bounds, visible bottom pixel, and required shift.
uv run .codex/skills/gamedev-assets/scripts/asset_sprite_baseline.py public/assets/kaede --frame 256x256 --json tmp/kaede-baselines.json

# Write fixed copies whose visible feet land on y=255.
uv run .codex/skills/gamedev-assets/scripts/asset_sprite_baseline.py public/assets/kaede --frame 256x256 --target-bottom 255 --out-dir tmp/kaede-baseline-fixed

# Optionally normalize horizontal center too, when the source is meant to be idle/standing.
uv run .codex/skills/gamedev-assets/scripts/asset_sprite_baseline.py public/assets/kaede/idle-n.png --frame 256x256 --target-bottom 255 --target-center-x 128 --out tmp/idle-n-fixed.png
```

Treat the script as a runtime export guardrail. It does not decide animation quality; it verifies that final PNG frames agree with the engine's sprite-origin and shadow assumptions.

### 3) PNG Dimension Listing (`asset_sizes.py`)

Get dimensions for all PNGs under a folder.

```bash
uv run .codex/skills/gamedev-assets/scripts/asset_sizes.py
uv run .codex/skills/gamedev-assets/scripts/asset_sizes.py --root assets/ --json tmp/sizes.json
```

### 4) Tileset/Tilemap Editor (`asset_tilemap_editor.py`)

GUI tool for selecting tiles and painting a grid to validate tileset assumptions.

```bash
uv run .codex/skills/gamedev-assets/scripts/asset_tilemap_editor.py --manifest path/to/assets_index.json
```
