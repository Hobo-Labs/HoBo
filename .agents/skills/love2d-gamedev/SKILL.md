---
name: love2d-gamedev
description: "End-to-end LÖVE/Love2D game development and iOS deployment. Use when working with Love2D projects (`main.lua`, `conf.lua`), core callbacks (`love.load`, `love.update`, `love.draw`), gameplay mechanics, graphics/animation/tiles/collision/audio, packaging `.love` archives, or integrating a Love2D game into an Xcode iOS app (bundle resources, touch controls, signing/build troubleshooting)."
---

# Love2D Game Development

## Overview

Build polished 2D games with LÖVE/Love2D (Lua), including a practical workflow for iOS builds via Xcode.

## Quick Reference

| Topic | Read when you need… |
|-------|---------------------|
| [Core Architecture](references/core-architecture.md) | Game loop, callbacks, module patterns |
| [Project Structure](references/project-structure.md) | File layout, `conf.lua`, distribution |
| [Graphics & Drawing](references/graphics-drawing.md) | Rendering, transforms, scaling |
| [Animation](references/animation.md) | Sprite sheets, quads, frame timing |
| [Tiles & Maps](references/tiles-maps.md) | Tile maps, level loading |
| [Collision](references/collision.md) | AABB/circle/SAT patterns |
| [Audio](references/audio.md) | SFX/music, volume, pooling |
| [Libraries](references/libraries.md) | Common community libs |
| [iOS Overview](references/ios/overview.md) | Mobile workflow and pitfalls |
| [iOS Setup](references/ios/setup.md) | Xcode/Love2D iOS source/libs, signing |
| [iOS Touch Controls](references/ios/touch-controls.md) | Multitouch, virtual controls |
| [iOS Xcode Project](references/ios/xcode-project.md) | pbxproj structure/editing |

## Core Rules of Thumb

- Treat `dt` as mandatory for anything time-based (movement, timers, animation).
- Load assets once in `love.load()`, not in `love.update()`/`love.draw()`.
- Prefer locals + modules over globals; keep state explicit.
- Avoid hard-coded pixels for UI/layout; anchor/scale to `love.graphics.getDimensions()`.

### The Minimal Loop

```lua
function love.load()
  -- init + load assets
end

function love.update(dt)
  -- game logic
end

function love.draw()
  -- render
end
```

## Workflow: Desktop Dev Loop

1. Run the game on desktop frequently while iterating.
2. Keep iOS-only code isolated (e.g., `touch.lua` gated by `love.system.getOS()`).
3. Use `dt` everywhere; verify gameplay at low FPS (simulate heavy load).

## Workflow: iOS Build/Deploy Loop

Use the helper scripts in `scripts/` to reliably rebuild `game.love` and copy it into an Xcode project (or a staging folder).

1. Build/update the `.love` archive:
   - `python3 scripts/make_game_love.py --src /path/to/game --out /path/to/game.love`
2. Copy into the iOS app bundle resources folder (or your preferred destination):
   - `python3 scripts/sync_game_love.py --love /path/to/game.love --dest /path/to/xcode/project/resources/`
3. Build/run in Xcode; fix signing, deployment target, and bundle resource issues as needed.

For details and troubleshooting patterns, read:
- [iOS Overview](references/ios/overview.md)
- [iOS Setup](references/ios/setup.md)
- [iOS Xcode Project](references/ios/xcode-project.md)

## Notes

If you’re implementing a feature and it touches one of these areas, load the corresponding reference doc and apply its patterns rather than inventing a new architecture.
