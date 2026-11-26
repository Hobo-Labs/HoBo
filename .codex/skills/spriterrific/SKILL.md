---
name: spriterrific
description: "Use for Spriterrific repo workflows: canonical pixel-sprite anchors, image action pose boards, video walk-cycle curation, frame picker/aligner handoffs, run folder reviews, and 256x256 runtime spritesheet exports."
metadata:
  short-description: "Spriterrific project workflow."
---

# Spriterrific

Spriterrific turns text or source images into reviewable, game-facing 2D character anchors and animation spritesheets. This skill holds the project-specific defaults and decisions so generic image, video, pixel-snapper, and gamedev skills stay reusable.

## Philosophy: Generate Poses, Ship Runtime Frames

Do not ask AI models to produce the final engine artifact directly. Ask them for clean, reviewable source material, then let Spriterrific recover, normalize, and pack runtime assets.

**Before acting, ask**:
- Is this anchor setup, image-generated action sheets, or video-derived motion?
- Does the user want pure pixel-snap output with real recovered pixels, or high-fidelity mixel output where AI pixel texture is acceptable?
- What is the generation-friendly source shape, and what is the final runtime export shape?
- Which step needs human review: candidate anchor, frame selection, normalization, or final alignment?
- Are we preserving a model output for audit before cleaning or normalizing it?

**Core principles**:
1. **Separate generation from runtime**: model-friendly canvases and engine-facing sheets are different artifacts.
2. **Use approved anchors**: animation starts from direction-specific 1024x1024 pixel-snapped chroma anchors.
3. **Recover before polish**: preserve raw outputs, recover frames/components, then remove backgrounds and clean edges.
4. **Normalize visibly**: every normalization boundary needs before/after review assets.
5. **Prefer explicit handoffs**: frame picker, post-selection processor, finalizer, and frame aligner should hand off through canonical folders and reports.
6. **Never trust invisible grids**: implied pose-board cells are review hints only; runtime frames must come from recovered foreground components or pose regions.
7. **Finalize every runtime export**: before promotion to `public/assets`, run the deterministic runtime finalizer so image and video workflows obey the same anchor contract.

## Output Mode Gate

Before generating or refining source images, candidates, anchors, or action sheets, choose the output mode. If the user has not already chosen, ask directly and briefly:

```text
Do you want this run to target:

1. Pixel-snap / real pixels: stricter, lower-detail `lobit-v1` art that can be recovered onto a real pixel grid. This is purer pixel art and better for editing, palette control, and consistent runtime spritesheets.
2. Mixels / high fidelity: richer AI-generated pixel texture at the target resolution. This is simpler and can look more detailed, but it is not a true recoverable pixel grid and should not be treated as snap-ready later without a low-bit distillation pass.
```

If the user supplies a reference image, also determine whether the image is a
loose identity reference or a strict style/identity authority. Ask this when it
is unclear:

```text
Should Spriterrific preserve this reference image's exact style and proportions,
or should it distill the character into Spriterrific's default low-bit style?
```

Carry the choice through the whole workflow:

- **Pixel-snap / real pixels**: use constrained `lobit-v1` prompting: limited 8 to 12 color feeling, big pixel clusters, clean stepped edges, compact readable silhouette, no tiny accessories, no ornate trim, no texture noise, no cloth-fold detail, and avoid 200+ pixel high-detail native snaps. Default to `--k-colors 64` for pixel-snapped outputs unless the user explicitly asks for a broader palette experiment.
- **Mixels / high fidelity**: higher fidelity and AI-created mixed pixels are acceptable if they suit the game target. This can be the simpler path for high-resolution game art. Use `--candidate-prompt-preset high-fidelity-v1 --no-pixel-snap-anchor` for anchors in this mode unless the user explicitly wants a snapped anchor. That also makes prompt-only source generation use high-fidelity constraints instead of the strict low-bit/lobit source prompt. Do not claim it is pure pixel art or snap-ready. If the user later wants pixel snapping, add a low-bit `lobit-v1` distillation step first.
- **Reference-preserving source image**: when the user says "preserve this character", "same style", "do not change the chibi look", or similar, use `--candidate-prompt-preset preserve-reference-v1`. Pixel snapping is still a separate decision: add `--pixel-snap-anchor` to snap/clean the preserved reference style, or `--no-pixel-snap-anchor` for richer source-faithful mixels. Do not route that request through `lobit-v1` unless the user explicitly wants style distillation.
- **Identity-preserving edit of an existing character**: when the user wants the *same* character with one thing changed — a new outfit, a swapped prop, different armor — pass the existing anchor as `--source-image` together with `--edit-prompt "<only the delta>"`. This selects `edit-reference-v1` and keeps face, skin tone, hairstyle, proportions, pose, and rendering style pinned to the input. Do not regenerate the character from a text prompt for a variant request; identity drifts.
- If the user intentionally disables pixel snap for a branch, keep prompts honest about that branch: preserve readable sprite structure, but do not force the strict low-bit constraints unless the output will later be snapped.

## Predefined Style: `lobit-v1`

`lobit-v1` is Spriterrific's predefined pixel-snap-bound anchor style. It is not
a model keyword and should not be sent to image/video models as if they know
what it means. It means:

- deliberately simple low-bit pixel-sprite production art
- limited 8 to 12 color feeling
- big readable pixel clusters and clean stepped edges
- compact silhouettes that remain readable inside 256x256 runtime cells
- broad identity preservation only, with tiny details collapsed into a few big
  visual cues
- no ornate trim, jewelry, stitching, buttons, buckles, texture noise,
  fabric weave, cloth-fold detail, or layered micro-props
- native snapped candidate height should feel roughly `100-130px`; overly
  tall/dense candidates are rejected by the guarded candidate path

Docs, CLI flags, metadata, and skills may refer to `lobit-v1`. Model-facing
prompts should spell out the visual constraints instead of using
`Spriterrific`, `lobit-v1`, or other project-specific names.

## Predefined Style: `high-fidelity-v1`

`high-fidelity-v1` is Spriterrific's predefined high-fidelity/mixel anchor
style. Use it when the user wants game art with richer AI pixel texture and is
not trying to recover a strict native pixel grid at the anchor stage. Pair it
with `--no-pixel-snap-anchor`.

