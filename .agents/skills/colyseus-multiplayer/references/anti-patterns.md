# Anti-Patterns

Use this reference during design and code review. Each anti-pattern is independent and maps to a specific kind of multiplayer failure.

## State vs Messages

❌ **Sending positions as messages every frame**
Why bad: bandwidth grows fast, reconnecting clients cannot rebuild the current world from transient packets, and you bypass Colyseus state sync.
Better: mutate authoritative position state on the server and let patches carry it.

❌ **Broadcasting state facts and syncing them in schema at the same time**
Why bad: now you have two sources of truth that can diverge.
Better: keep durable facts in schema; use broadcasts only for transient effects or announcements.

❌ **Putting one-shot effects in schema**
Why bad: fast-changing transient fields churn patches and late joiners do not need stale explosion or hit-flash markers.
Better: broadcast one-shot events and keep schema for persistent truth.

## Authority

❌ **Trusting client-supplied positions, damage, or inventory changes**
Why bad: this is the shortest path to cheats and desync.
Better: accept intent, validate it, and let the room decide outcomes.

❌ **Treating `room.state` as writable on the client**
Why bad: it is a mirror, not authoritative memory.
Better: send a message and react to the next server patch.

❌ **Using join options as identity**
Why bad: they are client-supplied and easy to spoof.
Better: authenticate in `onAuth()` and use returned identity data.

## Schema Design

❌ **One giant schema root with every concept flattened into it**
Why bad: harder diffs, noisier callbacks, and worse maintainability.
Better: use nested schemas, `MapSchema`, and `ArraySchema` with clear ownership.

❌ **Putting server-only caches and AI state into schema**
Why bad: wastes bandwidth and leaks internals.
Better: keep non-replicated structures on the room or plain helper classes.

❌ **Keeping unbounded history in synced arrays**
Why bad: late-join payloads and patch sizes grow without limit.
Better: cap visible history or move durable logs into storage outside schema.

## Lifecycle

❌ **Ignoring disconnect recovery until after gameplay works**
Why bad: reconnect bugs often reveal deeper room-boundary mistakes.
Better: design `onDrop()`, `allowReconnection()`, and cleanup policy early.

❌ **Deleting player state immediately while reconnection is still possible**
Why bad: the returning player loses their slot or authoritative context.
Better: mark them disconnected during the grace window and delete only after the reconnect promise fails or the window expires.

❌ **Blocking room setup with long external work**
Why bad: matchmaker and join flows become fragile.
Better: keep room creation fast; move long external work to earlier auth/account layers or explicit loading phases.

## Matchmaking

❌ **No `filterBy()` for public matchmaking**
Why bad: mode, region, or capacity options do not influence room selection cleanly.
Better: define filterable room metadata early.

❌ **Using `joinById` as the default public flow**
Why bad: it requires out-of-band room discovery and weakens matchmaking ergonomics.
Better: use `joinOrCreate` for public flows and reserve `joinById` for invites or private rooms.

## Messaging Discipline

❌ **Using `broadcast()` when only one client needs the event**
Why bad: bandwidth waste and unnecessary information disclosure.
Better: use `client.send()` for targeted events.

❌ **Not using `afterNextPatch` for state-coupled transient events**
Why bad: clients can receive the event before the corresponding state update.
Better: delay the event until after the relevant patch when ordering matters.

❌ **No payload validation at the room boundary**
Why bad: malformed payloads become runtime room bugs.
Better: validate input shapes before mutating authoritative state.

## Client Wiring

❌ **Hardcoding `localhost` or `ws://` into production paths**
Why bad: broken production builds and mixed-content issues.
Better: use environment variables and secure transport in production.

❌ **Binding renderer object lifecycle directly to broad `onStateChange` refreshes**
Why bad: full rebuilds are noisy and leak renderer concerns into networking design.
Better: use entity lifecycle callbacks and a renderer-side registry.

## Ops and Deployment

❌ **Trying to run the authoritative Colyseus backend on serverless request-scoped infrastructure**
Why bad: rooms and websocket sessions want long-lived processes.
Better: deploy the frontend statically and host Colyseus on an always-on Node platform.

❌ **Running multi-process without shared presence/driver infrastructure**
Why bad: room discovery and cross-process coordination break down.
Better: add shared driver/presence when you scale beyond one process.

❌ **Exposing live monitoring without protection**
Why bad: room metadata and live state become public.
Better: protect monitoring endpoints or disable them in production.
