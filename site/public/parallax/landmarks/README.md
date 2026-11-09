# Landmarks

What stands beside the trail. A plate loops forever; a landmark is *somewhere*
— each one belongs to a stop (a section of the landing page) and pulls alongside
Bo as that section arrives. Where each one stands is declared in
`src/lib/trail-landmarks.ts`; this folder only holds the artwork.

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

## Which landmark stands where

| Stop (section) | Landmarks |
|---|---|
| trailhead — "Pack your bindle and hitch a ride" | mile marker and bindle, timber arch |
| crossroads — "Two bad landlords, and the open road" | company-town gatehouse, fixer-upper shack, signpost |
| main line — "Deployment is not a destination" | trunk and crates, tent and campfire, locomotive, water tower |
| depot — "Four words for traveling light" | handcar, switch stand, depot |
| crew camp — "Who writes what" | toolbox, drafting table, boom barrier, padlocked gate post |
| airfield — the agents section | telephone switchboard, airship, radio mast |
| river — "Other roofs over your head" | rooftops, steamboat, lighthouse |
| home stretch — the closing card | cottage |

Each stands a fraction of the way through its section (`along` in
`src/lib/trail-landmarks.ts`), so a section's props are spread through it at
every screen size instead of bunching at its start.

## Night

Landmarks are line art, so they take the plates' `invert` treatment and become
chalk on the night band, graded by `tone` the same way: the further back a
landmark stands, the dimmer it is.
