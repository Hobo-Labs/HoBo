# Seven-Step AI Prompting Guide

Use this reference when an AI agent is helping a user run Spriterrific for a character asset workflow. The goal is to shape the right inputs for each stage without bypassing the CLI/package prompts.

Hard rule:

```text
Do not bypass Spriterrific's deterministic processing stages for product workflows.
Use these prompts to help the user define intent, save generation outputs as explicit handoff files, then run `uv run spriterrific ...` for recovery, snapping, normalization, packing, metadata, and review.
```

## Output Mode Gate

Before prompt writing, determine whether the user wants pure pixel-snap output or high-fidelity mixel output:

```text
Do you want this run to target pixel-snap / real pixels, or mixels / high fidelity?
```

If the answer is pixel-snap / real pixels, all generation prompts should bias toward the low-bit anchor recipe: limited 8 to 12 color feeling, big pixel clusters, clean stepped edges, compact readable silhouette, no tiny accessories, no ornate trim, no texture noise, and no cloth-fold detail. Treat user images as identity input only, then force them through Spriterrific's opinionated low-bit anchor distillation before snapping. Use `k=64` as the default pixel-snap palette target. If the answer is mixels / high fidelity, richer AI-generated pixel texture is acceptable when it suits the game target and can be the simpler path; record that a later pixel-snap branch needs low-bit distillation before snapping.

## Codex Environment Image Generation Choice

If running inside Codex, offer Codex's built-in `imagegen` skill for still-image generation stages before defaulting to live FAL-backed generation, even if `FAL_KEY` / `FAL_API_KEY` is configured. Walk/run video cycles still need a video provider such as FAL.

Use built-in `imagegen` for:

```text
- gameplay mockups
- character concept sheets
- source/reference images
- visual direction exploration
- front-facing candidate and W-facing anchor handoff images
- image action pose boards for idle, attack, hurt, jump, and death
```

Ask the user:

```text
For still-image stages, I can use Codex imagegen and then feed the saved outputs through Spriterrific's CLI processing. Walk/run video cycles still need FAL or another video provider. Do you want a hybrid Codex-imagegen path, or should we wait for FAL?
```

If FAL is not configured, tell the user:

```text
FAL is not configured, so we can use Codex imagegen for still-image generation handoffs: source/reference, front candidate, W-facing anchor, and image action pose boards such as idle, attack, hurt, jump, and death. Spriterrific should still process those saved images through its CLI. Walk/run video cycles should wait until FAL or another video provider is configured.
```

Do not use this fallback to pretend that imagegen alone completed runtime export. The correct claim is: Codex imagegen produced saved generation sources or pose boards, then Spriterrific CLI processed those files into runtime spritesheets/GIFs. The real CLI provider path still needs FAL for live source/candidate/facing/action/video generation, and video walk/run cycles need a video provider.

## Step 1: Character Concept Prompt

Purpose: convert a vague character idea into a concise source prompt for `bootstrap-anchors`.

Prompt type:

```text
one character, full-body, neutral pose, readable silhouette, clear outfit shapes, simple material accents, cute-ish but not goofy, designed for a low-fidelity pixel-art platformer
```

Example:

```text
whimsical human-like forest outlaw scavenger, oversized green hood, red scarf, patched leather jerkin, scuffed boots, gloves and knee pads, small scrapwood bow, satchel of rescued brass trinkets, cheeky kind expression, full-body neutral pose, readable silhouette, charming but not goofy, designed as a low-fidelity pixel-art platformer character
```

Avoid:

```text
photorealistic, cinematic, 3D render, complex background, dramatic lighting, huge effects, portrait crop, multiple characters
```

## Step 2: Source Image Interpretation Prompt

Purpose: when the user provides a moodboard/gameplay/reference image, explain how it should influence the character without turning the whole scene into a character source.

Prompt type:

```text
Use the reference for world style, palette, readability, and mood. Do not copy the whole scene. Extract only character-relevant cues: scale, simplicity, materials, silhouette language, and palette accents.
```

Visual-target interpretation example:

```text
Use the gameplay mockup as world inspiration: palette, material language, readable side-scroller scale, and low-fidelity pixel-art simplicity. Do not include a full background scene in the character anchor.
```

## Step 3: Front Anchor Candidate Prompt

Purpose: generate or refine the front-facing platformer production candidate. Use south-facing language only for top-down workflows.

Prompt type:

```text
Create one deliberately simple low-bit full-body front-facing production sprite anchor. Preserve broad identity and outfit, but simplify details aggressively: limited 8 to 12 color feeling, big pixel clusters, clean stepped edges, compact readable silhouette, no tiny accessories, no ornate trim, no texture noise, no cloth-fold detail. Keep the figure centered on flat chroma and make it readable inside future 256x256 animation cells. The snapped native sprite should feel roughly 100 to 130 pixels tall, not a 200+ pixel high-detail illustration.
```