It means:

- high-fidelity 2D pixel-art-inspired game sprite
- richer color ramps and texture are acceptable
- mixed pixels are acceptable at the target game resolution
- preserve more of the source identity and style than `lobit-v1`
- still keep one centered full-body/object anchor on an exact flat chroma matte
- no scenery, shadows, checkerboards, faux transparency, or cropped limbs

Model-facing prompts should spell out these constraints. Do not send
`high-fidelity-v1` as if the image/video model understands the project preset.

## Predefined Style: `preserve-reference-v1`

`preserve-reference-v1` is Spriterrific's predefined source-faithful anchor
style. Use it when the user provides a reference image and wants the same
visual design preserved, especially chibi proportions, head/body ratio,
silhouette, outfit, palette, line weight, rendering style, facial design, and
shape language.

For `--source-image` runs without a custom candidate prompt, the CLI may skip
the generative candidate edit hop and use the normalized source image directly
as the candidate before optional anchor pixel snapping. This reduces style drift.

It means:

- source image is strict visual authority, not just broad identity input
- do not redesign, mature, de-chibi, normalize, westernize, or reinterpret
- only adapt canvas/background/facing as required
- pixel snapping and palette cleanup may happen later, but they must not imply
  an aesthetic redesign
- still require one centered character/object on an exact flat chroma matte for anchor
  handoff

## Predefined Style: `edit-reference-v1`

`edit-reference-v1` is Spriterrific's identity-preserving edit style for
character variants. Use it when the user wants an existing character changed
in one named way (outfit swap, prop change, armor variant) while staying
recognizably the same character. It is selected automatically by
`--edit-prompt` and requires `--source-image` (normally a previous run's
anchor).

It means:

- the source image is the same character, not just a style reference
- apply only the edit instruction's delta
- keep face, facial features, expression, skin tone, hairstyle, body
  proportions, pose, camera, rendering style, and palette relationships
  identical
- keep the flat chroma matte background

