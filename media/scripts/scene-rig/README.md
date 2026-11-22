# Scene-rig pipeline

Turns an approved scene prop (see `media/public/reference/scene-props/`) into
a layered, rigged SVG scene component. The signpost → `Crossroads.astro` run
is the reference implementation; the train, depot, blimp and steamboat follow
the same three steps, each with its own segmentation rules.

## Steps

1. **`trace-signpost.mjs`** — segment + trace. Loads the 2048px prop master
   (`media/runs/scene-props/prop-signpost.png`; regenerate from the committed
   webp if the run folder is gone), finds the ink by the same border-flood
   enclosure test the mascot trace uses, splits it into moving-part layers,
   and potraces each into a silhouette path (dark) and a light-interior path.
   Writes `signpost-layers.json` plus a colour-coded `signpost-debug.png` —
   always eyeball the debug overlay before trusting a trace.
   - The post axis is fitted from post-only rows; each board is claimed by a
     lerped slab across the post corridor so slanted boards don't steal
     visible post pixels.
   - Boards drawn in front of the post get a synthetic post bridge behind
     them (base layer) so a wobble never opens a hole.
   - Boards drawn behind the post (`BEHIND` set) are kept continuous with a
     synthetic middle tucked strictly inside the post outline; the base keeps
     the post front and z-order does the occlusion.
2. **`build-signpost-svg.mjs`** — assemble a standalone rigged SVG (used for
   the approval preview artifact).
3. **`gen-crossroads.mjs`** — emit the live Astro component from the layers:
   behind-arms, then base, then front-arms; wobble keyframes per arm around
   its pivot; plates/clouds/Bo composed per `site/src/styles/global.css` night rules.

## Running

The scripts expect `sharp` and `potrace` (`npm i sharp potrace` in a scratch
folder, or reuse `media/runs/scene-props/pipeline/`, which carries a
package.json). They are plain node ESM — run them from a directory containing
the inputs; paths inside are relative except the component output path.

## Approval gate

Nothing generated here replaces a live scene until the owner approves the
prop's preview page. Approved: signpost (crossroads). Pending: train, depot,
blimp, steamboat.
