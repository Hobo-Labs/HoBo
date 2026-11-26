---
name: phaser-capacitor-ios
description: "Build and ship Phaser games to iOS with Capacitor and Vite. Use for Capacitor setup, iOS landscape or portrait orientation, Swift Package Manager, shell-mode gating, WKWebView-safe HUDs, mobile touch controls, virtual joysticks, safe areas, simulator run loops, and browser/mobile parity."
metadata:
  short-description: "Phaser + Capacitor iOS workflow"
---

# Phaser Capacitor iOS

Ship Phaser games to iOS without creating a second game. The native app should wrap the same web build, preserve the same gameplay contracts, and adapt only the shell, orientation, and input surface.

## Philosophy: One Game, Multiple Shells

Treat the project as one Phaser runtime hosted by several shells:
- Desktop debug shell for development tools.
- Clean web/game shell for deployable browser play.
- Mobile shell for touch testing in a browser.
- Capacitor iOS shell for native WKWebView play.

Most bugs appear when those shells are implicit. Make the shell contract explicit, then let scenes consume stable flags such as `isDebugShell` and `isTouchRuntime`.

**Before implementing, ask:**
- What is the exact web build directory, and does Capacitor `webDir` point to it?
- Is the game landscape or portrait, and do Phaser profile dimensions and iOS supported orientations agree?
- Which runtime surfaces should expose debug tools, gyms, bounds overlays, or editors?
- Does touch input emit the same action shape as keyboard/gamepad input?
- Are HUD and touch controls inside mobile safe areas?

**Core principles:**
1. **Dist is the contract**: iOS should load built web assets, not a parallel native game.
2. **Orientation is cross-platform**: Phaser profile and iOS `Info.plist` must agree.
3. **Shell mode beats user-agent sniffing**: branch on intent, not device strings.
4. **Touch is an input source**: virtual controls should feed the same gameplay actions as keyboard controls.
5. **WKWebView deserves verification**: rendering, safe areas, autoplay, and stale builds differ from desktop Chrome.

## Quick Start

1. Install Capacitor packages and configure `capacitor.config.ts`.
2. Set `webDir` to the actual build output, usually `dist` for Vite.
3. Add iOS with Swift Package Manager on modern Capacitor.
4. Lock native orientation to match the Phaser game profile.
5. Add shell-mode flags for debug, game-only, and mobile/touch runtime.
6. Implement touch controls as scene-local input that merges with keyboard input.
7. Chain `npm run build` before every `cap sync` or `cap run`.
8. Verify in browser game shell, browser mobile shell, and iOS simulator.

See `references/capacitor-ios-workflow.md` for setup and run details.
See `references/mobile-touch-controls.md` for touch-control design.

## Implementation Guidelines

### Capacitor Boundary

Prefer a thin wrapper:
- `capacitor.config.ts` points at `webDir: "dist"` or equivalent.
- Static game assets are browser-loadable URLs under the web build.
- Native scripts always build, then sync, then run/open.
- Native project files are treated as generated platform code except for deliberate orientation or app metadata edits.

Use Swift Package Manager by default for modern Capacitor iOS unless a plugin or legacy project requires CocoaPods.

### Orientation and Layout

Make orientation a game contract:
- Landscape game: Phaser profile is landscape and iOS supports only landscape left/right.
- Portrait game: Phaser profile is portrait and iOS supports portrait orientations intentionally.
- Mixed orientation: design responsive profiles and test every supported orientation.

Pad HUD and controls away from notches, rounded corners, and the home indicator. Avoid pinning critical state to the extreme landscape edges.

### Shell Modes

Use explicit shell modes:
- Debug shell: developer panels, gyms, editors, diagnostics.
- Game shell: clean browser gameplay with no touch overlay unless explicitly requested.
- Mobile shell: clean gameplay with touch overlay for browser testing.
- Native shell: treated as mobile/touch runtime automatically.

Debug overlays should default off in production/mobile shells. A bounds rectangle on an iPhone screenshot reads as a bug.

### Touch Controls

Virtual controls should be boring in the best way:
- Scene-local lifecycle: create on scene start, destroy on shutdown.
- Emits the same `InputSnapshot` or action object as keyboard input.
- Placement-insensitive left joystick: spawn the analog where the left thumb lands.
- Thresholds for walk/run rather than a binary deadzone only.
- Right-side buttons for discrete actions such as jump, attack, dash, interact.
- Multi-touch capable: joystick and buttons can be pressed at the same time.
- `setScrollFactor(0)` and fixed depths so controls stay in viewport space.

## Anti-Patterns to Avoid

❌ **Shipping stale web assets**
Why bad: iOS shows old JS/CSS/assets and debugging points at the wrong code.
Better: every native command runs build before `cap sync` or `cap run`.

❌ **Setting only Phaser orientation or only iOS orientation**
Why bad: one layer rotates or scales differently from the other.
Better: update Phaser profile and `Info.plist` together.

❌ **Using `navigator.userAgent` to decide game behavior**
Why bad: brittle across simulator, PWA, Android, desktop wrappers, and browser modes.
Better: derive explicit shell flags at app bootstrap.

❌ **Showing touch controls in normal desktop web gameplay**
Why bad: it looks broken for mouse/keyboard players.
Better: reserve touch for native/mobile shell and explicit mobile test URLs or debug toggles.

❌ **Bolting touch directly into player movement**
Why bad: every control scheme becomes a fork of gameplay code.
Better: convert touch into the same action snapshot as keyboard/gamepad.

❌ **Trusting transparent atlas HUD fills for critical state**
Why bad: WKWebView compositing can expose rendering assumptions.
Better: draw critical fills at runtime and add a text fallback when clarity matters.

## Variation Guidance

**IMPORTANT**: Do not force every Phaser game into the same mobile controls.
Vary by genre and camera model:
- Platformer: horizontal joystick, jump/attack/dash buttons, walk/run thresholds.
- Top-down RPG: two-axis joystick, interact/menu buttons, optional auto-run.
- Fighting game: larger discrete direction/action buttons, strict simultaneous input handling.
- Puzzle game: no joystick; gestures or large tap targets may be better.
- Portrait game: thumb zones and HUD hierarchy change completely.

Vary shell policy too:
- Internal tool builds may expose diagnostics in TestFlight.
- Public game builds should hide all developer affordances.
- Browser mobile testing can use `?shell=mobile`; desktop gameplay should stay clean.

## Resource Map

- `references/capacitor-ios-workflow.md`
  - setup, orientation, scripts, simulator loop, and native gotchas
- `references/mobile-touch-controls.md`
  - joystick/buttons, shell-mode gating, safe areas, and input merging

## Remember

Capacitor iOS works best when it is boring: one web build, one explicit shell contract, one input abstraction, and a disciplined build-sync-run loop. Make the native shell thin, make orientation deliberate, and make touch controls part of the input system rather than a second gameplay path.
