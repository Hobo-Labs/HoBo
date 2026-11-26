# Bo action sheets — site use only

Five generated Bo animation sheets, for use on **sites**. They are deliberately
**not** game assets: `@hobo/control-yard` does not load them.

## The sheets

| Sheet | Action |
|---|---|
| `bo-wave-w.png` | wave |
| `bo-jump-w.png` | jump |
| `bo-hurt-w.png` | hurt |
| `bo-sleep-wake-w.png` | sleep → wake |
| `bo-bindle-adjust-w.png` | bindle adjust |

All five share one layout, recorded machine-readably in `sheets.json`:

- **1280×512** sheet, **256×256** frames
- **5 columns × 2 rows = 10 frames**
- **8 fps** (125 ms per frame)
- origin `{x: 0.5, y: 1}`, anchor `feet-baseline`

The anchor matters: Bo is positioned by the **soles of his feet**, not by his
centre or his bounding box. Anchoring any other way makes him bob against the
ground between frames, because the sheets deliberately vary his height to carry
the motion. `sheets.json` travels with the art so a consumer does not have to
rediscover this by eye.

## Provenance, and why they are here

These were generated during the HIGHBALL pixel-RPG work and removed by
[ADR-0148](../../../docs/design/adr/07-portability-extensibility.md#adr-0148),
which retired them along with the rubberhose identity.
[ADR-0149](../../../docs/design/adr/07-portability-extensibility.md#adr-0149)
restored the identity but initially left these out, on the reading that the
owner had rejected them. That was too broad: what was rejected was the *game*
surface built from renderer-drawn primitives. The owner has since asked for
these sheets back **for site use**, which is what this directory is.

They are generated art, not hand-authored, and not part of the Bo art bible.
The hand-authored Bo lives in [`../parallax/`](../parallax/) —
`bo-idle`, `bo-walk`, `bo-walk-left` — and remains the canonical character art.

## Rules

- **Site surfaces only.** Do not import these into `@hobo/control-yard`.
- **Anchor at the feet.** See above.
- **They do not override the parallax Bo.** Where an idle or walk cycle is
  needed, use `../parallax/`; these cover actions that art does not.
