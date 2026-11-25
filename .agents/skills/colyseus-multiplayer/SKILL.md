---
name: colyseus-multiplayer
description: "Build authoritative multiplayer games with Colyseus: room design, schema state sync, matchmaking, reconnects, auth, deployment, and browser-engine integration for Phaser, Three.js, PixiJS, React, or custom web clients."
metadata:
  short-description: "Colyseus architecture, state sync, deployment, and engine integration."
---

# Colyseus Multiplayer

Design and implement real-time multiplayer games with Colyseus without coupling the networking model to a specific renderer.

## Philosophy: Authority First, Rendering Second

Colyseus works best when the server owns truth and the client expresses intent. The room is not a transport wrapper around a local game loop; it is the game loop for anything that must be fair, consistent, and recoverable after reconnects.

Use this mental model as the default framework and mindset for multiplayer decisions. The guiding question is not "how do I mirror my frontend over websockets?" but "why does this fact deserve to be authoritative, and what is the simplest server-owned model that clients can understand and render?"

**Before building, ask:**
- What state must be authoritative, and what is purely cosmetic?
- What belongs in a room boundary: one match, one lobby, one shard, or one encounter?
- Which client messages are player intent, and which facts should only ever come from the server?
- How should late joins, reconnects, spectators, and disconnects behave?
- What latency strategy fits this game: simple interpolation, client prediction, or prediction plus reconciliation?

**Core principles**:
1. Server owns truth: movement, combat, timers, win conditions, inventory, and room membership should not depend on client trust.
2. Shared state stays minimal: synchronize durable game facts, not the entire scene graph or renderer state.
3. Separate channels deliberately: schema state is for durable world state, messages are for intent and transient events, local code handles cosmetics.
4. Recovery is part of the feature: reconnect handling, validation, throttling, and auth are not optional extras.
5. Renderer choice is downstream: Phaser, Three.js, PixiJS, React, and custom canvases should adapt to the same room model rather than reshaping it.

This approach keeps the networking framework understandable even as the renderer, genre, and production constraints change.

## Reference Files

Read these before doing substantial work in the matching area:

| When working on... | Read first |
|--------------------|------------|
| Room design, schema modeling, message boundaries, lifecycle hooks, or matchmaker usage | `references/architecture.md` |
| TypeScript client wiring, `Callbacks`, join methods, messages, reconnection, or prediction | `references/client.md` |
| Code review, design review, or "what should we stop doing?" questions | `references/anti-patterns.md` |
| Production topology, Vercel frontend plus separate backend, env vars, auth transport, or rollout planning | `references/deployment.md` |
| Picking or extending a renderer integration | `references/frameworks/README.md` |
| Phaser scene integration, sprite/entity mapping, interpolation, or listener cleanup | `references/frameworks/phaser.md` |

If the client is not Phaser-based, skip the Phaser reference and keep the renderer adapter thin. The core Colyseus model should survive a renderer swap.

## When to use this skill

- Designing a new multiplayer game with Colyseus
- Adding netplay to an existing Phaser, Three.js, PixiJS, React, or custom web game
- Deciding what should be schema state versus what should be a message
- Debugging desyncs, reconnects, join failures, or late-join behavior
- Planning matchmaking, room topology, or deployment
- Reviewing multiplayer code for authority mistakes, renderer coupling, or scaling risk

## Quick Decision Guide

| Question | Answer | Where to look |
|----------|--------|---------------|
| Where should this fact live? | Usually room schema state if reconnects or late joins need it | `references/architecture.md` |
| How should the client react to state changes? | `Callbacks` with `listen`, `onAdd`, and `onRemove` | `references/client.md` |
| How should players trigger actions? | `room.send(type, payload)` for intent, validated server-side | `references/client.md` |
| How do we recover from disconnects? | `onDrop()` plus `allowReconnection()` and client reconnect flow | `references/architecture.md` and `references/client.md` |
| How do we avoid bad multiplayer habits? | Use the anti-pattern checklist during design and review | `references/anti-patterns.md` |
| How do we host this with a Vercel frontend? | Separate static frontend and always-on realtime backend | `references/deployment.md` |
| How do we wire Phaser specifically? | Use a thin adapter and scene-safe listener lifecycle | `references/frameworks/phaser.md` |

## Working Model

- `Room` is the authoritative boundary for a multiplayer session.
- `Schema` state is the shared world model that clients subscribe to.
- `room.send()` and `onMessage()` represent client intent and server-side command handling.
- `broadcast()` is for transient events that should not live in durable room state.
- `setSimulationInterval()` is the fixed server-side update loop for simulation.
- `onDrop()`, `allowReconnection()`, and `onReconnect()` define recovery behavior.
- `matchMaker` is the server-side orchestration layer for room creation, search, seat reservation, and stats.
- `onAuth()` and `client.auth.token` define the trust boundary.

