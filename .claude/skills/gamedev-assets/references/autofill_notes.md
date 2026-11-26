# Autofill (Naive Brute Force) Notes

The skill includes a simple “autofill” heuristic to propose tiles from a reference image. It’s designed to **bootstrap** a reconstruction, not solve it perfectly.

## What it does

For each cell `(x,y)` in a chosen row (or in a whole sequence):

1. Extract the target patch from the tile-aligned reference image.
2. Compare that patch to the “empty” baseline (current canvas without a new tile).
3. For each candidate tile ID:
   - composite tile pixels over the baseline patch
   - score the result (RGB mean squared error)
4. Choose the lowest-error tile if it improves over empty by at least `--min-improve`.

## Practical knobs

- `--min-improve`  
  Prevents noisy placements where the best tile is only slightly better than empty.

- Candidate set  
  Default is “all non-empty tiles”. For large tilesets, restrict candidates:
  - use a curated list of tile IDs (e.g., only “ground” tiles)
  - split by category/atlas region if your pipeline supports it

- Layer order  
  When generating a full sequence, applying layers in a consistent order (e.g., background → ground → foreground) helps because later layers see the accumulated canvas.

## Known limitations

- MSE on RGB is fragile under:
  - color grading
  - noise
  - slight anti-aliasing
  - sub-tile offsets
- Tilesets with many similar tiles will produce plausible-but-wrong matches.
- It can’t invent content not in the tileset.

## Future acceleration ideas (not implemented)

If brute force becomes too slow or too error-prone, accelerate matching with a prefilter:

1) **Tile signatures**
- downsample each tile to 4×4 or 8×8 (RGB) and compare in that space first
- compute average color + edge magnitude histograms

2) **Alpha/shape filters**
- restrict by alpha coverage (opaque %, bounding box)
- restrict by connected components count/shape

3) **Two-stage candidate selection**
- keep only the top-K candidates by cheap metric (e.g., avg color distance)
- run full MSE only on that shortlist

4) **Vectorization / caching**
- precompute flattened tile arrays
- cache baseline patches for each cell/row

