# fal Image Model Notes

These notes summarize the initial fal image endpoints configured in this skill.

Official model pages checked:

- `https://fal.ai/models/xai/grok-imagine-image/api`
- `https://fal.ai/models/xai/grok-imagine-image/edit/api`
- `https://fal.ai/models/fal-ai/nano-banana-2/api`
- `https://fal.ai/models/fal-ai/nano-banana-2/edit/api`
- `https://fal.ai/models/google/nano-banana-2-lite/api`
- `https://fal.ai/models/google/nano-banana-2-lite/edit`
- `https://fal.ai/models/fal-ai/nano-banana-pro/api`
- `https://fal.ai/models/fal-ai/nano-banana-pro/edit/api`
- `https://fal.ai/models/openai/gpt-image-2/api`
- `https://fal.ai/models/openai/gpt-image-2/edit/api`

## Grok Imagine Image

- Generate endpoint: `xai/grok-imagine-image`
- Edit endpoint: `xai/grok-imagine-image/edit`
- Good for: xAI-family image generation and conversational image editing
- Typical controls surfaced by fal:
  - `prompt`
  - `num_images`
  - `aspect_ratio` on generation
  - `output_format`
  - edit uses `image_urls`
  - edit supports multiple reference images
- Workflow note from this repo:
  - transparent-background intent was not reliable enough in our sprite experiments
  - treat Grok as a chroma-key candidate unless a later run proves true alpha handling
  - if using chroma, ask for exact flat `#00FF00`, no gradients, no shadows on the background, no texture, and no green spill

## Nano Banana 2

- Generate endpoint: `fal-ai/nano-banana-2`
- Edit endpoint: `fal-ai/nano-banana-2/edit`
- Good for: fast, modern image generation and conversational edits
- Typical controls surfaced by fal:
  - `prompt`
  - `num_images`
  - `aspect_ratio`
  - `output_format`
  - `resolution`
  - `safety_tolerance`
  - edit uses `image_urls`
- Workflow note from this repo:
  - transparent-background requests produced faux-transparent/dark-background results rather than clean alpha
  - use exact chroma green `#00FF00` instead
  - forbid gradients, shadows on the background, texture, vignette, and green spill

## Nano Banana 2 Lite

- Generate endpoint: `google/nano-banana-2-lite` (note the `google/` prefix, not `fal-ai/`)
- Edit endpoint: `google/nano-banana-2-lite/edit`
- Underlying model: Gemini 3.1 Flash Lite Image — the efficiency-focused tier (sub-2s latency, cost-effective)
- Good for: fast iteration, multi-turn local edits, cheap batches before promoting to Nano Banana 2/Pro
- Typical controls surfaced by fal:
  - `prompt`
  - `num_images` (1–4)
  - `aspect_ratio` (supports extreme ratios up to 8:1 / 1:8; `auto` lets the model decide)
  - `output_format`
  - `safety_tolerance`
  - `system_prompt`, `limit_generations`, `thinking_level` (`minimal`/`high`) as optional extras via `--extra-json`
  - edit uses `image_urls`
- Note: there is **no `resolution` control** — output is fixed at 1K (1024x1024), unlike Nano Banana 2 and Pro. Do not pass `resolution`.
- Workflow note: as with the rest of the Banana family, prefer exact chroma green `#00FF00` over transparent-background requests for sprite extraction.

## Nano Banana Pro

- Generate endpoint: `fal-ai/nano-banana-pro`
- Edit endpoint: `fal-ai/nano-banana-pro/edit`
- Good for: higher-end realism, typography, and coherent composition
- Typical controls surfaced by fal:
  - `prompt`
  - `num_images`
  - `aspect_ratio`
  - `output_format`
  - `resolution`
  - `safety_tolerance`
  - edit uses `image_urls`
- Workflow note from this repo:
  - like Nano Banana 2, transparent-background intent was not reliable for sprite extraction
  - use exact chroma green `#00FF00` instead
  - the model may still frame the subject too small, so check scale as well as background obedience

## GPT Image 2

**Preferred OpenAI-family model. Do not use `gpt-image-1.5` — it has been retired from these presets in favor of `gpt-image-2`.**

- Generate endpoint: `openai/gpt-image-2` (note the `openai/` prefix, **not** `fal-ai/gpt-image-2`)
- Edit endpoint: `openai/gpt-image-2/edit`
- Good for: highest-fidelity OpenAI-family generation and editing with flexible sizes
- Typical controls surfaced by fal:
  - `prompt`
  - `num_images`
  - `image_size` — either a named preset (`square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`, `auto`) or a custom `{width, height}` object (each a multiple of 16, max edge 3840px, aspect ratio ≤ 3:1). Do **not** pass a bare `"1024x1024"` string.
  - `output_format`
  - `quality`
  - edit uses `image_urls`
  - no `background` control — do not rely on gpt-image-2 for transparent output; use chroma-key instead
- Workflow notes from this repo:
  - keep reference count low for identity-critical sprite work
  - fal routes gpt-image-2 directly to OpenAI infrastructure; a 500 `downstream_service_error` means OpenAI is down, not fal
  - presets `gpt-image-2-t2i` and `gpt-image-2-edit` are defined in `assets/model-presets.json`

## Edit Endpoint Gotcha: use the returned `status_url`

This applies to every `/edit` endpoint (Banana and GPT Image alike). fal's submission response returns a `status_url` that **drops** the `/edit` segment:

- submitted to: `queue.fal.run/fal-ai/nano-banana-2/edit`
- `status_url` returned: `queue.fal.run/fal-ai/nano-banana-2/requests/{id}/status`

Always poll the `status_url`/`response_url` from the submission payload. Reconstructing the status URL from `endpoint_id` yields the wrong path (`/edit/requests/...`) and a 405 — even though the bare POST succeeded.

## Practical Comparison Guidance

- Compare prompt adherence, identity consistency, edit locality, and transparency/background handling.
- Do not assume size and formatting controls mean the same thing across Grok, Banana, and GPT Image families.
- For edits, first compare with one reference image before adding multiple references.
- For this pirate workflow specifically, avoid magenta chroma. `#FF00FF` is too close to the bandana/warm shadow family and can contaminate edge cleanup.
