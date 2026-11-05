# Plates

Supplied artwork. Almost the whole trail band above the hero is made of these —
the file name is the slot, and the slot fixes where it sits and how fast it goes:

| File | Layer | Speed (ground = 1) | Night | Shipped |
|---|---|---|---|---|
| `sky.png` | furthest back | 0.12x | invert | yes |
| `hills.png` | distant horizon | 0.40x | invert | yes |
| `poles.png` | telephone poles | 0.55x | rim | yes |
| `trail.png` | the ground, behind Bo | 1.00x | invert | yes |
| `trail-front.png` | the near bank, in front of Bo | 1.00x | invert | yes |

The clouds are **not** a plate — they live in `../clouds/` as individual crops,
because each one squashes on its own and a single background image can only
move as a whole. See `src/lib/trail-clouds.ts`.

Also accepted: `.webp`, `.avif`, `.jpg`, `.gif`, `.svg`. An empty slot renders
nothing.

Two things the band needs from a plate:

- **It has to repeat cleanly left to right.** The band tiles it end to end; it
  does not mirror the join or blend across it. If the left and right edges do
  not continue each other you will see the seam go past every loop.
- **Compose it full height, at its scene position.** The whole image height maps
  onto the band height, so a plate is a full-height canvas with its content
  placed where it belongs vertically — not a tight crop. The canvas convention
  here is 600px tall, which is 2px per tile unit of the band's 300-unit scene.

Nothing else is needed. The aspect ratio is read out of the file header, the
tile is sized from it, and the scroll duration is derived from that width so
every plate travels at the speed its slot claims and lands the loop back on the
pixels it started from.

## Night

A slot also declares how it becomes its night self, because one rule does not
fit everything the scene is made of:

- **invert** — ink and paper swap. Right for line art that reads as drawing:
  the ground is black on white by day and white on black by night.
- **keep** — the artwork's own ink is the point. A cloud is white *because
  clouds are white*; invert it and it becomes a hole in the sky.
- **rim** — the silhouette stays dark and gets an outline instead, the same
  treatment Bo takes. A telephone pole is a creosote post at noon and at
  midnight; it should be picked out against the dark, not turned into a white
  post.

Each is then graded by the slot's `tone`. By day the paper sits behind
everything and distance reads as detail falling away, but at night distance
reads as *light* falling away — so without it every layer arrives at the same
brilliant white and flattens the depth the parallax just built. Tone tracks the
parallax speed, because that is what depth is here: the slower a layer goes
past, the further away it is, and the dimmer it should be. The rim colour is
mixed toward the background rather than picked as a grey, so it stays correct
in both themes and at any tone.

## How the shipped plates were made

All of them come from the reference plates. Each object was cut out, cropped to the
rows it actually occupies, and normalized to the same 6-level grayscale + alpha
the Bo sprite sheets use — 2.6MB of source crops became ~95KB of plates.

- `poles.png` — three post crops on a 2400px tile, which is exactly 2x the
  1200-unit drawn tile, so the generated wires line up with them. The pole
  centres are repeated in `src/lib/trail-art.ts`; move one and move both.
- `trail.png` / `trail-front.png` — one ground strip, split at the emptiest row
  in it (0.33% ink) into the part behind Bo and the near bank in front of him,
  then each mirrored into an `A A'` tile. Mirroring is what makes an arbitrary
  piece of artwork tile: the join is an exact edge match by construction. The
  best plain-repeat crop of this strip still left a 6.3/255 mismatch, which on
  line art is a visible jog in the ridge.

Grayscale is not incidental — it is what makes the night theme free. Plates take
`filter: invert(1)` in dark mode, which is exactly this design system's ink and
paper inversion.

## How `sky` and `hills` were made

Both slots sat empty until the trail band had a real horizon. The drawings are
generated — Higgsfield `nano_banana_2`, 21:9, 2k — and then put through the same
normalization the reference plates got. **Generation is the easy half.** A model
will not give you a tile, and the four steps that turn a picture into one are
where all the failure modes live:

1. **Ink to alpha.** Paper level is measured off the corners, not assumed white:
   these render on textured off-white stock, so a fixed threshold either eats the
   lightest linework or keeps the paper grain as faint ink. Coverage is then
   posterized to the same 6 levels as the Bo sheets.
2. **Denoise before measuring.** The hills drawing had one speck in the top-right
   past the end of the hill band. Taking the outermost inked pixel put the crop
   edge 32px beyond where the band stopped, and mirroring turned that margin into
   a **64px hole sitting exactly on the seam** — a gap in the horizon, once per
   loop. Thresholding on row/column ink weight does not fix it: on the sky plate
   one dense ridge line dwarfs the faint clouds, so any threshold high enough to
   reject the speck also crops the cloud tops. Ink weight is the wrong axis; size
   is the right one. Components under ~0.02% of the frame are dropped, *then* the
   box is measured.
3. **Inset, then mirror `A A'` without repeating the edge columns.** A drawing
   ends — the hill mass stops at a hard vertical edge where the pen lifted. Fold
   on that column and the reflection turns a straight border into a spike, so the
   crop is pulled 3% inward first and the fold lands on organic contour. The
   reflection runs `c0..c(n-1)` then `c(n-2)..c1`: a plain reverse emits `c(n-1)`
   twice at the fold and `c0` twice across the wrap, and a doubled column of a
   near-vertical stroke draws as a hairline down the join — twice per loop, which
   is the artifact mirroring exists to avoid. Wrap continuity is then exact by
   construction, not by eye: the last column *is* `c1`, measured at 0/255.
4. **Place at the scene position.** `sky` spans scene units 30–150, `hills`
   120–199. 199 is deliberate: the ground plane starts at 198, so the hills' flat
   base lands on the horizon rather than floating above it. Seating it lower does
   not work — the trail is line art and never exceeds ~45% coverage, so a hill
   mass extended behind it shows through the gaps as a black smear.

The result is 38KB for both. If you replace either drawing, the numbers that
matter are the scene units above and the 6-level posterization; everything else
is recoverable by eye.
