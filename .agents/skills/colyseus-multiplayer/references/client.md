# Client Patterns

Use this reference when wiring a TypeScript browser client to Colyseus. The rendering layer can vary, but the client networking patterns should stay mostly the same.

## Philosophy: The Client Reflects State and Expresses Intent

The client should do three jobs well:

1. connect to the right room
2. react to authoritative state changes
3. send player intent without claiming authority

Anything beyond that is renderer glue or latency management.

## Install and Bootstrap

```bash
npm install @colyseus/sdk
```

```ts
import { Client } from "@colyseus/sdk";

export const client = new Client(import.meta.env.VITE_COLYSEUS_URL);
```

Use `http://localhost:2567` locally and `https://...` in production browser builds.

## Join Method Picker

| Method | Use when |
|--------|----------|
| `joinOrCreate(name, options)` | public matchmaking; default choice |
| `join(name, options)` | the room must already exist |
| `create(name, options)` | host flow or guaranteed fresh room |
| `joinById(roomId, options)` | private rooms and invite codes |
| `consumeSeatReservation(reservation)` | backend-controlled matchmaking |
| `reconnect(token)` | resume after a drop |

Default to `joinOrCreate` until a stronger product flow says otherwise.

## Shared Types

If client and server live in the same repo, share schema and server types explicitly.

```ts
import { Client } from "@colyseus/sdk";
import type { server } from "../../server/src/app.config";

const client = new Client<typeof server>(import.meta.env.VITE_COLYSEUS_URL);
```

If the repo is split, publish shared types or declarations rather than duplicating schema shape by hand.

## State Sync Callbacks

Use `Callbacks` for entity lifecycle and fine-grained field changes. This is usually better than polling `room.state` during every render frame.

```ts
import { Callbacks } from "@colyseus/sdk";

const room = await client.joinOrCreate("battle", { mode: "duo" });
const callbacks = Callbacks.get(room);

callbacks.listen("phase", (currentValue, previousValue) => {
  console.log("phase changed:", previousValue, "->", currentValue);
});

callbacks.onAdd("players", (player, sessionId) => {
  console.log("player joined:", sessionId);

  callbacks.listen(player, "hp", (currentHp, previousHp) => {
    console.log("hp changed:", previousHp, "->", currentHp);
  });
});

callbacks.onRemove("players", (_player, sessionId) => {
  console.log("player left:", sessionId);
});
```

Use `room.onStateChange()` when you genuinely need a broad "something changed" hook, typically for HUD-style refreshes.

## Sending and Receiving Messages

Messages are for intents and transient events.

```ts
room.send("move", { direction, seq });
room.send("attack", { ability: "slash", aim });

room.onMessage("damage", ({ amount, from }) => {
  playHitSfx();
  showDamageNumber(amount, from);
});
```

Good inputs:
- current directional intent
- aim vector
- selected ability
- ready / interact / emote

Bad inputs:
- absolute authoritative position
- trusted damage amounts
- direct inventory mutation

## Reconnection

Persist the reconnection token and try resume first.

```ts
const existingToken = sessionStorage.getItem("reconnectionToken");

let room;
try {
  room = existingToken
    ? await client.reconnect(existingToken)
    : await client.joinOrCreate("battle", { mode: "duo" });
} catch {
  room = await client.joinOrCreate("battle", { mode: "duo" });
}

sessionStorage.setItem("reconnectionToken", room.reconnectionToken);
```

Also handle lifecycle explicitly:

```ts
room.onLeave((code) => {
  if (code !== 1000) {
    showReconnectUI();
  }
});

room.onError((code, message) => {
  console.error("room error", code, message);
});

room.onReconnect(() => {
  hideReconnectUI();
});
```

## Prediction and Reconciliation

Only use this for games that actually need it.

Pattern:

1. send input sequence numbers with intent
2. predict locally for the controlled entity
3. snap or correct from authoritative server state
4. replay unacknowledged inputs if needed
5. interpolate remote entities

For turn-based, card, social, or relaxed co-op games, skip this complexity until real latency testing proves you need it.

## Debugging Checklist

- Log join success, `roomId`, and `sessionId`
- Attach `room.onError`, `room.onLeave`, and `room.onMessage("*", ...)` during bring-up
- Test with at least two tabs; three is better
- Simulate latency instead of assuming localhost behavior generalizes
- Confirm the client is reading env-configured URLs rather than hardcoded localhost values

## Client Anti-Patterns

- Polling `room.state` every frame instead of using callbacks for entity lifecycle
- Sending every render-frame transform as a message
- Mutating the local mirror of `room.state`
- Creating multiple active room sessions accidentally during scene or route changes
- Skipping visible reconnect and error UI, leaving the game to appear frozen
