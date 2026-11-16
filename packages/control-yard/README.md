# `@hobo/control-yard`

HoBo Yard — game-first control-plane UI (canvas host + Phaser load plan + OpenUI generative overlays).

Skills applied from `ref_assets/` builderpack:

| Skill | Use in this package |
|---|---|
| **gamedev-assets** | Measured `assets/assets_index.json` (v2 categories), `asset_sizes` / `asset_sheet_probe` / `asset_manifest_check`, frame extract + review GIFs |
| **phaser-gamedev** | Measure-before-load STOP rule, Boot load plan, AnimTest harness, FIT config, pooling-ready particle design, no global game state |
| **playwright-testing** | `window.__TEST__` seam, `?test=1&seed=42` deterministic mode, readiness waits, `imgdiff.py` baselines |

## How to run

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
# Syncs key files into src/draft/exp-proofs/ux/control-yard/assets/evidence/
```

**Self-report is not acceptance.** See `AGENTS.md` for required PNG/MP4 evidence rules.


Playable host: `public/index.html` + `public/yard-game.js`  
Anim isolation: `public/anim-test.html` (phaser-gamedev AnimTest pattern)

## Design system + art bible

- **`site/src/styles/global.css` and `public/yard.css`** — rubberhose ink-on-paper contract.
- **`site/public/parallax/README.md`** — Bo sheets; never mirror west.
- **Plates** — reuse site `trail` / `poles` / `clouds` only. No generative color scenery.

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
