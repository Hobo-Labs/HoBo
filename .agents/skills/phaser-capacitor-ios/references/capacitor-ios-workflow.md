# Capacitor iOS Workflow for Phaser

Use this reference when adding or debugging a Capacitor iOS shell for a Phaser game.

## Mental Model

The native app is a host for built web assets:

```text
src/ + public/ -> npm run build -> dist/ -> cap sync ios -> iOS WKWebView
```

If the simulator does not show your latest change, suspect stale `dist/` first.

## Installation Shape

Typical Vite project:

```bash
npm install @capacitor/core @capacitor/cli @capacitor/ios
npx cap init
npm run build
npx cap add ios --packagemanager SPM
```

Use Swift Package Manager on modern Capacitor iOS unless a plugin or legacy project forces CocoaPods.

## `capacitor.config.ts`

Keep the web/native boundary explicit:

```ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.example.game',
  appName: 'Example Game',
  webDir: 'dist'
};

export default config;
```

The `webDir` value must match the real production build output.

## Recommended npm Scripts

```jsonc
{
  "scripts": {
    "ios:add": "npm run build && cap add ios --packagemanager SPM",
    "ios:sync": "npm run build && cap sync ios",
    "ios:open": "npm run ios:sync && cap open ios",
    "ios:run": "npm run ios:sync && cap run ios"
  }
}
```

This removes the most common failure: running stale web code in the simulator.

## Orientation Contract

Set orientation in both places:

1. Phaser profile/config dimensions.
2. iOS `ios/App/App/Info.plist`.

Landscape-only iPhone and iPad:

```xml
<key>UISupportedInterfaceOrientations</key>
<array>
  <string>UIInterfaceOrientationLandscapeLeft</string>
  <string>UIInterfaceOrientationLandscapeRight</string>
</array>
<key>UISupportedInterfaceOrientations~ipad</key>
<array>
  <string>UIInterfaceOrientationLandscapeLeft</string>
  <string>UIInterfaceOrientationLandscapeRight</string>
</array>
```

Portrait games should make the opposite deliberate choice. Do not leave generated defaults in place if they conflict with the game profile.

## Shell-Mode Contract

Prefer flags that describe runtime intent:

```text
debug shell  -> developer panels, editors, bounds overlays
game shell   -> clean browser gameplay, no debug, no touch overlay
mobile shell -> clean browser gameplay with touch controls
native shell -> mobile behavior automatically
```

Derive these once at app bootstrap and pass them through shared context. Do not scatter platform checks across scenes.

Useful priority:

```text
1. Capacitor native platform -> mobile/native shell
2. URL query or build flag -> debug/game/mobile shell
3. Local dev default -> debug shell
4. Production web default -> game shell
```

## WKWebView-Safe HUD

WKWebView is close to Safari, but not identical to desktop Chrome. Harden critical HUD state:

- Use Phaser objects with `setScrollFactor(0)` for HUD.
- Draw critical bar fills at runtime with `Graphics` or rectangles.
- Add text fallbacks for health/ammo/timer values.
- Shift HUD inward from notches and the home indicator.
- Verify on a simulator screenshot, not just desktop browser.

Transparent atlas slots are fine for ornamental frames, but runtime-drawn state is safer for gameplay-critical values.

## Verification Loop

Run:

```bash
npm run build
npx cap sync ios
npx cap run ios
```

For repeatable simulator work, prefer selecting a concrete simulator target from the Capacitor prompt or using whatever target syntax your local Capacitor version supports.

Smoke checks:

```text
- App launches from the latest build.
- Orientation refuses unsupported rotation.
- Debug menus/panels are absent in game/native shell.
- Touch controls appear only in mobile/native shell.
- HUD is inside safe areas and readable.
- Audio behavior survives iOS user-gesture restrictions.
```

## Common Failures

### Native app ignores latest code

Cause: `dist/` was not rebuilt or iOS was not synced.

Fix: run build, then sync, then run. Make scripts chain those steps.

### iPhone rotates into the wrong orientation

Cause: Info.plist still contains generated defaults.

Fix: narrow supported orientations to the game profile.

### Desktop-only tools appear on iOS

Cause: scene/menu logic does not understand shell intent.

Fix: centralize `isDebugShell`, `isGameShell`, and `isTouchRuntime` style flags.

### HUD clipped by notch or home indicator

Cause: edge-pinned HUD.

Fix: add safe-area padding and verify in the target orientation.

### Audio or music does not start

Cause: iOS audio unlock and user-gesture rules.

Fix: start or resume audio from a tap/key path; gracefully skip playback while the audio manager is locked.
