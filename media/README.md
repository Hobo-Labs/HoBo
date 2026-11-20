# Bo's art department

A catalogue of every drawing of Bo — reference sheets, sprite sheets, scenery
plates and the 3D lift — published at `/HoBo/media/`.

It exists because **a sprite sheet shown flat tells you nothing about what it
does.** The sheets play here at their exported cadence, driven from the same
frame geometry the site reads, so the catalogue and the product cannot silently
disagree about how many frames a walk cycle has.

```sh
pnpm --filter hobo-media run dev      # local
pnpm --filter hobo-media run build    # dist/
```

## What lives here, and what does not

| | Source of truth | Here |
|---|---|---|
| `bo-walk`, `bo-walk-left`, `bo-idle`, `bo-stand` | `site/public/parallax/` | reference copies |
| scenery plates | `site/public/parallax/plates/` | reference copies |
| turnaround, expressions, poses, props, `bo.glb` | **here** | originals |

The shipped sprite sheets and plates stay owned by `site/`, because that is what
the live site loads and a second copy in the load path is a second thing to keep
in sync. This package owns the *reference* art — the material you draw or
generate **from**, which the site never serves.

## Two characters

**Bo** is the original — long-bodied, and the only one the site ships. Every
sheet under `sprites/` and every scenery plate is his.

**HoBit Bill** is not Bo. He came out of a turnaround generated *from* Bo's
sheets and landed somewhere visibly different: rounder, squatter, differently
furred. That was a failure of the generation. It is kept on purpose, under its
own name, because the result was good — the alternative was to throw it away or,
worse, to pass it off as Bo. Everything under `reference/bill-*` and the 3D lift
is Bill's.

**Do not mix them.** A Bill pose is not a Bo reference, and generating new Bo
work from Bill's turnaround is precisely how Bo stops being Bo.

## Bo in pixels

`reference/bo-pixel-reference.png` (labeled, 4×) and
`reference/bo-pixel-sprites.png` (native 1×, 56×56 cells) are a **model
sheet** of Bo on a 48px pixel grid: a four-facing turnaround, six poses (sit,
crouch, hop, wave, point, startled) and seven expressions (the eyes carry
every reading — neutral, look left/right/up, wide, sleepy, blink), plus an
integer scale ramp. Flat black and white on transparency — the
character lock's palette, now literally two colors — plus a 1px dual rim:
white around the black fur so he reads on dark grounds (he is solid ink and
vanishes there otherwise), black around exposed white so the bundle keeps an
outline on paper. The rim is 8-neighbour; a 4-neighbour rim breaks into dashes
along the diagonal fur edges and reads as noise instead of a contour. The
sheet's grounds strip shows the same sprite on paper, slate and night.

No generation model is involved. The bodies are a deterministic
downscale-and-quantize of the shipped sheets in `site/public/parallax/`, and
every pose beyond the turnaround is deterministic pixel surgery on those
bases — the eye region repainted with the pupil placed per expression, legs
erased and re-posed, posture squashed or stretched at source resolution, the
free arm drawn as the same one-stroke-one-dot rubber hose the sheets use. The
bindle arm never changes: it holds the pole in every cell. The sheet labels use
the CC0 Kenney Pixel font in `media/assets/fonts/kenney/`. Rebuild end-to-end
with:

```sh
uv run media/scripts/build-bo-pixel-reference.py
```

so the pixel Bo *cannot* drift from the real one — rerunning the script after a
sheet change regenerates both files. The east walk sheet's pale ground ellipse
is stripped on the way through (reference frames carry no ground shadow), and
sprites sit on a shared baseline four pixels above the cell floor.

The **north** view is the one derived pose: the front stand mirrored, with
every white region fully enclosed by ink — the eyes, and the pole where it
crosses in front of the body — inked out, because a rear view cannot see them.
It is labeled `N*` on the sheet for that reason. Why mirroring is legitimate
*here* and nowhere else is covered below.

## The 3D viewer

`ModelViewer.astro` renders the `.glb` with **three.js**, bundled through Astro
rather than loaded from a CDN: the published page runs under a CSP that blocks
every external host, so an import map pointing at unpkg would work in dev and
render an empty box in production — the worst failure shape there is. The cost
is a ~613KB module, loaded only on this page.

It renders only while the canvas is on screen (an idle WebGL loop is a laptop
fan for nothing), keeps the still render as a poster until the mesh is ready,
and does not auto-spin under `prefers-reduced-motion` — you can still orbit by
hand.

## Identity

This surface uses the HoBo Rubberhose identity implemented in the site's
styles and supplied artwork. Keep the existing character proportions and
light/dark treatment when changing the media experience.

## Bo is asymmetric

Repeated here because it is the failure that keeps recurring: the bindle hangs
from one specific anatomical arm. Mirroring hands it to the other one, which
looks plausible at a glance and is wrong. It has shipped twice — once in the
west walk sheet, once as `<Mascot flip />` on the homepage CTA, directly above
the words "Pack a bindle".

**No asset in this catalogue may be produced by reflecting another view of the
same facing.** The turnaround was drawn as four views for that reason, and the
3D lift ran with symmetry enforcement off — it would otherwise have "corrected"
the bindle by giving him two, or by deleting it.

One reflection is geometrically sound, and it is the only one: **front to
back**. Walking around a character swaps screen-left and screen-right — that is
what turning around *is* — so a rear view mirrors the front's silhouette while
the bindle stays on the same anatomical shoulder. The pixel sheet's `N*` view
is derived this way (with the enclosed whites inked out, since a back view sees
no eyes and no crossing pole). East↔west remains forbidden: those are two views
of the *same* side of the world, and mirroring one into the other is precisely
the arm-swap failure above.

## The 3D lift is scaffolding

`reference/bo.glb` was lifted from the four turnaround views to give video
generation a consistent pose and lighting reference. It is **not** a shipping
asset and not a modelled character: it is a generated approximation, and the
drawings remain the identity. Judge new video work against the 2D sheets, not
against the mesh.

## Generating more

The recipe, learned the expensive way — see the closeout notes in
`site/public/parallax/README.md` for the sprite-format half:

- **Do not pass reference images for new poses, expressions or compositions.**
  With `medias` attached, `nano_banana_2` reproduces the reference and ignores
  the prompt — seven sheets came back as byte-identical copies of the input,
  including one that explicitly said "objects only, NO character". It is the
  same reason a generated blink came back with the eyes open.
- **Text-only follows the prompt.** Describe Bo precisely in words and the grid
  sheets, turnarounds and new poses all come out on-model.
- Use references only when you want the *same* pose reproduced faithfully.

## Publishing

The catalogue ships with the main site, not separately:
`pnpm run site:deploy` builds both and publishes this one **nested** at
`/HoBo/media/`. Nested rather than merged, because each Astro build has its own
hashed `_astro/` bundle and a flattened root would let the two fight over that
directory. One deploy commit therefore describes the whole published tree, and
the script refuses to run if either `site/` or `media/` has uncommitted changes.
