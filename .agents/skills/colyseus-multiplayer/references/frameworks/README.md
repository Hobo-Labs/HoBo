# Framework Integrations

Colyseus is framework-agnostic on the client. The room model, message design, and deployment topology should stay stable while the renderer-specific glue changes.

## Available Integrations

- `phaser.md` — Phaser scene lifecycle, entity registry, interpolation, and listener cleanup

Add more files here as needed instead of polluting the core skill with renderer-specific details.

## The Generic Integration Pattern

Every framework-specific integration should answer the same questions:

### 1. Where does the `Client` live?

- top-level singleton
- app-level service
- shared context/provider
- engine plugin

The `Client` and active `Room` should usually outlive scene, route, or component transitions.

### 2. How does schema state map to render objects?

- entity added -> spawn render object
- entity changed -> update target state or visual model
- entity removed -> destroy render object
- whole-state field changed -> refresh HUD or coarse UI

Use a renderer-side registry keyed by `sessionId` or `entityId`. Do not rebuild the world every frame from scratch.

### 3. How does input become messages?

Renderer input should be translated into intent payloads, not authoritative facts.

Examples:
- movement intent
- aim vector
- selected ability
- ready / interact / emote

### 4. How does the render loop relate to patch timing?

- remote entities usually interpolate
- local controlled entities may predict and reconcile
- turn-based or menu-driven experiences may simply snap to state

The right choice depends on genre and latency tolerance.

## Adding a New Framework Reference

When adding `references/frameworks/<name>.md`, cover:

1. bootstrap and where the client/room live
2. state-to-render binding
3. input-to-message mapping
4. reconnection UX
5. framework-specific gotchas

Keep shared client/networking guidance in `../client.md`. Keep authoritative architecture in `../architecture.md`.

## Common Targets

- **Three.js**: object maps, interpolation in the render loop, input service outside the scene graph
- **React**: provider or store for the active room, callback-driven view models, component lifecycle cleanup
- **PixiJS**: display-object registry and ticker-driven interpolation
- **ECS clients**: entity IDs plus systems that read authoritative snapshots and prediction state
