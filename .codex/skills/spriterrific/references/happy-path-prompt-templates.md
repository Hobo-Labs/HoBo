# Happy Path Prompt Templates

Use these templates when helping a user run the current Spriterrific happy path:

```text
prompt or reference image
 -> generated/source character
 -> front-facing platformer production candidate
 -> pixel-snapped front anchor
 -> W-facing pixel-snapped anchor
 -> image-generated actions
 -> optional video walk cycle
 -> selected/processed/final runtime outputs
```

These are prompt-writing templates for operators and agents. The Spriterrific CLI also renders stronger internal prompts in package code; do not bypass those package prompts by calling provider scripts directly.

## Output Mode First

Before choosing prompts, decide whether the user wants pure pixel-snap output or high-fidelity mixel output:

```text
Do you want this run to target pixel-snap / real pixels, or mixels / high fidelity?
```

If pixel-snap / real pixels, use the constrained low-bit style throughout source, candidate, anchor, and action generation. Any user image is identity input only; it must be distilled into Spriterrific's opinionated low-bit anchor style before snapping. Default pixel-snap palette reduction to `k=64` unless the user explicitly asks for a broader palette experiment. If mixels / high fidelity, richer AI-generated pixel texture can be fine for the game target and is often simpler to generate, but record that it is not pure recoverable pixel art and needs a low-bit distillation step before it becomes snap-ready.

## 1. User Source Prompt

Use this when the user gives only a short concept and wants Spriterrific to generate the first source image.

Template:

```text
<adjective/style> <character archetype>, full-body neutral pose, readable silhouette, clear outfit shapes, cute but not goofy, designed as a low-fidelity game sprite character
```

Good examples:

```text
whimsical iconic low-bit pirate, full-body neutral pose, readable silhouette, loose coat, simple boots, cute but not goofy, designed as a low-fidelity game sprite character
```

```text
clockwork courier with brass goggles and satchel, full-body neutral pose, readable silhouette, compact outfit shapes, cute but not goofy, designed as a low-fidelity game sprite character
```

```text
moon-bell village guard, full-body neutral pose, hard helmet, loose coat, readable silhouette, cute but not goofy, designed as a low-fidelity game sprite character
```

Avoid asking for:

```text
photorealistic, cinematic, ultra detailed, 3D render, complex background, dramatic lighting, huge weapon effects, tiny character, portrait crop
```

CLI usage:

```bash
uv run spriterrific bootstrap-anchors \
  --character-id <character-id> \
  --source-prompt "<source prompt>" \
  --directions w \
  --game-view platformer \
  --anchor-role character \
  --anchor-context "side-scrolling platformer character, true W profile" \
  --k-colors 64
```

## 2. Source Image Guardrails

When the user supplies a reference image, treat it as identity input only.

Operator language:

```text
Use this image as the broad character identity: silhouette, outfit, proportions, personality, and key readable features. Do not preserve high-detail rendering, lighting, scenery, shadows, painterly texture, or photographic style. Convert it into a simple full-body low-fidelity game sprite candidate.
```

CLI usage:

```bash
uv run spriterrific bootstrap-anchors \
  --character-id <character-id> \
  --source-image path/to/reference.png \
  --directions w \
  --game-view platformer \
  --anchor-role character \
  --k-colors 64
```

## 3. Front Candidate Prompt

Default behavior should use Spriterrific's built-in `lobit-v1` candidate prompt preset when the candidate will be pixel-snapped. Recommend custom candidate prompts when the user intentionally wants higher-fidelity non-snapped game art where mixels are acceptable.

Custom candidate prompt template:

```text
Create a lower-fidelity production sprite anchor from the input reference.

This constrained style is needed for pixel snapping. Higher-fidelity/mixel art can be fine for non-snapped game assets, but should not be treated as snap-ready anchors without this low-bit distillation step.

Preserve:
- broad character identity
- readable silhouette
- outfit proportions
- key personality features

Change:
- simplify detail
- reduce rendering complexity
- convert to deliberately simple low-bit pixel art
- preserve big pixel clusters and a limited 8 to 12 color feeling
- remove tiny accessories, ornate trim, texture noise, and cloth-fold detail
- make the figure readable inside future 256x256 animation cells
- aim for a snapped native sprite that feels roughly 100 to 130 pixels tall, not a 200+ pixel high-detail illustration

Output:
- one full-body front-facing character identity anchor
- neutral upright pose
- centered on a 1024x1024 square canvas
- opaque exact flat chroma green background #00FF00
- no shadows, scenery, text, labels, extra characters, checkerboard, or transparency
- avoid green clothing or green accessories
```