Use the built-in `lobit-v1` preset when the next step is pixel snapping. If the user intentionally wants higher-fidelity non-snapped game art where mixels are acceptable, that is valid, but do not treat it as a snap-ready anchor until it passes through low-bit distillation.

Review targets:

```text
candidate/front/candidate-raw.png
candidate/front/snapped-1024-chroma.png
review/bootstrap/index.md
```

## Step 4: Pixel Snap Review Prompt

Purpose: help the user decide whether the snapped front anchor is acceptable.

Prompt type:

```text
Evaluate whether the snapped anchor has real pixel clusters, readable silhouette, clean outline, no broken limbs, no key identity loss, no green clothing/accessory conflicts, and enough margin for animation.
```

Do not overreact to minor style changes if the snapped version is cleaner and more animation-friendly.

## Step 5: Facing Prompt

Purpose: generate the requested directional anchor, defaulting to W.

Prompt type:

```text
Generate a single-frame W-facing profile anchor from the accepted front anchor. Preserve exact identity, outfit, proportions, silhouette, and pixel readability. Keep one full-body sprite centered on 1024x1024 with flat chroma background. Do not redesign, crop, add scenery, add shadows, or create an animation sheet.
```

Default:

```text
--directions w
--game-view platformer
--anchor-role character
--anchor-context "side-scrolling platformer character, true W profile"
```

Use `n,s,e,w` only when the user explicitly wants all facings. Change
`--game-view`, `--anchor-role`, and `--anchor-context` for enemies, turrets,
props, objects, or top-down games before generating directional anchors.
If a manual/corrective anchor is accepted, promote it with `accept-anchor` so
the canonical `anchors/<direction>/` path and metadata point to the reviewed
anchor.

## Step 6: Image Action Prompt

Purpose: help the user select actions and add bounded flavor without breaking the pose-board constraints.

Prompt type:

```text
Select actions first. Keep custom action flavor short, physical, and cell-sized. Avoid cinematic effects, scene interaction, multiple characters, and new props.
```

Recommended action set:

```text
idle,attack,hurt,jump,death
```

Good action flavors:

```text
attack with a compact junk-arrow shot, no large effects
```

```text
hurt as a quick recoil while clutching the rescued trash sack, no knockdown
```

```text
idle with subtle breathing, tiny scarf sway, and a small weight shift
```

Implementation note: current `run-actions` uses the shared Spriterrific action prompts and runs actions sequentially.

## Step 7: Walk Cycle Prompt

Purpose: guide the video-derived walk/run stage.

Prompt type:

```text
Animate this single W-facing character into an in-place walk cycle for a top-down/side-readable 2D game asset pipeline. Maintain pure side-profile facing screen-left. Use clear alternating foot contact poses and opposite arm swing. Preserve identity and attached gear. Keep the camera fixed and background flat. Do not rotate, attack, add scenery, detach items, or add new props.
```

Current model recommendation (default for all video actions):

```text
--video-model grok-imagine-video-i2v
```

This is the default, so the flag can be omitted. Only recommend model names that
exist in `src/spriterrific/presets.py`.
Keep image-to-video clips short for spritesheets. This is a quality rule, not
only a cost rule: short clips give the model less time to drift identity,
costume, palette, scale, or background. Use provider-valid settings: Grok
Imagine uses `duration=1`, but Spriterrific defaults Grok `walk` and `run`
requests to `duration=2` for fuller stride-cycle coverage. Opt-in experiments: WAN turbo
(`--video-model wan-2.2-a14b-i2v-turbo`) uses frame count rather than duration,
WAN 2.7 starts at `2` seconds, and Seedance starts at `4` seconds.

## Agent Response Pattern

When a user asks to generate assets, respond in this shape:

```text
1. Restate the character/source prompt in one concise paragraph.
2. State the exact Spriterrific command to run.
3. Name the output files to inspect.
4. Ask for approval only at human review boundaries: source/candidate, snapped south, W facing, action set, walk frame selection.
5. Never invent output paths; use the run folder produced by the CLI.
```

## Quality Checklist

Before continuing to the next stage:

```text
- Is it one character, full body, no scene?
- Is the silhouette readable at small size?
- Are outfit and accent colors stable?
- Are green areas avoided when chroma keying matters?
- Is the W facing clearly profile-facing screen-left?
- Do action prompts fit inside a small sprite cell?
- Does the walk prompt ask for alternating stride, not a shuffle/bounce-only idle?
```
