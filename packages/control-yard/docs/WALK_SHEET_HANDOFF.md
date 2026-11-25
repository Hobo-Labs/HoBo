# Bo walk sheets — reuse good site art

## Direction quality

| Direction | File | Status |
|---|---|---|
| **Idle** | `bo-idle.png` | **GOOD** — site plate (blink/bounce). Do not replace. |
| **East / walk-right** | `bo-walk.png` | **GOOD** — site plate. Do not replace. |
| **West / walk-left** | `bo-walk-left.png` | Site plate + **feet lock only** (row 153). |

## Rules (from implemented site styles and supplied parallax assets)

1. **Reuse traced site art.** Never invent generative color scenery or replace idle/east.
2. **Ink on paper** — monochrome Bo + grayscale parallax plates. No sepia AI railyards.
3. **Never mirror east** for west (`neverMirrorFrom`). Bindle arm is anatomical.
4. West hop fix = vertical re-register to east baseline row **153** only. No redraw unless a true west cycle is supplied by hand.

## What was wrong with agent regenerates

- Imagine 8-key / morph packs were lower quality than site idle/east.
- Full-color generative env plates violated the visual system (“traced art only”, “don’t invent generative glop”).
- Invented work/error sheets discarded; zones reuse `bo.idle`.

## Design system

- Agent contract: `site/src/styles/global.css`
- Parallax art bible: `site/public/parallax/README.md`
- Plates: `site/public/parallax/plates/README.md` (ink/paper invert night)