CLI usage:

```bash
uv run spriterrific bootstrap-anchors \
  --character-id <character-id> \
  --source-image path/to/reference.png \
  --candidate-prompt-file prompts/my-candidate-prompt.txt \
  --directions w \
  --game-view platformer \
  --anchor-role character \
  --k-colors 64
```

## 4. Direction Facing Prompt Intent

Direction prompts are rendered internally by `spriterrific anchors` / `bootstrap-anchors`. The operator-facing intent is:

```text
Generate a single-frame W-facing anchor from the accepted front-facing identity anchor.
Preserve the exact character identity, outfit, proportions, silhouette, and pixel-art readability.
Make it a profile facing screen-left.
Keep one full-body sprite centered on 1024x1024.
Use opaque exact flat chroma green #00FF00.
Do not redesign the character, add scenery, add shadows, crop the figure, or create an animation sheet.
```

Always carry explicit game context into direction generation when the asset is
not a plain platformer character:

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

If visual review accepts a corrective/manual anchor, promote that reviewed
1024x1024 snapped chroma image:

```bash
uv run spriterrific accept-anchor \
  --run-dir runs/<bootstrap-run> \
  --direction w \
  --source path/to/accepted/anchor-chroma.png \
  --game-view platformer \
  --anchor-role enemy \
  --reason "manual side-profile correction accepted after visual review"
```

Default product direction:

```text
w
```

Use other directions only when requested:

```text
n,s,e,w
```

## 5. Image Action Prompt Inputs

For image-generated actions, the user should usually select actions rather than write full provider prompts. Spriterrific renders the full pose-board prompt internally.

Recommended action selection:

```text
idle,attack,hurt,jump,death
```

Recommended action run:

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

If the user wants to customize action flavor, keep it small and bounded. Good examples:

```text
attack with a compact cutlass slash, no large effects
```

```text
hurt as a quick recoil and recovery, no knockdown
```

```text
idle with subtle breathing and tiny cloth sway
```

Avoid:

```text
wide camera motion, cinematic effects, smoke clouds, environment interaction, new props, multiple characters, text labels, frame numbers
```

## 6. Walk Cycle Prompt Intent

Walk cycles are video-derived. The CLI renders the provider prompt internally from action/direction/model settings.

Operator-facing intent:

```text
Animate this single W-facing character into an in-place walk cycle for a top-down 2D game.
Maintain pure side-profile facing screen-left.
Keep the camera fixed and centered.
Keep the flat exact chroma green background.
Use clear alternating left/right stride poses with opposite arm swing.
Preserve exact character identity and attached equipment.
Do not rotate, pivot, attack, add scenery, add shadows, or detach held items.
```

Recommended run:

```bash
uv run spriterrific run \
  --action walk \
  --direction w \
  --mode video \
  --reference runs/<bootstrap-run>/anchors/w/anchor-snapped-1024-chroma.png \
  --run-dir runs/<character-walk-run>
```

Video actions default to Grok Imagine (`grok-imagine-video-i2v`), so no
`--video-model` flag is needed. Important: only recommend video model names that
exist in `src/spriterrific/presets.py`.
Keep spritesheet video clips short. This is a quality rule, not only a cost
rule: short clips give the model less time to drift identity, costume, palette,
scale, or background. Use provider-valid settings: Grok Imagine uses
`duration=1`, but Spriterrific defaults Grok `walk` and `run` requests to
`duration=2`.
Opt-in experiments: WAN turbo (`--video-model wan-2.2-a14b-i2v-turbo`) uses
frame count rather than duration, WAN 2.7 starts at `2` seconds, and Seedance
starts at `4` seconds.

## 7. Prompt Review Checklist

Before running generation, check:

```text
- Does the prompt describe one character, not a scene?
- Does it request full-body and readable silhouette?
- Does it avoid photorealism, cinematic lighting, 3D render language, and complex backgrounds?
- Does it avoid green clothing/accessories when chroma output matters?
- Is the character concept concise enough for the model to preserve across facings/actions?
- Are action customizations small enough to fit a sprite animation cell?
```

After generation, inspect:

```text
- input/source.png
- candidate/front/snapped-1024-chroma.png
- anchors/w/anchor-snapped-1024-chroma.png
- review/bootstrap/index.md
- action review/index.md
- per-action preview.gif and spritesheet.png
```
