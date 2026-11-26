# Tilemap → Reference Image Reconstruction (Heuristics)

Use this when you have a “pretty” reference PNG that was assembled from tiles (and often extra backdrop layers), and you want to reconstruct it deterministically from a tileset + tilemap so you can fix mismatches tile-by-tile.

## Core idea

- Treat reconstruction as an **asset pipeline debugging problem**:
  - normalize everything into a tile-aligned coordinate space
  - render deterministically
  - generate overlays that make mismatches actionable

## The common failure mode: alignment

Before any tile matching makes sense, lock down:

1) **Working resolution**  
If the reference is high-res, it is often an integer upscale of a logical “tile space”. Find an integer downscale factor that yields a clean tile-aligned size.

2) **Tile area vs padding**  
If `gridHeight*tileSize` does not equal the working canvas height, there is padding somewhere. Determine:
- is the padding at the top or bottom?
- is it “empty sky” or a hard UI/letterbox bar?

**Tip:** Sample the top and bottom strips; if one is a uniform band, it’s usually padding.

3) **Grid origin**  
Define `(tileOriginX, tileOriginY)` in pixels within the working canvas:
- top-aligned grid: origin `0`
- bottom-aligned grid: origin `canvasH - gridH*tileH`

Generate a grid overlay early and verify visually.

## Separate the backdrop from the tiles

Reference images often include:
- parallax/background layers composited behind tiles
- gradients, stars, fog, etc.

If you don’t reproduce the backdrop, tile diffs become meaningless (you’re comparing tile pixels against background pixels).

Preferred approach:
- Compose the backdrop deterministically from its source layers (`tile_backdrop_compose.py`)
- Render tiles *on top* of that backdrop

## Representations that work well

### Tile IDs (1-based)

Use 1-based tile IDs for tilesets (0 = empty). This plays well with many editors and avoids off-by-one confusion when exporting for engines that reserve 0.

### Layered maps + step files

Keep a base `recreation_map.json` plus incremental `step_XX.json` files:
- it’s easy to review diffs
- you can regenerate any step deterministically
- you can “fix a tile” by editing one small JSON file

## Diff visualizations: prefer “overlay” for humans

Two diff styles are useful:

- **Abs diff** (raw `abs(ref - render)`)  
  - correct, but small diffs look dark
  - amplifying tends to look neon and loses scene context
- **Overlay diff** (reference colors + tinted mismatched pixels)  
  - best for human debugging
  - preserves the original palette and “what should be there”

Additionally, produce a **tile mismatch outline**:
- outlines tile cells where any pixel differs above a threshold
- emit a JSON `{x,y}` list so you can jump straight to the problematic tiles

## Why perfect reconstruction may be impossible

Even if your tools are correct, you may never get a zero diff if the reference includes:
- hand-painted edits (not present as tiles)
- blended / anti-aliased edges between tiles
- post-processing (color grading, blur, noise)
- sub-tile offsets (sprites placed at non-multiple-of-tile coordinates)
- additional assets not in the tileset (decor sprites, particles)

The goal of this workflow is to get **actionable mismatches**, not to guarantee “pixel-perfect” solvability.