Write `--edit-prompt` as a delta only ("replace the robes with a white
hoodie"), never a full character description — everything not named is
preserved by the keep-list. Do not use a text `--source-prompt` regeneration
for variant requests; a fresh generation invents a new face and style.

## Chroma Matte Choice

Default Spriterrific runs use chroma green `#00FF00`, but that is unsafe when
the foreground itself is green. If the subject is green, teal, lime, or has
important green highlights, pass a safer matte through every engine command:

```bash
--chroma "#FF00FF"
```

Use the same `--chroma` value for `bootstrap-anchors`, `run`, `run-actions`,
and `process-selection`. The SDK `animate`/`ask` wrapper should inherit the
referenced anchor run's recorded matte color; if you call the Python CLI
directly, pass the matte explicitly. The model-facing prompt should name the
chosen matte color, and cleanup should key that color back to transparent
black. Fringe cleanup is chroma-aware: any saturated matte color (green
`#00FF00`, magenta `#FF00FF`, cyan `#00FFFF`) gets a matte-relative edge
sweep. The sweep is a pre-scale edge pass only; do not run another sweep
after downscaling into runtime cells. Green runs write
`green-fringe-metadata.json` (`removedGreenFringePixels`); other mattes write
`fringe-metadata.json` (`removedFringePixels`). If cleanup metadata reports a
high removed-to-kept ratio, treat the result as suspect and rerun with a
matte color absent from the character or `--no-green-fringe-cleanup`. After
fringe cleanup, a despill pass clamps matte-dominant channels toward the
suppressed level (for green, `g = min(g, max(r, b))`) to neutralize residual
matte tint without deleting pixels. The pass is auto-gated per run: it
measures matte-colored pixels deep inside the silhouette across all frames,
and when the character genuinely carries that color (green skin, olive
clothing) it despills only the transparent-edge band; otherwise it despills
the whole foreground, because video models can paint matte tint well inside
dark costumes. Whole-image passes still protect saturated interior art
islands (e.g. green eyes on a black cat), and every run also gets a green
despill axis even on magenta/cyan mattes, since video-codec ringing reads as
a green ring regardless of matte color. Despill is gated by the same
keyable-matte/`--no-green-fringe-cleanup` controls and is skipped on
pixel-snap runs. To fix matte bleeding on assets that already shipped (or
were produced by an older engine), run the headless `spriterrific despill
--auto --sheet <spritesheet.png> --chroma <matte>` (or `--input-dir
<frames>`) instead of re-running the whole pipeline; `--auto` applies the
same gate, while the legacy default stays band-only and `--whole-image`
forces the aggressive clamp.

Do not combine `preserve-reference-v1` with an inline `--candidate-prompt`
unless intentionally overriding the preset. A custom candidate prompt disables
the source-preserving shortcut.

## Point-And-Click Adventure Profile

For classic point-and-click adventure characters, use Spriterrific's
`adventure` game view and keep the direction model simple:

- Use `--game-view adventure`.
- Use `--directions sw` for the left-facing front-three-quarter adventure
  anchor. This is not a true platformer side profile.
- Do not invent `--facing` or `--mirror`; runtime/game code can mirror the
  `sw` anchor when asymmetry does not matter.
- Pair high-fidelity or source-faithful adventure references with
  `--candidate-prompt-preset high-fidelity-v1 --no-pixel-snap-anchor` or
  `--candidate-prompt-preset preserve-reference-v1 --no-pixel-snap-anchor`
  unless the user explicitly wants pixel snapping.

Adventure animation contract:

- Template/profile: `--animation-template point-and-click`
  and `--preset-profile point-and-click`.
- Default action set:
  `idle,walk,talk,interact,pick_up,use,examine,give,shrug`.
- Point-and-click verbs are video-first by default.
- `idle`, `walk`, and `talk` use 12-frame loops in the point-and-click
  profile.
- `interact`, `use`, `examine`, `give`, and `shrug` use 10-frame video
  one-shots returning toward idle.
- `pick_up` uses a 12-frame video one-shot returning toward idle.

Use `interact` as the compact two-verb game action when a project collapses
take/use into one context-sensitive verb. Use `talk` for dialogue gestures; it
is a head/hand gesture loop, not lip-flap sync.

## Codex Image Generation Choice

When running inside Codex, do not automatically use FAL just because live provider keys are configured. Codex has a built-in `imagegen` path that can be used for still-image generation stages when the outputs are saved as explicit Spriterrific handoff artifacts and the deterministic Spriterrific CLI stages still do recovery, snapping, normalization, packing, and review.

Use concise language:

```text
For still-image stages, I can use Codex's built-in imagegen tool and then feed the saved outputs back through Spriterrific's CLI processing. Walk/run video cycles still need a configured video provider such as FAL. Do you want a hybrid Codex-imagegen path, or should we wait for FAL?
```

If the user already explicitly asks to run a Spriterrific CLI command, run the CLI path and check whether live provider generation is configured:

```text
FAL_KEY or FAL_API_KEY
```

If neither key is present and the user wants platformer spritesheets, offer a hybrid path rather than reducing imagegen to mockups only:

```text
FAL is not configured here. We can still use Codex imagegen for the still-image stages: source/reference, front candidate, W-facing anchor, and image-generated action pose boards such as idle, attack, hurt, jump, and death. Spriterrific should still process those saved images through its CLI for pixel snapping, frame recovery, normalization, spritesheets, GIFs, metadata, and reviews. Walk/run video cycles should be deferred until FAL or another video provider is configured.
```

Use built-in `imagegen` for:

- character concept images
- side-scrolling gameplay mockups
- visual target references
- rough source images that can later be used with `--source-image`
- prompt/style exploration
- front-facing candidate and W-facing anchor image generation when the output is saved and fed into Spriterrific as `--candidate-image`, `--accepted-candidate`, or equivalent handoff input
- still-image action pose boards for actions such as `idle`, `attack`, `hurt`, `jump`, and `death`, when saved under the `run-actions --existing-sheet-root` layout
- still-image point-and-click fallback pose boards only when the user
  explicitly asks for image mode; by default, `talk`, `interact`, `pick_up`,
  `use`, `examine`, `give`, and `shrug` should use the video workflow

Do not use built-in `imagegen` for:

- video walk cycles
- video run cycles
- any stage where the user specifically requires the live Spriterrific CLI provider path

Do not claim that built-in `imagegen` alone produced final runtime spritesheets. The correct wording is that Codex imagegen produced the generation source image or pose board, then Spriterrific CLI processed it into runtime assets.

If the user wants the full live provider pipeline and FAL is missing, explain the missing key and give the setup path rather than silently switching:

```text
The full live Spriterrific provider path needs FAL_KEY or FAL_API_KEY. Without it, I can run a hybrid path: use Codex imagegen for still-image generation handoffs, process those through Spriterrific CLI, and defer image-to-video motion until a video provider is configured.
```

When generating a built-in imagegen source/reference, anchor, or action pose board for later Spriterrific use, save it into the project, preferably under a timestamped `runs/<run-id>/` folder, and report the path. For action pose boards that should become runtime spritesheets, save them in this shape so `run-actions --existing-sheet-root` can consume them:

```text
runs/<imagegen-action-root>/
  idle-w/generated/sheet.png
  attack-w/generated/sheet.png
  hurt-w/generated/sheet.png
  jump-w/generated/sheet.png
  death-w/generated/sheet.png
```

Then process them with:

```bash
uv run spriterrific run-actions \
  --actions idle,attack,hurt,jump,death \
  --direction w \
  --reference runs/<bootstrap-run>/anchors/w/anchor-snapped-1024-chroma.png \
  --run-dir runs/<character-actions-run> \
  --mode image \
  --existing-sheet-root runs/<imagegen-action-root> \
  --pixel-snap \
  --pixel-snap-source chroma-layout \
  --k-colors 64
```

## Canonical Workflows

### Current Happy Path

Use this sequence when the user wants the main Spriterrific product flow today. It is not yet one monolithic command; it is a stable set of CLI stages that all go through `spriterrific` package code.

1. Bootstrap the front-facing platformer candidate and default W-facing anchor from a prompt:

```bash
uv run spriterrific bootstrap-anchors \
  --character-id <character-id> \
  --source-prompt "<prompt>" \
  --directions w \
  --game-view platformer \
  --anchor-role character \
  --anchor-context "side-scrolling platformer character, true W profile" \
  --k-colors 64
```

Or bootstrap from a user/reference image:

```bash
uv run spriterrific bootstrap-anchors \
  --character-id <character-id> \
  --source-image path/to/reference.png \
  --directions w \
  --game-view platformer \
  --anchor-role character \
  --k-colors 64
```

If the reference image's style and proportions should be preserved:

```bash
uv run spriterrific bootstrap-anchors \
  --character-id <character-id> \
  --source-image path/to/reference.png \
  --candidate-prompt-preset preserve-reference-v1 \
  --directions w \
  --game-view platformer \
  --anchor-role character \
  --pixel-snap-anchor \
  --k-colors 64
```

For a high-fidelity/mixel anchor path, keep the same bootstrap flow but set the
style and disable anchor snapping:

```bash
uv run spriterrific bootstrap-anchors \
  --character-id <character-id> \
  --source-image path/to/reference.png \
  --candidate-prompt-preset high-fidelity-v1 \
  --no-pixel-snap-anchor \
  --directions w \
  --game-view platformer \
  --anchor-role character
```

Transparent `--source-image` inputs are safe to use. Spriterrific preserves the
original PNG under `input/source-original.png`, creates
`input/source-model-input.png` by compositing transparent pixels onto exact
chroma green, and sends that model input to the candidate image-edit stage.
If a provider bakes checkerboard/faux transparency into the candidate anyway,
the CLI should fail before pixel snapping instead of accepting the broken
candidate.

If the asset is an enemy, turret, prop, top-down character, or anything other
than a plain platformer character, set the context explicitly instead of
relying on defaults:

```bash
uv run spriterrific bootstrap-anchors \
  --character-id <character-id> \
  --source-image path/to/reference.png \
  --directions w \
  --game-view platformer \
  --anchor-role enemy \
  --anchor-context "side-scrolling platformer enemy, true screen-left side profile, preserve one clear claw/melee arm" \
  --k-colors 64
```

Expected anchor artifacts:

```text
runs/<bootstrap-run>/input/source.png
runs/<bootstrap-run>/candidate/front/anchor-1024-chroma.png
runs/<bootstrap-run>/candidate/front/snapped-1024-chroma.png
runs/<bootstrap-run>/anchors/w/anchor-1024-chroma.png
runs/<bootstrap-run>/anchors/w/anchor-snapped-1024-chroma.png
runs/<bootstrap-run>/bootstrap.json
runs/<bootstrap-run>/character.json
runs/<bootstrap-run>/events.jsonl
runs/<bootstrap-run>/review/bootstrap/index.md
```

2. Generate selected image actions from the accepted W anchor:

```bash
uv run spriterrific run-actions \
  --actions idle,attack,hurt,jump,death \
  --direction w \
  --reference runs/<bootstrap-run>/anchors/w/anchor-snapped-1024-chroma.png \
  --run-dir runs/<character-actions-run> \
  --mode image \
  --pose-board-preset hires \
  --frame-prompt-style loose \
  --pixel-snap \
  --pixel-snap-source chroma-layout \
  --k-colors 64
```

Current implementation note: `run-actions` runs actions sequentially. Parallel image-action jobs are a future product/API orchestration improvement, not current CLI behavior.

3. Generate a walk cycle video from the accepted W anchor:

```bash
uv run spriterrific run \
  --action walk \
  --direction w \
  --mode video \
  --reference runs/<bootstrap-run>/anchors/w/anchor-snapped-1024-chroma.png \
  --run-dir runs/<character-walk-run>
```

If there is already one approved runtime sheet or frame folder for the same
character/enemy, derive a size contract first and pass it into video generation:

```bash
uv run spriterrific size-contract \
  --source public/assets/enemies/<enemy-or-character>/idle.png \
  --out characters/<id>/size-contract.json \
  --action idle \
  --direction w \
  --pivot foot-center
```

Use `--pivot base-center` for planted enemies such as turrets and
`--pivot foot-center` for humanoids. Then add
`--size-contract characters/<id>/size-contract.json` to video `run` commands.
This appends locked-camera, stable-scale, and fixed-pivot guidance to the model
prompt. It does not render guides or measurement marks.

Tell the user that this defaults to Grok Imagine
(`grok-imagine-video-i2v`). Only use `--video-model wan-2.2-a14b-i2v-turbo`,
`--video-model seedance-2.0-i2v`, or `--video-model wan-2.7` when the user
explicitly asks to compare those models. Prefer the shortest
provider-supported video setting for spritesheets. This is a quality rule, not
only a cost rule: a short motion sample gives the model less time to drift the
character's identity, costume, palette, scale, or background. WAN turbo has no
duration field and uses a short frame-count request, Grok Imagine supports
`duration=1`, WAN 2.7 starts at `2` seconds, and Seedance starts at `4`
seconds. Prefer several short attempts over one long cinematic clip. Use
`--video-duration` only with a model-supported value.

When the pipeline uses Grok Imagine for `walk` or `run`, Spriterrific defaults
that request to `duration=2` because runs showed `duration=1` often does not
include a complete stride cycle (burst-stop motion with one stride half and
non-alternating arms). Still use shorter clips for non-locomotion actions
unless review evidence says otherwise.

If a generated `walk` reads too much like a run, do not only strengthen the
prompt. Use all three controls when appropriate:

- `--action-context` for pose semantics, e.g. slow relaxed walk, upright torso,
  no sprint lean, one foot near-planted.
- `--fps 7` or `--fps 8` when the poses are acceptable but playback is too
  fast.
- `--cycle-start-fraction` and `--cycle-span-factor` when the good cycle starts
  later in the video or needs a wider dense-frame window. For exact recovery,
  use `--selected-range` or `--selected-order` with `--existing-video`.

For video generation, treat shadows as engine-side presentation, not sprite
source. The provider prompt should forbid baked shadows, contact shadows,
ground shadows, floor lines, ground lines, base ellipses, reflections, dust
puffs, and platform/floor planes. Foot contact means pose timing only. If a
run adds a green ground line or contact mark under the character, flag the
source frames for rerun or cleanup before export; do not promote the line as
part of the sprite.

For video actions, the top-level video command writes a conservative
preserve-canvas runtime preview by default. Image-to-video models already return
equal-sized frames from one camera canvas; do not recenter each frame by
foreground bbox unless the user explicitly asks for `--layout-mode
fit-foreground` / `--normalize-foreground`. `--video-recovery
preserve-canvas` and `--preserve-video-canvas` are explicit aliases for this
path.

Preserve-canvas is still a cleanup path, not a raw copy path. It must key the
video background to transparent black, run matte-aware edge cleanup where
appropriate, preserve source-canvas placement, and write
`export/preserve-canvas.json` plus `normalized/preserve-canvas-metadata.json`
so the run proves cleanup happened. Treat the automatic preview as a quick
review artifact, not the preferred final curation step when the loop matters.
Preserve-canvas cleanup must use the configured matte, not hard-coded green,
and any green-specific cleanup should happen before scaling into runtime cells.

Current video model names are defined in `src/spriterrific/presets.py`.
`wan-2.7` exists in the public repo, but it is an opt-in experiment rather
than the default recommendation.

4. Open the frame picker for the walk video:

```bash
uv run spriterrific frame-picker \
  --run-dir runs/<character-walk-run> \
  --frames 8 \
  --action walk \
  --direction w \
  --reference runs/<bootstrap-run>/anchors/w/anchor-snapped-1024-chroma.png
```

In the frame picker, use start/end plus Distribute for a first pass, then adjust
individual frames directly. Clicking a thumbnail previews and toggles that
frame, space toggles the current frame, and shift-click selects a range. Save
the report when the selected order loops cleanly.

If the user explicitly chooses WAN 2.7 for walk/run clips, expect an early
warm-up or settling segment before the usable loop. Start frame review around
the middle of the clip rather than accepting the first non-duplicate motion
window. Prefer a compact later loop with clear foot-down/passing poses and no
drawn floor/contact marks, and use 10 frames for public run sheets when the
motion supports it.

5. Process the selected walk frames:

```bash
uv run spriterrific process-selection \
  --picker-dir runs/<character-walk-run>/frame-picker/<timestamp> \
  --out-dir runs/<character-walk-run>/post-selection/walk-pixel-snap \
  --action walk \
  --direction w \
  --columns 5 \
  --fps 10 \
  --preserve-motion \
  --pixel-snap \
  --pixel-snap-mode locked-grid \
  --pixel-snap-workers 4 \
  --size-contract characters/<id>/size-contract.json \
  --review-upscale 4 \
  --k-colors 64
```

`--preserve-motion` is the default for `walk`/`run` when `--action` is supplied,
but include it in recommended commands so the intent is explicit. Use
`--normalize-foreground` only as a second review branch when selected frames
need forced height/baseline consistency more than natural stride motion.

For video-derived Grok/WAN outputs, prefer a non-pixel-snap
`--preserve-motion` branch first when the source frames already have stable
camera framing and the game can accept mixel texture. If the user wants real
pixel-snapped video frames, use `--pixel-snap-mode locked-grid`, not the
default per-frame discovery mode. Locked-grid discovers one native grid from a
selected frame, writes `pixel-snapped/native/pixel-snap-grid.json`, and reuses
that grid for all selected frames so the snapped native canvas stays fixed.
Use per-frame discovery for independent image-action frames, not stable video
loops, unless the user is deliberately experimenting.

When `--size-contract` is present, `process-selection` fills unset target
height, max width, center x, bottom y, and runtime cell defaults from the
contract, then writes `size-contract-audit.json`. Use
`--size-contract-strict` only when a warning should fail the run before export.
Do not use the contract to hide bad generation; use it to reject or flag scale,
bottom-anchor, or width drift before promotion.

6. Optionally open the frame aligner for final runtime nudging:

```bash
uv run spriterrific frame-aligner \
  --input-dir runs/<character-walk-run>/post-selection/walk-pixel-snap/frames-256x256 \
  --out-dir runs/<character-walk-run>/frame-aligner/walk-final \
  --columns 5 \
  --fps 10 \
  --zoom 3
```

If the user asks whether the full product flow works, answer precisely: the pieces work as CLI stages, but the staged product/API orchestrator with approvals, action job records, parallel execution, and walk-cycle API endpoints is not complete yet.

### Anchor Setup
- Input can be a text prompt or user image.
- Use `uv run spriterrific bootstrap-anchors` for the concrete platformer-first bootstrap case: text-or-image input -> generated/accepted source -> lower-fidelity front-facing identity candidate -> pixel-snapped front anchor -> optional directional anchors, usually W first.
- Direction prompts must carry game context. Use `--game-view`, `--anchor-role`,
  and `--anchor-context` for side-scroller enemies, turrets, props, objects, or
  top-down workflows so bootstrap does not silently apply the wrong facing,
  anatomy, or weapon assumptions.
- For RTS, tactics, or Warcraft-style units, prefer
  `--game-view rts-oblique` over plain `top-down`. This mode pushes source,
  candidate, and direction prompts toward an elevated oblique RTS camera,
  visible top planes, foreshortened unit proportions, and ground-plane contact.
  It also auto-normalizes the base candidate from `front` to `south` and
  targets a small compact unit footprint, usually around 35-45% of the canvas
  height, so the candidate is not a straight-on portrait, tall character
  turnaround, platformer side view, or fighting-game sprite. `isometric-rts` is
  only a backwards compatibility alias for `rts-oblique`.
- Treat `top-down` and `isometric` as experimental game views. They are
  available for loose overhead and true tactics/diamond-tile experiments, but
  they are not as proven as `platformer` and `rts-oblique`; say this plainly to
  the user before recommending them.
- Eight-direction anchor sets are supported with
  `--directions n,ne,e,se,s,sw,w,nw`. For asymmetric weapons or silhouettes,
  generate/review all eight; mirroring should be a deliberate later choice, not
  an assumption baked into the anchor run.
- Convert to a lower-fidelity pixel-sprite candidate before directional anchor generation when the output is intended for pixel snapping. The default `lobit-v1` preset is Spriterrific's predefined snap-ready anchor style; higher-fidelity/mixel art can be fine for non-snapped game assets, but should pass through a low-bit distillation step before snapping.
- Do not approve candidates whose native snapped height is still high-detail/dense. The guarded `lobit-v1` path should aim for roughly `100-130px` native height and reject candidates above the hard ceiling.
- Pixel snap and upscale to 1024x1024 on flat chroma.
- Generate W first from the accepted front-facing anchor for side-scroller/platformer work. Use `--candidate-facing south` for top-down workflows where south is the correct gameplay facing language; `--game-view rts-oblique` does this automatically. N/S/E and diagonals can be added later with explicit `--directions`; E can be flipped from W only when appropriate if a workflow supports that handoff.
- Always check anchor facing before the animation stage. Image models (notably
  Nano Banana 2 Lite) often ignore "facing screen-left" and emit the character
  facing the other way; because the engine assumes WEST-authored art, that
  mirrors every downstream clip and forces a full regen pass. `bootstrap-anchors`
  now does this automatically for side profiles (`platformer`/`adventure`,
  `w`/`e`): it estimates facing from the silhouette, writes a `facing-check.json`
  per direction plus a `facingChecks` block in `bootstrap.json`, and with
  `--auto-orient` (default on) flips a wrong-way anchor and all its variants to
  canonical (`w` = screen-left, `e` = screen-right). Read the CLI/review facing
  line: `ok` and `auto-oriented` are safe to proceed; on `mismatch` or
  `uncertain`, eyeball the anchor and regenerate/flip before generating the set.
  Use `--no-auto-orient` to only warn, or `--no-check-facing` to skip.
  Silhouette estimates are verified by a secondary automated visual check
  (via the fal key, negligible cost); a conclusive visual verdict takes
  precedence, which both resolves inconclusive silhouettes (large rounded
  heads) and vetoes inverted ones (trailing tails, oversized rear ears)
  before a wrong flip can mirror the animation set. Auto-orient flips now
  require that corroboration: when the visual check is inconclusive, the
  silhouette alone cannot flip — the run falls back to reference-locked
  prompts instead (with `--no-check-facing-vlm`, or without a fal key, the
  pre-VLM silhouette-only behavior applies). The verdict is recorded in
  `facing-check.json`. Use `--no-check-facing-vlm` to rely on the silhouette
  alone on `run` and `bootstrap-anchors`.
- `run` repeats the same facing gate on the reference anchor as a safety net
  for arbitrary user anchors. Eligibility matches bootstrap: only directions
  that are pure side profiles for the run's `--game-view` are checked
  (`platformer`/`adventure` `w`/`e`); generic-view `w`/`e` are 3/4 views and
  are never checked or flipped. With `--auto-orient` (default on) it flips
  the working copy of a wrong-way reference to canonical before generating
  and records `facing-check.json` plus `facingCheck`/`warnings` in
  `run.json`. When it cannot confidently flip (auto-orient off, an
  `uncertain` silhouette, or an uncorroborated flip), it switches the video
  prompt to reference-locked facing language ("keep the same facing as the
  input image") instead of naming an absolute screen side, because an
  absolute directive fighting a wrong-way anchor makes video models swing
  the character around mid-clip. The caller's original reference file is
  never modified.
- Use `--no-directions` when the user only wants the front-facing candidate anchor.
- Pixel snap final anchors again and keep raw, snapped, and chroma variants reviewable.
- If a manual/corrective anchor is accepted after review, promote it with
  `uv run spriterrific accept-anchor --run-dir <run> --direction <d> --source <1024-chroma-anchor>`
  so `anchors/<direction>/`, `accepted/<direction>/`, `character.json`,
  `bootstrap.json`, and `events.jsonl` agree on the canonical anchor.
- Do not call the fal image scripts or pixel-snapper scripts directly for this bootstrap flow. Use Spriterrific CLI/API entry points so `bootstrap.json`, `character.json`, `events.jsonl`, prompt files, raw outputs, snapped outputs, and review pages stay in the canonical run folder.
- Canonical platformer bootstrap files live under `input/source.png`, `candidate/front/`, `anchors/<direction>/`, `config/`, `bootstrap.json`, `character.json`, `events.jsonl`, and `review/`. Legacy/top-down south candidate runs may use `candidate/s/`.

### Image-Generated Actions
- Pose-board presets:
  - `standard`: `1536x1152`, `4:3`, `4 columns x 3 rows`, `384x384` cells.
  - `hires`: `2048x1536`, `4:3`, `4 columns x 3 rows`, `512x512` cells.
- `hires` means higher source/cell resolution for generation and pixel-snap recovery; it does not change runtime export size.
- Runtime safe area: centered `256x256` inside each generation cell.
- Use the first N implied cells as ordering hints; unused cells stay flat in the configured chroma matte.
- Keep rough grid crops only as review artifacts; they are `384x384` in `standard` and `512x512` in `hires`.
- If a still-image geometry guide is used, it should be the deterministic black-and-white alternating-pixel guide, and only for aspect ratio/layout. The model output must still be sprites on one uninterrupted configured chroma background, with no visible guide pixels, contact-sheet/page look, borders, labels, grid lines, or white/gray/black background.
- Recover foreground components from the full pose board before normalization; recovered variable-size components are the source of truth.
- Preserve recovered raw/native frames before pixel snap or `256x256` runtime normalization.
- Create padded native review frames, contact sheets, and GIFs before runtime normalization; use `384x448` by default, with `448x448` as a square review option.
- If `--pixel-snap` is enabled, use `--pixel-snap-source recovered` to snap tight recovered crops independently, `--pixel-snap-source chroma-layout` to fit recovered frames with one shared scale onto a shared preset-cell chroma canvas, or `--pixel-snap-source transparent-layout` to fit them onto a shared preset-cell transparent canvas. Both layout modes run the real pixel-snapper algorithm; chroma-layout then removes the snapped solid background back to transparency before normalization. The raw snapped output may remap the matte to black or another flat color, so background cleanup must use metadata/corners and must not assume literal `#00FF00` survives.
- In layout modes, the shared canvas stabilizes placement before pixel snapper runs; the raw snap outputs may still have different discovered native sizes and must stay visible in review.
- Show raw real pixel-snapper outputs without padding, then show one compact comparison sheet from recovered/source through raw snap to final `256x256` runtime.
- Normalize recovered or snapped poses into `256x256` runtime cells and pack into 5-column runtime sheets.
- Run `spriterrific finalize-runtime` on promoted animation folders so grounded actions share the same foot/bottom anchor.
- Use `spriterrific run-actions` for multi-action experiments so the action runs and top-level review page are reproducible.
- Keep CLI action names generic. Use `platformer` or `fighting-game` as the
  animation template/profile choice, but do not invent new engine action names
  unless they are in `spriterrific run --help`. SDK/Studio can expose friendly
  project names such as `light-punch`, `heavy-kick`, `block-high`, and
  `get-up`; those should map onto generic engine actions such as
  `light_attack`, `heavy_attack`, `block_high`, and `get_up`.
- Preferred simple/platformer runtime counts: `idle=10`, `attack=8`,
  `hurt=6`, `jump=6`, `crouch=6`, `death=10`. Use
  `--animation-template fighting-game --preset-profile fighting-game` for
  longer fighting-game defaults such as 12-frame idle/walk/run/attack/death
  and fighting-game actions like `walk_forward`, `walk_backward`,
  `light_attack`, `heavy_attack`, `block_high`, `block_low`, `knockdown`, and
  `get_up`.
- Frame counts are recommendations. Normal CLI/SDK runs now coerce unsupported
  requested counts to the nearest recommended count and record the warning in
  metadata. Use `--strict-frame-counts` only when the user wants fail-fast
  validation; use `--allow-frame-count-override` for deliberate manual video
  recovery with existing/selected frames.

### Video-Derived Motion
- Use video primarily as motion reference.
- Start with a `1024x1024` neutral flat-background direction plate, not a sheet guide or checker/grid.
- The video plate should preserve the approved `1024x1024` snapped chroma anchor scale before the provider resolves its own output video size.
- If an approved idle/anchor/runtime sheet exists, create a size contract with `uv run spriterrific size-contract` and pass it through both `run --size-contract` and `process-selection --size-contract`.
- For planted objects and enemies, prefer a `base-center` pivot. For humanoid platformer characters, prefer a `foot-center` pivot. Avoid using bbox center as the conceptual pivot when weapons, barrels, capes, or effects extend sideways.
- Do not let video generations bake shadows into the sprite source. Shadows,
  contact ovals, floor/ground lines, platform edges, dust puffs, and reflections
  belong in the game renderer or level art, not in exported spritesheets.
- Default to Grok Imagine (`grok-imagine-video-i2v`) for video actions. Tell the user it is the current default and use WAN turbo, SeedDance, or WAN 2.7 only when they explicitly request that comparison.
- Current provider defaults: 1:1 fal output at `720p`; Grok Imagine uses `duration=1` (or `duration=2` for `walk` and `run`), `resolution=720p`, and `aspect_ratio=1:1`. WAN turbo (`num_frames=17`, `frames_per_second=16`, `video_quality=maximum`, `video_write_mode=balanced`, prompt expansion disabled), SeedDance, and WAN 2.7 remain opt-in model experiments.
- Grok Imagine has no `negative_prompt` field: its FAL i2v endpoint accepts only `prompt`, `duration`, `resolution`, `image_url`, and `aspect_ratio`. Negative prompts and "do not" phrasing are unreliable on Grok, so steer it with positive descriptions of the desired pose/motion instead. For low-motion actions like `idle`, describe a rooted standing pose (feet fused to the ground, body centered, does not travel) rather than relying on "no stepping". If a truly static idle is required and Grok keeps adding locomotion, fall back to image mode (`idle` is image-mode by default), which has no video locomotion.
- Idle that "walks a bit" is almost always prompt wording, not a tooling bug. Image-to-video models read permissive motion words (`tiny breathing`, and especially `slight weight shift`) as permission to move the feet and travel. Two reliable fixes:
  - Demand a closed loop in `--action-context`: "Exact start pose and exact return to the same start pose for a clean loop." This pins frame 1 to the last frame and squeezes out drift. It is the single biggest improvement.
  - Run video idle with `--layout-mode preserve-canvas` so per-frame recentering does not make a planted pose look like it walks across the packed sheet.
- Proven idle recipes (validated on the fighting-game brawlers):
  - Ready-idle (living, breathing fighting stance), video:
    ```bash
    spriterrific run --action idle --direction w --mode video \
      --reference <anchor-w-1024-chroma>.png --run-dir runs/idle-w \
      --video-model grok-imagine-video-i2v --layout-mode preserve-canvas \
      --frames 12 --fps 8 --video-duration 2 \
      --action-context "Relaxed neutral fighting guard, weight settled, fists up. Tiny breathing rise-and-fall only; optional single blink. Exact start pose and exact return to the same start pose for a clean loop. No stepping, no foot lift, no weight shift, no squat, no bobbing. One character only, west-facing, preserve canvas and identity."
    ```
    Keep "tiny breathing" but drop "weight shift" entirely, and always spell out the negatives (`no stepping, no foot lift, no weight shift, no bobbing`) since Grok has no negative-prompt field.
  - Dead-still idle (statue, no breathing): strip all motion verbs and slow the playback, e.g. `--frames 12 --fps 6 --video-duration 2` with `--action-context "Hold the exact anchor pose for the whole clip. No walking, no stepping, no foot lift, no weight shift, no bounce, no breathing motion, no body bob, no pose drift. Optional single blink only. End on the identical pose as frame 1."` If Grok still adds locomotion, use image mode (the `idle` default), which cannot produce video travel.
- Extract all frames, curate start/end and in-betweens with frame picker, then process selected frames.
- For first-pass previews, preserve the source video canvas before trying foreground-fit normalization. This applies to all image-to-video actions, not only walk/run.
- Preserve-canvas video recovery still removes the configured chroma background and any enabled matte edge cleanup; it is not a raw chroma-background export.
- For manual recovery from existing video, selected orders can define their own
  frame count. Use `--allow-frame-count-override` when `--frames` is outside
  the action's normal list and the run also has `--existing-video`,
  `--selected-order`, or `--selected-range`.
- Do not treat every video action like a walk cycle. Spriterrific presets now
  carry timing semantics:
  - `loop`: `idle`, `walk`, `run`, `walk_forward`, `walk_backward`; compact
    cycle-window selection is appropriate.
  - `one_shot`: `attack`, `hurt`, `light_attack`, `heavy_attack`; choose the
    meaningful action window or pass an explicit selected range/order.
  - `transition`: `jump`, `death`, `knockdown`, `get_up`; sample the full
  source/range and include the final frame. Do not map `get_up` to `jump`.
  - `hold`: `crouch`, `block_high`, `block_low`; preserve a stable held pose
    with small motion rather than forcing locomotion-loop logic.
- For transition video actions with a known final pose, use `--end-reference`
  rather than hoping a generic I2V model returns to the right state. The main
  case is `get_up`: use the final knockdown frame as `--reference` and the
  standing directional anchor as `--end-reference`. If no model is specified,
  Spriterrific will choose `wan-2.7`. Seedance 2.0 I2V also supports explicit
  end references via `end_image_url`; Grok Imagine and WAN turbo should fail
  early because they do not support first+last-frame generation.
- Fighting-game action presets are available for more specific motion:
  `walk_forward`, `walk_backward`, `block_high`, `block_low`, `knockdown`,
  `get_up`, `light_attack`, and `heavy_attack`.
- Use `--normalize-foreground` only for a second review branch when the sequence needs consistent bbox height/baseline more than natural stride proportions.
- Do not promote top-level video preview exports directly into
  `public/assets`; they are review artifacts. For I2V/video assets, use frame
  picker -> fixed-canvas/preserve-motion processing -> optional frame aligner
  -> `spriterrific finalize-runtime`.
- Before promotion, run `spriterrific finalize-runtime`; this keeps video-derived motion review conservative while making final public assets obey the same bottom-anchor contract as image-generated actions.
- Treat `manifest.json` with `publicAssetReady: true` plus a
  `finalize-runtime.json` report as the machine-readable promotion gate.
  Fresh generated exports are `publicAssetReady: false` until finalization.
- Use frame aligner only after runtime frames exist, for small x/y nudges.

### Runtime Finalization
- `spriterrific finalize-runtime` is the final deterministic stage before promotion to `public/assets`.
- It reads animation folders with `manifest.json`, `spritesheet.png`, and `preview.gif`.
- It does not regenerate, clean, pixel snap, scale, or select frames. It only translates existing transparent `256x256` runtime frames according to the action's anchor policy, then rebuilds the sheet/GIF and writes `finalize-runtime.json`.
- It marks the animation manifest with `publicAssetReady: true`. Do not copy
  runtime sheets into `public/assets` unless that marker and
  `finalize-runtime.json` are present, or the user explicitly asks for a
  review-only export.
- Default policy is `auto`: `jump` uses `preserve-motion`; `idle`, `walk`, `run`, `attack`, `hurt`, and `death` use `grounded`.
- Use `grounded` when feet/body contact should land on the same bottom pixel across actions. Use `preserve-motion` for jump/fall/float animations where vertical motion is intentional.

## Review Contract

Every substantial run should include a review page that shows what changed:
- raw/generated source
- rough grid review crops or selected frames
- recovered foreground components
- padded native review frames/contact/GIF before runtime normalization
- background removal
- cleanup/despeckle
- optional pixel snap, including raw snapped frame sizes and one compact recovered -> snapped -> runtime comparison
- normalized runtime frames
- runtime finalization report for public exports
- final spritesheet and GIF
- handoff command for the next tool

Use `runs/` as the verbose debug superset. User-facing folders can be smaller, but should preserve the same important artifact names so tools can target either location.

## Output Locations And The Run Viewer

Spriterrific outputs live in conventional run roots inside a project:

- `runs/` — raw CLI runs (default for direct `spriterrific` commands)
- `spriterrific-sdk/runs/` — SDK anchor/bootstrap runs
- `spriterrific-sdk/animation-runs/` — SDK animation groups, one folder per
  batch with `animation-plan.json` and one CLI-shaped child run per
  action-direction

A project can make these explicit with a `.spriterrific/config.json` marker at
the project root: `{"version": 1, "runRoots": ["runs", "spriterrific-sdk/runs",
"spriterrific-sdk/animation-runs"]}`. Tools should prefer the marker when
present and fall back to probing the conventional roots. When editing the
marker, preserve unknown keys.

At review gates, you can hand the user a richer review surface than a raw
`review/index.md` link:

```bash
uv run spriterrific viewer --run-dir runs/<run>
```

The viewer browses all discovered runs (CLI and SDK layouts) and shows tabs
per run: the exported spritesheet (nearest-neighbor zoom), the animated GIF,
a Video tab that plays `extracted/dense-frames/` with scrubbing plus an
"Open MP4" handoff, a runtime frame strip, and run metadata. An Export
dropdown switches the tabs between the automatic `export/` and any
`frame-picker/<ts>/post-selection/<ts>/export` curation branches (newest
first), so historical frame selections stay comparable. Each tab has a
reveal button that selects the artifact in Finder/Explorer, and the action
bar launches `frame-picker`, `frame-aligner`, and `sprite-cleanup` on the
selected run. The viewer is read-mostly: all edits still flow through the
existing tools and their canonical outputs. Legacy runs without `run.json`
(and exports without `manifest.json`) are still discovered. It requires
`tkinter`, like the other GUI tools.

## Anti-Patterns To Avoid

**Anti-pattern: contaminating generic skills with Spriterrific defaults**
Why bad: `fal-ai-image`, `fal-ai-video`, `pixel-snapper`, and `animated-spritesheets` should remain reusable outside this repo.
Better: keep project-specific canvas sizes, action counts, and run conventions here.

**Anti-pattern: deriving generation canvas from runtime sheet size**
Why bad: wide runtime strips confuse image models and may violate provider aspect-ratio limits.
Better: generate on the canonical pose board, then pack runtime frames.

**Anti-pattern: trusting invisible cells**
Why bad: image models spill capes, weapons, and feet across implied boundaries.
Better: treat rough `384x384` grid crops as review artifacts only, then recover foregrounds from the full pose board and preserve native recovered frames before normalizing into runtime frames.

**Anti-pattern: calling rough crops "exact cells"**
Why bad: it makes a lossy review crop sound like the source of truth.
Better: name them `grid-review` or `rough grid review crops`; reserve "runtime frame" for recovered, normalized outputs.

**Anti-pattern: hiding normalization**
Why bad: a polished final GIF can conceal scale drift, bad baseline, or cut-off frames.
Better: generate before/after comparisons for every geometry-changing step, including padded native review frames versus `256x256` runtime frames.

**Anti-pattern: using checker/grid guides for video**
Why bad: video models interpret them as scenes, floors, or perspective grids.
Better: use neutral plates for video, and alternating-pixel guides only for still image generation when useful.

## Variation Guidance

Keep Spriterrific opinionated, but not frozen:
- Vary frame counts by action: short hurt/jump/crouch, longer idle/death, curated walk/run.
- Vary model providers only when the experiment is explicitly about model comparison.
- Vary cleanup intensity by output quality; do not pixel snap if it makes motion or shape worse.
- Keep runtime defaults stable: `256x256` cells and 5-column packed sheets unless the user asks for a comparison export.

## References

- Image action pose boards: `references/image-action-pose-boards.md`
- Happy path prompt templates: `references/happy-path-prompt-templates.md`
- Seven-step AI prompting guide: `references/seven-step-ai-prompting.md`
- Current image-generated spritesheet pipeline: `docs/imagegen-spritesheet-pipeline.md`
- Size contracts: `docs/size-contracts.md`
- Video walk-cycle pipeline: `docs/walk-cycle-video-pipeline.md`
- Workspace contract: `docs/workspace-contract.md`

## Remember

Spriterrific's job is not to make a model obey an engine sheet perfectly. Its job is to turn imperfect model outputs into auditable, normalized, game-ready sprite assets.
