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
| Cell | 192 × 192 px, grayscale + alpha, 8 levels per channel |
| Feet baseline | 94% down the cell, in every cell |
| Body centre | the cell's centre column, in every cell |
| Standing height | 62% of the cell |

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
uv run media/scripts/higgsfield-run.py media/scripts/jobs/trail-cast.json   # generate -> media/runs/ (gitignored)
# look at the boards; promote the good ones to media/public/reference/cast/
uv run media/scripts/build-trail-art.py cast                                # normalize -> here
```

Each character is generated as one **pose board**: the same character eight
times on one sheet. A model keeps a character far more consistent within one
image than across several, which is what makes a set of poses usable as frames.
The board is drawn on a flat chroma ground so the cut-out is exact (see
`../parallax/landmarks/README.md` for why).

The board's grid is only where the poses were *asked* to go; it is never trusted
as a set of crop boxes. Each pose is recovered as connected ink, and any loose
piece — a hat in mid-air — joins the pose it is nearest to.

A character joins the cast in `src/lib/stage/cast.ts` only after its sheet has
been looked at, at the size it ships, on both the day and night page.
