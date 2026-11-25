# Image Action Pose Boards

Use this reference for Spriterrific image-generated action sheets.

## Canonical Default

```text
generation canvas: 1536x1152
aspect ratio: 4:3
generation grid: 4 columns x 3 rows
generation cell: 384x384
runtime safe area: centered 256x256 inside each cell
max generated pose cells: 12
background: flat #00FF00
unused cells: flat #00FF00 only
```

This is a model-friendly pose board, not the final runtime sheet.

## Template Policy

Keep this skill focused on Spriterrific workflow decisions. Do not bundle many chroma canvases or guide PNGs here.

Project templates should live in the repository proper or be generated deterministically by Spriterrific commands. This keeps chroma colors, guide styles, and provider-specific canvas choices configurable in code and review metadata instead of hidden inside skill assets.

Use visible grid/number overlays for documentation and human review only. Do not pass visible grids to image models by default, because grid lines, labels, and safe-area marks can leak into generated outputs.

When a geometry guide is needed for still-image action generation, use Spriterrific's deterministic black-and-white alternating-pixel guide only as a reference image for aspect ratio and implied layout. The generated output must not copy the guide as a visible checkerboard, contact sheet, border, grid, white page, gray page, or presentation sheet. The final pose-board background should still be one uninterrupted flat `#00FF00` chroma field.

## Runtime Packing

```text
runtime frame size: 256x256
runtime sheet columns: 5
6 frames  -> 5 columns x 2 rows, one empty runtime cell
8 frames  -> 5 columns x 2 rows, two empty runtime cells
10 frames -> 5 columns x 2 rows
```

## Recommended Runtime Counts

```text
idle   10 frames
attack 8 frames
hurt   6 frames
jump   6 frames
death  10 frames
walk   8-12 frames, preferably video-derived
run    8-12 frames, preferably video-derived
```

## Processing Contract

```text
1. Generate 1536x1152 pose board.
2. Crop first N implied 384x384 cells only as rough grid review artifacts.
3. Recover foreground components from the full pose board.
4. Use recovered variable-size components, not rough grid crops, as the source of truth.
5. Preserve recovered raw/native frames before pixel snap or 256x256 runtime normalization.
6. Create padded native review frames, contact sheet, and GIF before runtime normalization; default to 384x448, with 448x448 as a square review option.
7. Remove chroma/clean/despeckle per recovered pose as needed.
8. Optionally pixel snap per recovered pose only if review proves it helps; use `spriterrific run --pixel-snap`.
9. Choose `--pixel-snap-source recovered` for tight transparent recovered crops, `--pixel-snap-source chroma-layout` to fit recovered frames with one shared scale onto a shared 384x384 chroma canvas, or `--pixel-snap-source transparent-layout` to use a shared 384x384 transparent canvas. Both layout modes run real pixel snapper; chroma-layout then chroma-keys the snapped background before normalization.
10. If pixel snap is enabled, show raw real pixel-snapper outputs without padding, with discovered native frame sizes.
11. If pixel snap is enabled, create one compact comparison sheet: recovered/source -> raw pixel snap output -> chroma-keyed output when applicable -> final 256x256 runtime frame.
12. Normalize each recovered or snapped pose to 256x256 runtime cells.
13. Pack runtime frames into 5-column engine sheet.
14. Write review/index.md with source, before/after comparisons, GIF, and final sheet.
```

Hard rule:

```text
Never use exact implied grid crops as the source of truth for image-generated pose boards.
Rough 384x384 grid crops are review artifacts only.
Runtime frames must come from recovered variable-size foreground components or pose regions, then normalized.
Every normalization needs before/after comparisons, especially native review frames versus 256x256 runtime frames.
```

## Prompt Constraints

Include:

```text
exact generation canvas size 1536x1152
4:3 pose board
4 columns x 3 rows
384x384 cells
centered 256x256 runtime safe area in each cell
one full-body character per used cell
consistent scale and foot baseline
flat exact #00FF00 background
every non-character pixel exact solid #00FF00, including outer edges, gutters, and unused cells
unused cells flat #00FF00 only
no contact sheet, proof sheet, storyboard page, white/gray/black background, text, labels, frame numbers, visible grid lines, shadows, scenery, extra characters
```

## Why Not 5x1 Or 5x2 By Default

Wide strips are runtime-friendly but model-hostile. They encourage panoramic composition, invisible boundary violations, and provider aspect-ratio failures. `5x2` sheets remain useful for backwards compatibility, but new image action work should start from the canonical `4:3` pose board.

The `4:3` pose board reduces model pressure, but it does not make invisible cells trustworthy. Always recover components before runtime export.
