# control-yard UX proof — agent instructions

Experience proof for the control-plane game UI.

## Evidence required (Playwright screenshots + MP4)

This proof is **not complete** without captured evidence. Claims without files
are false.

### Required under `assets/evidence/`

| File | Proves |
|---|---|
| `01-boot-live.png` | Yard loads; HUD projections live |
| `02-connection-bay-sheet.png` | Generative connection sheet |
| `anim-bo-walk-east.png` | Bo east sheet (bindle arm) |
| `anim-bo-walk-west.png` | Bo west sheet (not a mirror) |
| `01-yard-loop.mp4` | Interactive loop recording |
| `03-bo-walk-east-west.mp4` | East→west animation isolation |
| `evidence-manifest.json` | Digests + sizes from capture run |

Source of truth capture lives in
`packages/control-yard/public/shots/` (run
`pnpm --filter @hobo/control-yard run evidence` then sync into this folder).

### Agent rules

1. After changing yard UX or assets, re-run evidence capture and re-sync
   `assets/evidence/`.
2. Read PNGs (and extract MP4 frames if needed) before declaring done.
3. Update the evidence manifest when paths change.
4. Follow parent [`../AGENTS.md`](../AGENTS.md) for general UX proof rules.
