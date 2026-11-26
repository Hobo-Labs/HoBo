# Phaser Integration Reference

Use this reference when the Colyseus client runs inside a Phaser game. Keep this file Phaser-specific so the core skill remains reusable for Three.js, PixiJS, React, or other renderers.

## Philosophy: Phaser Renders, Colyseus Decides

Phaser scenes should not become authoritative game logic containers in multiplayer mode. Let Colyseus define shared truth and let Phaser adapt that truth into sprites, animations, cameras, UI, and local feel.

The renderer is replaceable. The room model is not.

## Recommended Client Shape

Prefer a thin adapter layer:

```text
src/
  net/
    colyseusClient.ts
    roomSession.ts
    entityRegistry.ts
  scenes/
    BootScene.ts
    MenuScene.ts
    GameScene.ts
```

- `colyseusClient.ts`: creates the `Client` using env-configured URL
- `roomSession.ts`: joins rooms, owns listeners, exposes connection state
- `entityRegistry.ts`: maps network entity IDs to Phaser objects
- `GameScene.ts`: renders state and sends intent, but does not own authoritative rules

Do not bury network joins deep inside arbitrary scene logic without a cleanup plan.

## Minimal Client Setup

```ts
import { Client } from "@colyseus/sdk";

export const colyseus = new Client(import.meta.env.VITE_COLYSEUS_URL);
```

```ts
export async function joinBattle() {
  const room = await colyseus.joinOrCreate("battle", { mode: "duo" });
  return room;
}
```

Keep one connection service per frontend app unless the design truly needs multiple simultaneous room connections.

## Scene Responsibilities

### Boot or Menu scene

- sign in if needed
- gather matchmaking options
- initiate join flow
- handle loading and transition into gameplay scene

### Gameplay scene

- create renderer objects for entities that exist in room state
- update local presentation in response to state changes
- send input intent to the room
- clean up listeners and objects when the scene exits

### UI scene or overlay

- display connection state, ping, reconnect banners, score, and menus
- avoid making the UI scene the source of game truth

## Entity Registry Pattern

Keep a mapping from network IDs to Phaser objects.

```ts
const spritesById = new Map<string, Phaser.GameObjects.Sprite>();

function ensurePlayerSprite(scene: Phaser.Scene, id: string) {
  let sprite = spritesById.get(id);

  if (!sprite) {
    sprite = scene.add.sprite(0, 0, "player");
    spritesById.set(id, sprite);
  }

  return sprite;
}

function removePlayerSprite(id: string) {
  const sprite = spritesById.get(id);
  if (sprite) {
    sprite.destroy();
    spritesById.delete(id);
  }
}
```

This avoids full-scene rebuilds every time state changes.

## State Callbacks

Use `Callbacks` rather than broad polling wherever possible.

```ts
import { Callbacks } from "@colyseus/sdk";

const callbacks = Callbacks.get(room);

callbacks.onAdd("players", (player, sessionId) => {
  const sprite = ensurePlayerSprite(this, sessionId);
  sprite.setPosition(player.x, player.y);

  callbacks.listen(player, "hp", (currentHp) => {
    updateHealthBar(sessionId, currentHp);
  });
});

callbacks.onRemove("players", (_player, sessionId) => {
  removePlayerSprite(sessionId);
});
```

## State Sync Strategy

Do not force Phaser to mirror raw patch timing one-to-one on screen. A common pattern is:

1. Colyseus state updates authoritative target values.
2. Phaser stores those target values per entity.
3. The scene interpolates toward them during `update()`.

Example:

```ts
const targetsById = new Map<string, { x: number; y: number }>();

function onPlayerState(id: string, state: { x: number; y: number }) {
  targetsById.set(id, { x: state.x, y: state.y });
}

function updateEntity(sprite: Phaser.GameObjects.Sprite, target: { x: number; y: number }, alpha: number) {
  sprite.x = Phaser.Math.Linear(sprite.x, target.x, alpha);
  sprite.y = Phaser.Math.Linear(sprite.y, target.y, alpha);
}
```

Use stronger correction for competitive or collision-sensitive entities, and smoother interpolation for remote visuals that can tolerate softness.

## Input Pattern

Send intent, not truth.

Good:

```ts
room.send("move", { x: inputX, y: inputY, seq });
room.send("attack", { ability: "slash", aim });
```

Bad:

```ts
room.send("setPosition", { x: player.x, y: player.y });
room.send("applyDamage", { targetId, amount: 50 });
```

The scene can still do client-side anticipation. It just should not decide the final answer.

## Listener Cleanup

Phaser scene restarts make duplicated listeners easy to create.

At minimum:

- keep references to room listeners
- remove or detach them when the scene shuts down
- destroy sprites for entities that are no longer relevant
- avoid creating multiple room sessions during scene transitions unless intentional

If the room outlives the scene, the room session should live outside the scene and the scene should subscribe and unsubscribe cleanly.

## Animation Guidance

Usually synchronize gameplay facts, not animation state directly.

Examples:

- synchronize velocity or movement direction
- decide walk, idle, hurt, and death animations locally from authoritative facts
- use server broadcasts for rare one-shot events that must line up across clients

Do not network every frame of an animation unless the gameplay genuinely depends on exact frame identity.

## Phaser-Specific Anti-Patterns

- Recreating every sprite on each `onStateChange` instead of incrementally updating registries
- Starting a new room connection every time a scene changes
- Treating Arcade Physics positions as authoritative in a multiplayer game
- Mixing local camera and UI state into Colyseus schema
- Forgetting to destroy listeners on scene shutdown, causing duplicate message handling

## How This Adapts to Other Renderers

The same Colyseus model survives renderer changes:

- Phaser uses sprite registries and scene lifecycle hooks
- Three.js uses object maps and render-loop interpolation
- React uses subscribed view models and component lifecycles
- ECS-based clients use entity IDs and systems that read authoritative snapshots

Only the adapter changes. The room model, message design, and trust boundaries should not.
