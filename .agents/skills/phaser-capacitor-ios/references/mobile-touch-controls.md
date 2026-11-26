# Mobile Touch Controls for Phaser

Use this reference when adding virtual controls to a Phaser game that also supports keyboard or gamepad input.

## Core Model

Virtual controls are not gameplay logic. They are an input source.

```text
keyboard input  \
gamepad input    -> merge into action snapshot -> player/controller update
touch input     /
```

The player controller should not know whether `jump` came from a key, touch button, gamepad button, or accessibility input.

## Shell Gating

Touch controls should appear when the runtime is touch-oriented:

```text
native Capacitor -> show touch controls
?shell=mobile    -> show touch controls for browser testing
debug toggle     -> show touch controls for desktop tuning
?shell=game      -> do not show touch controls
```

Do not put touch overlays in normal desktop web gameplay. It looks like a broken mobile layout.

## Joystick Design

For action games, a placement-insensitive joystick is usually better than a fixed pad:

- The first left-zone touch becomes the joystick origin.
- The knob follows horizontal or two-axis movement relative to that origin.
- Releasing that pointer clears the origin.
- The next touch can spawn a new origin wherever the thumb lands.

Platformer defaults:

```text
left zone: lower-left / left half of screen
walk threshold: about 0.20-0.30 of joystick radius
run threshold: about 0.65-0.80 of joystick radius
vertical axis: often ignored for side-scrollers
```

Top-down or twin-stick games should keep both axes and may use separate left/right sticks.

## Buttons

Place discrete actions on the right side:

- Minimum comfortable button diameter: roughly 72 CSS pixels; larger is better for action games.
- Keep buttons inside safe areas.
- Support simultaneous presses: joystick plus jump, joystick plus attack, jump plus attack.
- Track pointer IDs per button so releasing one finger does not cancel another action.
- Avoid text-heavy labels if icons are clear; text is acceptable for prototypes.

Common mappings:

```text
Platformer: jump, attack, dash/interact
Top-down RPG: interact, attack, menu
Fighting game: multiple attack buttons, block/special, strict simultaneous input
Puzzle game: maybe no buttons; taps and gestures may be enough
```

## Phaser Implementation Notes

Lifecycle:

```text
create: construct controls and register pointer listeners
update: read touch snapshot and merge with keyboard/gamepad snapshot
shutdown: unregister listeners and destroy graphics/text
```

Practical details:

- Call `scene.input.addPointer(n)` when supporting multi-touch.
- Use `setScrollFactor(0)` so controls stay in viewport space.
- Use a high depth above gameplay and HUD only when intended.
- Listen for `pointerdown`, `pointermove`, `pointerup`, and `pointerupoutside`.
- Disable controls by hiding visuals and clearing active pointer state.
- Recalculate layout on resize or profile changes if the game supports them.

CSS/webview details:

- Use `touch-action: none` on the game surface or shell container when browser gestures interfere.
- Avoid relying on DOM overlays for critical in-canvas controls unless that is the chosen UI architecture.
- Test on actual simulator/device dimensions, not only responsive browser mode.

## Input Merging

Merge by semantics, not by source order:

```text
booleans: OR merge, e.g. jump = keyboard.jump || touch.jump
axes: choose stronger magnitude or combine intentionally
run: derive from joystick threshold or OR with keyboard/gamepad run
pointerDown: OR merge
```

For a side-scroller, if keyboard says left and joystick says right, choose the source with stronger or more recent intent rather than letting both cancel unpredictably.

## Safe Areas and Layout

Mobile controls compete with gameplay space. Account for:

- Notch / dynamic island.
- Rounded corners.
- Home indicator.
- Landscape left vs landscape right.
- HUD placement.
- Gameplay objects near the bottom third of the screen.

If touch controls cover important gameplay, move the level framing, camera deadzone, HUD, or controls. Do not accept overlap as a "mobile only" inconvenience.

## Debugging Checklist

```text
- ?shell=game has no touch overlay.
- ?shell=mobile shows touch overlay.
- Native iOS shows touch overlay without a query string.
- Desktop debug can toggle touch overlay for testing.
- A left thumb landing slightly off-center still creates a usable joystick.
- Walk and run thresholds are visibly different in gameplay.
- Jump and attack can be pressed while moving.
- Releasing one finger does not cancel the other active input.
- Controls disappear or disable cleanly when paused, completed, or scene changes.
```

## Anti-Patterns

### Fixed joystick only

Fixed pads require the user to land exactly where the UI designer guessed. For action games, spawn-on-touch is more forgiving.

### Deadzone only, no thresholds

A binary deadzone loses walk/run nuance. Use at least two thresholds when analog magnitude matters.

### Source-specific gameplay branches

Avoid code like `if touch then move differently`. Convert touch into actions and let gameplay stay source-agnostic.

### Missing pointer ownership

If buttons do not track pointer IDs, multi-touch breaks under normal play.

### Touch controls on every web build

Desktop players should not see mobile UI unless they chose a mobile test shell or a debug toggle.
