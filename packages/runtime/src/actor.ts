// `actor` — a durable, single-writer grain (sdk-api.md §Layer 4, lowering onto
// `hobo:runtime/actor`). State is folded from the actor's own event stream; a
// single writer is enforced by the injected ActorHost's lease + fence token
// (`@hobo/runtime-local` supplies the durable impl in tests). Contended
// activation is denied; a superseded writer's append is rejected on a stale
// fence — exactly-one-writer. Lifecycle emits `actor.Activated` /
// `actor.StateAppended` / `actor.Passivated`.

import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";
import type { ActorHost, ActorLease, FoldEvent } from "./ports.js";

/** The context a message handler mutates: current folded state + emit-under-lease. */
export interface ActorHandlerContext<S> {
	readonly key: string;
	readonly fenceToken: bigint;
	/** Current folded state (read fresh from the stream). */
	state(): S;
	/** Append a domain event to the actor's stream under the held lease. */
	emit(event: FoldEvent): number;
}

export interface DefineActorInput<S, M extends FoldEvent = FoldEvent> {
	name: string;
	initialState: () => S;
	/** Fold a domain event into state (deterministic; rebuildable from zero). */
	fold: (state: S, event: FoldEvent) => S;
	/** Message handlers, keyed by message `type`. */
	handlers: Record<
		string,
		(ctx: ActorHandlerContext<S>, message: M) => void | Promise<void>
	>;
}

export interface ActorDefinition<S, M extends FoldEvent = FoldEvent> {
	readonly name: string;
	readonly initialState: () => S;
	readonly fold: (state: S, event: FoldEvent) => S;
	readonly handlers: DefineActorInput<S, M>["handlers"];
}

/** Define a grain: name + initial state + fold + message handlers. */
export function defineActor<S, M extends FoldEvent = FoldEvent>(
	input: DefineActorInput<S, M>,
): ActorDefinition<S, M> {
	if (!input.name) {
		throw new TypeError("actor name must be a non-empty string");
	}
	return Object.freeze({
		name: input.name,
		initialState: input.initialState,
		fold: input.fold,
		handlers: Object.freeze({ ...input.handlers }),
	});
}

/** A live, activated actor instance holding the single-writer lease. */
export interface ActorInstance<S, M extends FoldEvent = FoldEvent> {
	readonly key: string;
	readonly fenceToken: bigint;
	/** Deliver a message; runs the matching handler under the lease. */
	send(message: M): Promise<void>;
	/** Current folded state. */
	state(): S;
	/** Release the lease and record `actor.Passivated`. */
	passivate(): void;
}

/**
 * Activate a grain for `key` against the ActorHost. Acquires the single-writer
 * lease (throws if the key is already held — contended activation is denied),
 * folds state from the stream, and records `actor.Activated`.
 */
export function activateActor<S, M extends FoldEvent = FoldEvent>(
	host: ActorHost,
	def: ActorDefinition<S, M>,
	key: string,
	options: { holderId: string },
): ActorInstance<S, M> {
	const actorKey = `${def.name}/${key}`;
	// Lease acquisition is the single-writer gate: the host throws when the key
	// is already leased by a live holder.
	const lease: ActorLease = host.acquire(actorKey, {
		holderId: options.holderId,
	});
	const stateHandle = host.state<S>(actorKey, {
		initialState: def.initialState(),
		fold: (state, event) => foldExceptLifecycle(def, state, event),
	});

	// Record activation. Lifecycle events fold to a no-op on state.
	stateHandle.append(lease, {
		type: "actor.Activated",
		holderId: options.holderId,
	});

	let passivated = false;
	const assertLive = () => {
		if (passivated) {
			throw new Error(`actor ${actorKey} has been passivated`);
		}
	};

	const handlerContext: ActorHandlerContext<S> = Object.freeze({
		key,
		fenceToken: lease.fenceToken,
		state: () => stateHandle.read().state,
		emit(event: FoldEvent) {
			// Append under the held lease. A stale fence (a newer holder acquired
			// the key) is rejected by the host — this is the write-side of
			// exactly-one-writer.
			const appended = stateHandle.append(lease, {
				type: "actor.StateAppended",
				payload: event,
			});
			return appended.seq;
		},
	});

	return Object.freeze({
		key,
		fenceToken: lease.fenceToken,
		async send(message: M) {
			assertLive();
			const handler = def.handlers[message.type];
			if (!handler) {
				throw new Error(`actor ${def.name} has no handler for ${message.type}`);
			}
			await handler(handlerContext, message);
		},
		state: () => stateHandle.read().state,
		passivate() {
			if (passivated) {
				return;
			}
			stateHandle.append(lease, { type: "actor.Passivated" });
			lease.release();
			passivated = true;
		},
	});
}

/**
 * Fold that applies domain events (carried inside `actor.StateAppended`) and
 * ignores lifecycle markers, so state stays a pure fold of domain events.
 */
function foldExceptLifecycle<S, M extends FoldEvent>(
	def: ActorDefinition<S, M>,
	state: S,
	event: FoldEvent,
): S {
	if (event.type === "actor.StateAppended" && isRecord(event.payload)) {
		// SAFETY: assertion to `load as FoldEvent); } re` is required at this boundary.
		return def.fold(state, event.payload as FoldEvent);
	}
	return state;
}

function isRecord(value: JsonValue | undefined): value is JsonObject {
	return isJsonObject(value) && value !== null;
}
