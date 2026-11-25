# Control-Yard asset index learnings

Worked example from applying builderpack **gamedev-assets** + **phaser-gamedev**
to HoBo Yard (ADR-0135).

## Measure first (phaser-gamedev STOP rule)

| Sheet | Measured | Grid | Frame | Non-empty |
|---|---|---|---|---|
| `bo/bo-idle.png` | 2484×230 | 12×1 | 207×230 | 12/12 site reuse |
| `bo/bo-walk.png` | 960×942 | 6×6 | 160×157 | 36/36 site reuse |
| `bo/bo-walk-left.png` | 960×942 | 6×6 | 160×157 | 36/36 site + feet@153 |
| `trail.png` / `poles.png` | site plates | parallax | ink line-art |
| `guests/guest-swe-claude.png` | 512×64 | 8×1 | 64×64 | 8/8 |

Probed with:

```bash
uv run .agents/skills/gamedev-assets/scripts/asset_sheet_probe.py \
  packages/control-yard/assets/bo/bo-walk.png --frame 160x157 --list
```

Delivery cells are the site repack (160×157), **not** the art-bible source 554×542.
Cadence contract stays **50 ms/frame** for walk sheets.

## West sheet is not a mirror

`bo-walk-west.neverMirrorFrom = "bo-walk-east"`. Bindle arm is anatomical.
Coverage check rejects byte-identical east/west sheets.

## Manifest categories (gamedev-assets)

- `backgrounds` — parallax plates (trail, poles, clouds)
- `images` — static chrome (cargo particle, connection bay)
- `spritesheets` — Bo + guests with measured grid + animations
- `animationIds` — stable ids for UI handlers (`bo.idle`, `bo.walk.east`, …)

## Coverage gate

```bash
uv run .agents/skills/gamedev-assets/scripts/asset_manifest_check.py \
  --manifest packages/control-yard/assets/assets_index.json \
  --root packages/control-yard/assets
```

## GIF review strips

Extracted frame strips + adaptive-palette GIFs under `tmp/gifs/` for human review
of idle / walk-east / walk-west cadence.