## Design Workflow

### 1. Define the room boundary early

- Choose whether a room represents a lobby, a match, a raid instance, a social hangout, or a shard.
- Decide whether players join by `joinOrCreate`, `join`, `joinById`, or a server-reserved seat.
- Design around player flows: create, invite, reconnect, spectate, leave, rematch.

### 2. Separate state, intent, and cosmetics

- Put durable world facts in schema state: entity positions that matter, health, cooldowns, timers, ownership, score, round phase.
- Put player requests in messages: move, aim, cast, ready, interact, select loadout.
- Put purely visual behavior on the client: camera shake, interpolation, particles, audio, screen flashes, local anticipation.

### 3. Model schema by identity, not by presentation

- Prefer stable entity IDs and keyed collections over arrays that shift frequently.
- Keep schema shape close to game rules, not close to scene node hierarchy.
- Store canonical values. Derived display values should usually be computed client-side.
- Use schema fields for facts that must survive reconnects or be visible to late joiners.

### 4. Simulate on the server

- Run the authoritative simulation from the room, usually at a fixed tick.
- Validate every incoming message before applying it.
- Correct clients when their local prediction diverges.
- Throttle abusive message rates and reject impossible actions.

### 5. Plan failure paths before polish

- Decide when a dropped player remains in-state as disconnected versus being removed immediately.
- Decide whether the match pauses, substitutes AI, or continues.
- Decide how long seat reservations and reconnect windows last.
- Decide which errors are user-visible versus operational.

### 6. Deploy it like a backend, not like a static site

- Treat Colyseus as an always-on realtime service.
- Host the web client wherever you like, including Vercel, but host the Colyseus server on infrastructure meant for long-lived websocket connections.
- Keep production config explicit: URL, TLS, auth token strategy, region choice, observability, graceful shutdown.

### 7. Add a runtime-debug surface early

- Add a small `/health` route before production rollout.
- Use it to report:
  - service liveness
  - protocol version
  - build label
  - whether critical runtime envs are actually visible to the process
- Distinguish clearly between:
  - dashboard env state
  - deployed git revision
  - active process runtime state
- If platform behavior is ambiguous, add explicit health/debug fields and targeted log lines rather than inferring from UI or deployment dashboards.

### 8. Treat analytics and replay as authoritative backend concerns

- Emit analytics from accepted server intents and authoritative outcomes, not from browser telemetry.
- Separate summary analytics from replay storage.
- For exact replay, prefer:
  - input/event logs
  - periodic authoritative snapshots
  over position sampling alone.
- Add observable confirmation for sink activation, e.g.:
  - analytics sink enabled
  - first match/session write attempt
- Force final checkpoints once at match end; never bypass throttles every simulation tick.

### 9. Keep asset/body/render contracts explicit

- If the multiplayer server simulates bodies while the client renders sprites, define an explicit anchor contract.
- Prefer first-class metadata such as `feetLine` or `contactY` for all entities rendered from authoritative state.
- Keep single-player and multiplayer aligned on:
  - collision box semantics
  - contact point semantics
  - facing/direction semantics
- If multiplayer uses simplified collision geometry instead of tile bodies, keep that geometry in sync with real level data or expect drift.

## Deployment Playbook

Use this shape by default for small web games:

- Static frontend on Vercel (or equivalent)
- Always-on Colyseus backend on Colyseus Cloud or another persistent Node host
- Persistence/analytics backend separate from the room server when needed

**Colyseus Cloud checklist**:
- GitHub deploy key access or linked GitHub app access is configured.
- Backend package has a `build` script, even if it is a no-op.
- Project contains `ecosystem.config.cjs` or equivalent PM2 ecosystem file with a valid `script`.
- Runtime env is set in Cloud dashboard.
- Production health endpoint is checked after deploy, not just the dashboard status.

**Vercel/static frontend checklist**:
- If the repo is plain static files, do not add Vite just for hosting unless you actually need a build system.
- Be explicit about the output directory when the repo shape is ambiguous.
- Avoid stale ES module mixes by controlling cache headers for raw `/src/*` modules and public runtime config.

**Convex/analytics checklist**:
- Convex prod functions are actually deployed.
- The authoritative server and Convex deployment share the same ingest key.
- Verify first writes at room creation/join, not only at match end.

**General deployment lessons**:
- If the frontend is a plain static site, do not add a bundler migration just to satisfy hosting defaults unless you actually need one.
- Keep frontend public runtime config explicit. Do not assume browser code can read private hosting env vars automatically.
- Expect Cloud deploys to use pushed repository state, not your current local working tree.
- Distinguish clearly between:
  - configured env vars
  - deployed revision
  - active runtime process state
- Use health endpoints and first-write logs to verify the active process, not just the deployment dashboard.

## Anti-Patterns to Avoid

