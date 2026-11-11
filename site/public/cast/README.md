# The cast

The hobits who are not Bo. Bo walks the trail; these are the travelers who turn
up around him when the page has been still a while — on the trail, and poking
out from behind the page's own boxes (`src/lib/stage/troupe.ts`).

They are their own characters with their own sheets. **Nothing here is Bo's art
and none of Bo's sheets are used for them** — a second character played by the
first one's drawings is the same character.

## The contract

One PNG per character, and every sheet has the same shape, so the machinery
never has to know who it is animating:

| | |
|---|---|
| Grid | 6 columns × 2 rows, 12 cells |
| Cell | 256 × 256 px, grayscale + alpha, 8 levels per channel |
| Feet baseline | 94% down the cell, in every cell |
| Body centre | the cell's centre column, in every cell |
| Standing height | up to 62% of the cell — eased down if a pose would not fit |

`cast.json`, beside the sheets, records the contract and each character's own
numbers (standing height, and how far down a peek must reveal to clear the
eyes). The build writes it and `src/lib/stage/cast.ts` reads it, so the
geometry the page plays and the geometry on disk cannot drift apart.

## Who they are

| Sheet | | |
|---|---|---|
| `tuck.png` | Tuck | stout, in a patched bowler; about Bo's size |
| `pip.png` | Pip | the small one, all striped scarf and one curled tuft |
| `mags.png` | Mags | tall and narrow under a newsboy cap, polka-dot neckerchief |
| `cog.png` | Cog | a wind-up tin hobot — rivets, a visor, a key in the back |

The same pose is in the same cell on every sheet:

| Cell | Pose | |
|---|---|---|
| 0 | stand | facing the viewer; every other size is taken from this one |
| 1 | look left | **derived** from stand |
| 2 | look right | **derived** from stand |
| 3 | blink | **derived** from stand |
| 4 | wave | |
| 5 | startled | |
| 6 | doze | sitting, eyes shut |
| 7 | walk A | side view, heading right |
| 8 | walk pass | legs together, body high |
| 9 | walk B | the other leg leading |
| 10 | run | |
| 11 | run B | the run's second beat (the high walk pose, if only one run was drawn) |

**Anchor at the feet.** A pose swap that changes the character's height must
not move the ground under him, so sprites are positioned by the feet baseline
and the body column, never by their bounding box.

**The three derived cells share the standing pose's silhouette exactly.** They
are made by moving colour only — pupils slid sideways inside their own whites;
eyes closed down to the lower lid they already have — so a character can look
around without his outline boiling. The build fails if a derived cell changes a
single pixel of coverage.

**They only ever face right.** Side views are drawn heading right and are never
mirrored. Some of the cast are asymmetric, and a flip is how a character ends up
with his scarf on the other shoulder — the same mistake as mirroring Bo's bindle.

## Where they come from

```sh
higgsfield auth login                                                        # once; the account's own plan credits
higgsfield generate create gpt_image_2_6 --prompt "<brief>" \
  --image-references <reference> --background transparent \
  --quality high --resolution 4k --aspect_ratio 16:9 --wait                  # -> media/runs/ (gitignored)
# look at the result; promote the good ones to media/public/reference/cast/
uv run media/scripts/build-trail-art.py cast                                 # normalize -> here
```

Two images per character, in order:

1. **A turnaround** — front and right-facing side in one image, with Bo's own
   frames attached as the style reference (`media/scripts/build-style-refs.py`
   composes them). This is where the design is decided.
2. **A pose board** — the same character eight times in a 4×2 grid, generated
   with *that character's turnaround* as the reference. A model keeps a
   character far more consistent within one image than across several, which
   is what makes a set of poses usable as frames.

The briefs are in `media/scripts/jobs/trail-cast.json`. The model was chosen by
running the same briefs through two and looking: GPT Image 2.6 returned crisp,
artifact-free linework on a real transparent background; Nano Banana Pro
returned smeared edges on a patchy chroma ground. The cut-out still handles a
chroma ground and paper (see `../parallax/landmarks/README.md`), but a real
alpha channel is the least lossy thing to start from.

**Every board is reduced to two inks before anything else.** A model asked for
flat black and white still leaves soft shading, grey smudges and specks, and
each one is a visible stain the moment the sprite stands on a page. At source
resolution every pixel is snapped to black, white or clear; the antialiasing the
shipped art needs comes from the downscale, which is why boards are generated
at several times their shipping size. The promoted boards in the Reference tier
are stored as that reduction — three values, so a palette holds them exactly in
30–100 KB.

The board's grid is only where the poses were *asked* to go; it is never used
as a set of crop boxes. Every connected piece of ink is recovered whole and
joins the pose whose cell its centre falls in, so a raised arm is never sliced
along a grid line.

**What review caught.** Tuck's first pose board drifted from his turnaround:
the shaggy fur came back scalloped, and his legs were solid black facing the
viewer but hollow outlines in the side views. It was regenerated with the fur
silhouette and limbs stated explicitly. One Nano Banana Pro board was refused
by the provider's content filter for no visible reason and was not retried
once that model was dropped.

A character joins the cast in `src/lib/stage/cast.ts` only after its sheet has
been looked at, at the size it ships, on both the day and night page.
