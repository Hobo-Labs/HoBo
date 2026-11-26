# `@hobo/control-yard`

HoBo Yard — game-first control-plane UI (canvas host + Phaser load plan + OpenUI generative overlays).

Skills applied from `ref_assets/` builderpack:

| Skill | Use in this package |
|---|---|
| **gamedev-assets** | Measured `assets/assets_index.json` (v2 categories), `asset_sizes` / `asset_sheet_probe` / `asset_manifest_check`, frame extract + review GIFs |
| **phaser-gamedev** | Measure-before-load STOP rule, Boot load plan, AnimTest harness, FIT config, pooling-ready particle design, no global game state |
| **playwright-testing** | `window.__TEST__` seam, `?test=1&seed=42` deterministic mode, readiness waits, `imgdiff.py` baselines |

## How to run

Evidence capture uses the repository's Playwright dependency. Install its
headless Chromium and video encoder with
`pnpm exec playwright install --only-shell chromium`. It also needs `ffmpeg`,
`ffprobe`, and `uv` on `PATH` for video conversion, validation, and image
comparison. To use a system Chromium instead, set `CHROME_PATH` to its
executable path; Playwright's video encoder is still required
(`pnpm exec playwright install ffmpeg`). The demo
serves its [Chewy font](assets/CREDITS.md) locally.

```bash
# 1) Asset pipeline (gamedev-assets)
pnpm --filter @hobo/control-yard run assets:sizes
pnpm --filter @hobo/control-yard run assets:coverage
pnpm --filter @hobo/control-yard run assets:validate
pnpm --filter @hobo/control-yard run assets:extract-frames
# then make GIFs via skill:
# uv run .agents/skills/gamedev-assets/scripts/make_gifs.py --frames 'tmp/frames/bo-walk-east_walk/step*.png' --out tmp/gifs/bo-walk-east.gif

# 2) Unit tests
pnpm --filter @hobo/control-yard test

# 3) Evidence capture (AGENTS.md mandatory — screenshots + MP4)
pnpm --filter @hobo/control-yard run evidence
pnpm --filter @hobo/control-yard run evidence:check
# → public/shots/*.png + recordings/*.mp4 + evidence-manifest.json
# Syncs and checks all manifested files in src/draft/exp-proofs/ux/control-yard/assets/evidence/
```

If a unit test is interrupted, its generated `tmp/yard-*-test-*` directory can
remain in the package and be picked up by lint. After the test stops, remove
that scratch directory before rerunning lint.

Capture requires the checked-in, reviewed baselines and a working Pillow image
comparison; a missing baseline or comparison dependency fails the capture. The
comparison accepts RMS up to 25 for rendering variation and never replaces a
baseline automatically; review baseline updates separately. A failed capture
may leave a mix of old and new images, and marks both evidence directories
incomplete until a successful rerun. Captures take an exclusive lock at
`public/shots/.capture-lock`. If marker setup or cleanup fails, or a capture is
interrupted, confirm no capture is still running before removing that directory
and retrying.

The evidence checker refuses symlinks at an evidence directory, between the
checkout and an in-checkout evidence directory, or in a manifested path. This
keeps checked files within the selected evidence tree.

Before writing, capture checks both complete evidence trees and their paths
below the checkout. It refuses symlinks, hardlinked files, and special files so
existing output paths cannot overwrite files elsewhere. Capture and checking
assume the filesystem stays stable during the operation: another process
replacing path components concurrently can bypass these checks.

The visual report records Bo's `animationId`, `facing`, `facingSource`, and
`projectedFacing`. For a walk, `facing` follows the rendered directional sheet.
For other animations it follows the projection, or a default when no projection
is available; `facingSource` makes that distinction explicit. Capture checks
that both sampled states agree with their reported source.

The engine, test seam, and asset index unit tests use management snapshots and
typed sheet fixtures. They do not replace the retired pixel-village browser or
experience-review acceptance gates.

**Self-report is not acceptance.** See `AGENTS.md` for required PNG/MP4 evidence rules.


Playable host: `public/index.html` + `public/yard-game.js`  
Anim isolation: `public/anim-test.html` (phaser-gamedev AnimTest pattern)

## Design requirements

The visual authority is `scripts/visual-token-contract.json`, enforced by
`scripts/check-visual-tokens.mts` through root `pnpm run design:lint`, together
with the focused checks below. `public/yard.css` implements the palette; no
retired `DESIGN.md` is an authority.

- **Palette and contrast.** Use the reviewed ink/paper/faint/accent tokens and
  pass every contract contrast pair. Enforced by `test/design-lint.test.ts` →
  `"passes the independent repository palette and contrast contract"`.
- **Rubberhose type and depth.** Use Chewy display type, system-ui body text,
  ui-monospace data, thick ink outlines, and hard zero-blur sticker shadows.
  Enforced by `"keeps the Rubberhose type, thick outlines, and zero-blur sticker
  shadows"` in that file.
- **Keyboard focus.** Buttons expose a 2.5px `spark` outline with a 2px offset.
  Enforced by `"uses 2.5px spark focus rings with 2px offsets"`.
- **Reduced CSS motion.** `prefers-reduced-motion: reduce` collapses CSS
  animation/transition timing and delays, removes button movement, and hides
  film grain. Enforced by `"reduces CSS motion and removes film grain when
  requested"`; this CSS check does not claim canvas-motion parity.
- **Supplied art only.** Scenery is limited to reviewed site `trail`, `poles`,
  and cloud plates, never generative color scenery. Enforced by `"limits scenery
  to the supplied reviewed site plates"`. Bo's west walk uses its own supplied
  sheet and is never mirrored from east, enforced by `test/control-yard.test.ts`
  → `"asset index resolves Bo idle/walk by stable id; west is not mirror flag"`.
  Character-sheet provenance remains in `site/public/parallax/README.md`.
- **[Chewy](https://github.com/google/fonts/tree/7af0d90b4d532ffa4b041937b560c6df4e7b1e95/apache/chewy)** is bundled locally under the Apache 2.0 license in `public/fonts/LICENSE.txt`.

Delivery frames (site plates):

| Sheet | Grid | Frame | Cadence | Status |
|---|---|---|---|---|
| `bo-idle.png` | 12×1 | 207×230 | 125 ms | **reuse** (blink/bounce) |
| `bo-walk.png` | 6×6 | 160×157 | **50 ms** | **reuse** east |
| `bo-walk-left.png` | 6×6 | 160×157 | **50 ms** | site west + feet@153 |

Notes: `docs/WALK_SHEET_HANDOFF.md`, `docs/asset-index-learnings.md`.

## Architecture (phaser-gamedev)

```
Boot load plan  ← assets_index (measured only)
Yard engine     ← projections only (event-sourced)
UI sheets       ← OpenUI-style schema stream
__TEST__ seam   ← ready / state / commands
```

Clip names resolve only through stable animation ids (`bo.idle`, `bo.walk.east`, …).