Common mistakes in Colyseus work are usually boundary mistakes. Treat the items below as wrong-way signals and common pitfalls worth correcting early.

❌ **Client-authoritative gameplay**: trusting the browser for movement, hit confirmation, score, or item ownership makes cheating and desync easy.
Better: treat the client as an input device plus renderer; the room validates and decides outcomes.

❌ **Dumping the renderer into schema state**: synchronizing sprite flip flags, animation frame indices, camera settings, or object references bloats state and couples networking to one engine.
Better: synchronize canonical gameplay facts and derive presentation locally.

❌ **Using messages as ad-hoc RPC for everything**: when every state change is a message and nothing is modeled in schema, reconnects and late joins become fragile.
Better: keep durable truth in schema and use messages for commands and ephemeral events.

❌ **Treating one room as the whole backend**: giant rooms that hold lobby, matchmaking, global chat, and active combat usually become impossible to reason about.
Better: choose clear room boundaries and move orchestration to `matchMaker` or surrounding backend code.

❌ **Binding room state directly to engine objects**: storing Phaser sprites, Three.js meshes, or UI components inside network code guarantees leaks and awkward lifecycle bugs.
Better: keep a thin adapter layer that maps schema entities to renderer objects.

❌ **Ignoring reconnects until late**: many multiplayer bugs are really reconnection bugs discovered too late.
Better: design `onDrop`, `allowReconnection`, and session recovery up front.

❌ **Trying to host the authoritative Colyseus server on Vercel Functions**: request-scoped infrastructure is the wrong shape for a stateful websocket game server.
Better: deploy the frontend on Vercel if you want, and deploy Colyseus on Colyseus Cloud or another always-on Node host.

❌ **Retrofitting multiplayer directly into single-player scene logic**: trying to make one scene serve both local-authority and server-authority flows usually creates confused ownership and brittle conditionals.
Better: keep single-player intact and create a dedicated multiplayer scene/adapter that renders authoritative room state.

❌ **Assuming dashboard env configuration means the runtime sees it**: deployment UIs often show configured values even when the active process is still stale.
Better: confirm env visibility through `/health` and startup/runtime logs.

❌ **Relying on local working copy for Cloud deploys**: git-based platforms deploy pushed repo state, not the current editor buffer.
Better: commit, push, deploy, then verify the running build explicitly.

❌ **Using simplified collision rectangles without tracking the real level/asset contract**: this is how you get visible floor that does not collide, or server bodies that float above the ground.
Better: either derive authoritative geometry from canonical level data or keep the simplified geometry updated alongside level/layout edits.

❌ **Making pre-match waiting fully inert by default**: dead waiting rooms feel broken and hard to test.
Better: allow movement and optionally warmup attacks during `waiting` / `countdown`, but gate damage until `playing`.

❌ **Writing replay checkpoints every tick at match end**: forcing the finalization path inside the full results loop will flood persistence and obscure the real bug.
Better: capture one final forced checkpoint inside match-finalization and guard it explicitly.

**NEVER** let renderer convenience decide the trust boundary.
**DO NOT** model your room around one engine's scene graph.
**DON'T** treat "it worked locally" as proof that reconnects, auth, or deployment are correct.

## Variation Guidance

**IMPORTANT**: Good Colyseus solutions should vary by genre, trust model, and renderer.

- Room topology should vary: duel rooms, co-op instances, party lobbies, social hubs, or shard-like worlds.
- Sync strategy should vary: simple server authority, buffered interpolation, or full prediction and reconciliation.
- Message shapes should vary by game: directional input streams for action games, commands for tactics games, coarse actions for social or async-friendly games.
- Renderer adapters should vary: Phaser scene registries, Three.js object maps, React state bridges, or ECS integrations.
- Deployment shape should vary with scale: one process for prototypes, multi-process plus shared presence for production, multi-region only when latency and ops justify it.
- Waiting-room UX should vary: some games need strict lockout, some benefit from warmup movement/combat, some need social/lobby behavior instead.
- Analytics depth should vary: lightweight session summaries for early ops, replay-grade event/snapshot capture only when the product actually needs it.

Avoid converging on one favorite boilerplate. The right Colyseus architecture depends on fairness needs, scale, simulation complexity, and how expensive corrections feel to the player.

## Remember

Colyseus is strongest when it owns multiplayer truth cleanly and your renderer stays replaceable.

Design rooms around rules and player flows, not around frontend scenes. Keep state canonical, messages intentional, and engine code on the edge.

When the platform gets confusing, stop guessing. Add a health field, add a startup log, add one first-write log, and prove what the runtime actually sees.

Codex is capable of extraordinary Colyseus work: it can unlock cleaner room models, empower renderer swaps, enable creative networking tradeoffs, and explore multiple architectures across different frontends when the boundaries are clear. These guidelines illuminate the path; they do not fence it.
