# Initial fal Video Model Notes

These are the retained model notes for sprite image-to-video comparison runs.
The current sprite workflow prefers short, provider-valid clips over longer
cinematic generations because short clips drift less.

## Seedance

Model page:

- https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/image-to-video/api

Important schema notes:

- endpoint: `fal-ai/bytedance/seedance/v1/pro/image-to-video`
- input image field: `image_url`
- useful controls:
  - `duration`
  - `resolution`
  - `aspect_ratio`
  - `camera_fixed`
  - `seed`

Initial repo defaults:

- `duration=4` for `seedance-2.0-i2v`
- `resolution=720p`
- `aspect_ratio=16:9`
- `generate_audio=false`

The older `seedance-pro-i2v` comparison preset still uses `duration=6`,
`resolution=720p`, `aspect_ratio=auto`, and `camera_fixed=true`.

## Kling

Model page:

- https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video/api

Important schema notes:

- endpoint: `fal-ai/kling-video/v3/pro/image-to-video`
- input image field: `start_image_url`
- useful controls:
  - `duration`
  - `generate_audio`
  - `negative_prompt`
  - `cfg_scale`

Initial repo defaults:

- `duration=6`
- `generate_audio=false`
- `negative_prompt="blur, distort, low quality, camera drift, extra limbs, duplicate body parts"`
- `cfg_scale=0.5`

## Hailuo

Model page:

- https://fal.ai/models/fal-ai/minimax/hailuo-02/standard/image-to-video/api

Important schema notes:

- endpoint: `fal-ai/minimax/hailuo-02/standard/image-to-video`
- input image field: `image_url`
- useful controls:
  - `duration`
  - `resolution`
  - `prompt_optimizer`

Initial repo defaults:

- `duration=6`
- `resolution=768P`
- `prompt_optimizer=false`

## WAN

WAN presets are useful comparison models when you want a higher-resolution
motion sample and can tolerate slower generation.

### WAN 2.7

Model page:

- https://fal.ai/models/fal-ai/wan/v2.7/image-to-video/api

Important schema notes:

- endpoint: `fal-ai/wan/v2.7/image-to-video`
- input image field: `image_url`
- useful controls:
  - `duration`
  - `resolution`
  - `aspect_ratio`
  - `negative_prompt`
  - `enable_prompt_expansion`
  - `video_quality`
  - `video_write_mode`

Current sprite defaults:

- `duration=2`
- `resolution=1080p`
- `aspect_ratio=1:1`
- prompt expansion disabled
- sprite-preservation negative prompt

### WAN 2.5

Model page:

- https://fal.ai/models/fal-ai/wan-25-preview/image-to-video/api

Important schema notes:

- endpoint: `fal-ai/wan-25-preview/image-to-video`
- input image field: `image_url`
- useful controls:
  - `duration`
  - `resolution`
  - `negative_prompt`
  - `enable_prompt_expansion`

Current sprite defaults:

- `duration=5`
- `resolution=1080p`
- prompt expansion disabled
- sprite-preservation negative prompt

## Grok Imagine

Grok Imagine is currently useful for short, direct sprite motion experiments.

Model page:

- https://fal.ai/models/xai/grok-imagine-video/image-to-video/api

Important schema notes:

- endpoint: `xai/grok-imagine-video/image-to-video`
- input image field: `image_url`
- useful controls:
  - `duration`
  - `resolution`
  - `aspect_ratio`

Current sprite defaults:

- `duration=1`
- `resolution=720p`
- `aspect_ratio=1:1`

## Comparison Rule

The fair comparison target is:

- same anchor image
- same task prompt
- same general motion goal
- same “no scenery / no UI / black background” constraint set

The comparison is not:

- identical parameter names
- identical output resolution
- identical provider-native defaults
