import {
  createInMemoryActorHost,
  createManualClock,
  StaleFenceError,
} from "../../actor-host-runtime-port-contract/src/actor-host-runtime-port.js";

import type { ActorKey, Message, MessageMap } from "./types.js";
import { type JsonValue } from "./json.js";


export interface ActorRef<S, M extends MessageMap<S>> {
  name: string;
  key(id: string): ActorKey;
  definition: { state: () => S; on: M };
}

type StoredActorDef = { state: () => JsonValue; on: MessageMap<JsonValue> };
const actorDefinitions = new Map<string, StoredActorDef>();
const signalLedger = new Map<string, number>();
let sharedActorHost = createInMemoryActorHost();

export function resetActorHostForTests() {
  sharedActorHost = createInMemoryActorHost();
  actorDefinitions.clear();
  signalLedger.clear();
}

export function getSharedActorHostForTests() {
  return sharedActorHost;
}

export function actor<S, M extends MessageMap<S>>(
  name: string,
  def: { state: () => S; on: M },
): ActorRef<S, M> {
  // SAFETY: actor definitions are stored erased at the registry edge.
  const stored: StoredActorDef = def as never;
  actorDefinitions.set(name, stored);
  return {
    name,
    key(id: string) {
      return { actor: name, id };
    },
    definition: def,
  };
}

export async function signal(key: ActorKey, msg: Message): Promise<number> {
  const actorKey = `${key.actor}:${key.id}`;
  const def = actorDefinitions.get(key.actor);
  if (!def) {
    throw new Error(`unknown actor: ${key.actor}`);
  }

  const dedupeKey = msg.idempotencyKey ?? `${actorKey}:${msg.type}`;
  if (signalLedger.has(dedupeKey)) {
    return signalLedger.get(dedupeKey)!;
  }

  const host = sharedActorHost;
  const lease = host.acquire(actorKey, { holderId: "runtime-signal" });
  const durable = host.state(actorKey, {
    initialState: structuredClone(def.state()),
    fold(state, event) {
      const handler = def.on[event.type];
      if (!handler) {
        return state;
      }
      return handler(state, { type: event.type, payload: event.payload }, { emit: async () => 0 });
    },
  });

  try {
    const receipt = await durable.append(lease, {
      type: msg.type,
      payload: msg.payload,
      idempotencyKey: msg.idempotencyKey,
    });
    signalLedger.set(dedupeKey, Number(receipt.seq));
    return Number(receipt.seq);
  } finally {
    await lease.release();
  }
}

export { StaleFenceError, createInMemoryActorHost, createManualClock };
