# Landmarks

What stands on the trail. A plate loops forever; a prop is *somewhere* — each
one stands for a card of the landing page and stands up beside Bo when he
reaches that card's stop. Which card names which prop is in the page
(`data-prop`), and how tall each stands is in `src/lib/trail-props.ts`; this
folder only holds the artwork.

Same rule as the plates: **supplied art, used as given, nothing drawn here.** A
landmark whose file is missing simply does not render.

## Where they come from

Every file here is built by one script, from art in the Reference tier:

```sh
uv run media/scripts/build-trail-art.py landmarks
```

| Source | What it is | How paper becomes alpha |
|---|---|---|
| `media/public/reference/scene-props/*.webp` | the five approved scene props (signpost, train, depot, blimp, steamboat) | **enclosure** — paper is flood-filled from the border |
| `media/public/reference/trail-props/*.png` | three reviewed prop boards, six props to a sheet, named in `boards.json` | **their own alpha** — generated with a real transparent background |

The five approved props used to be traced into the full-width scene panels the
landing page stopped for. Those panels are gone; the props stand on the trail
instead, cut from the same approved drawings.

## The contract

- Grayscale + alpha PNG, posterized to 8 levels per channel, like the plates.
- **The grey channel is colour; alpha is coverage.** An edge pixel is
  (grey 0, alpha partial), never (grey mid, alpha 255) — the difference between
  an ink line and a soft grey stick.
- Cropped tight to the drawing. Height and baseline are set where it is placed,
  in tile units, not baked into the file.
- **No lettering.** Text baked into art cannot be themed or translated. The
  steamboat's reference carries a lettered "toot"; it is erased at build.
- One line weight across a set: the approved five share a single scale factor,
  and each board's props share one, rather than each being fitted to a box.

## Why two ways of finding the paper

Enclosure cannot tell paper from paint. It is right for a drawing on white
paper — a clock face stays white instead of becoming a hole — but anything the
drawing *encloses* stays white too: the gap under a handrail, the space between
a ladder's rungs. On white paper nobody can see that. On a night band it is a
white patch.

So art generated for this purpose is not drawn on paper. The shipped boards
were generated with a real transparent background, which settles the question
outright. The build also accepts a board on a flat chroma ground, and there the
rule is simple: black-and-white ink is never coloured, so anything coloured is
ground. (It does *not* measure distance from "the" ground colour — a model's
"flat" green arrives as a patchwork of greens, and that reads every darker
patch as a film of ink and leaves grey ghosts of the patchwork behind.)

Either way, every board is then reduced to exactly two inks — black, white,
clear — at source resolution, and antialiased only by the downscale. See
`../../cast/README.md` for why.

## Which prop stands where

Each card of the landing page names its prop with `data-prop`, and
`src/lib/trail-props.ts` says how tall each stands. Props are scaled against Bo
in tile units of the 300-unit scene (he stands 128), so big things stand big: a
depot or a cottage is taller than he is, a toolbox comes up to his knee.

| Stop | Cards and their props |
|---|---|
| Why — "Two bad landlords, and the open road" | Closed PaaS: company-town gatehouse · Raw cloud: fixer-upper shack · HoBo: signpost |
| How — "Deployment is not a destination" | Bindle: trunk · Camp: tent · Migration: locomotive (and Cog's handcar) |
| Vocabulary — "Four words for traveling light" | Bindle and Camp: mile marker · Yard and Junction: switch stand · Station and Trail: depot |
| Roles — "Who writes what" | Developers: drafting table · Platform engineers: toolbox · DevSecOps: boom barrier |
| AI-native — "Built for humans, and the agents…" | Principals: padlocked gate post · Operators: switchboard · Agents: radio mast |
| Compare — "Other roofs over your head" | the comparison: rooftops |
| Get started — the closing card | cottage |

The arch, airship, lighthouse, water tower and steamboat are still built and
shipped here, but no card uses them: a prop has to stand for something on the
page, and those stood for nothing.

On a desktop each prop stands in the band under its own card; on a phone it
stands beside the card's sign.

## Night

Props are line art, so at night they invert and become chalk on the dark band.

## Resolution

Props are stored 1100px tall (`LANDMARK_H` in the build script), because the
desktop band draws a tall one at up to ~300px and the linework has to stay
crisp on a 2x display.
