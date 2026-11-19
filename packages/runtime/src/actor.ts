import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";
import type { ActorHost, ActorLease, FoldEvent } from "./ports.js";

export interface ActorHandlerContext<S> {
	readonly key: string;
	readonly fenceToken: bigint;
	state(): S;
	emit(event: FoldEvent): number;
}

export interface DefineActorInput<S, M extends FoldEvent = FoldEvent> {
	name: string;
	initialState: () => S;
	fold: (state: S, event: FoldEvent) => S;
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

export interface ActorInstance<S, M extends FoldEvent = FoldEvent> {
	readonly key: string;
	readonly fenceToken: bigint;
	send(message: M): Promise<void>;
	state(): S;
	passivate(): void;
}

export function activateActor<S, M extends FoldEvent = FoldEvent>(
	host: ActorHost,
	def: ActorDefinition<S, M>,
	key: string,
	options: { holderId: string },
): ActorInstance<S, M> {
	const actorKey = `${def.name}/${key}`;
	const lease: ActorLease = host.acquire(actorKey, {
		holderId: options.holderId,
	});
	const stateHandle = host.state<S>(actorKey, {
		initialState: def.initialState(),
		fold: (state, event) => foldExceptLifecycle(def, state, event),
		snapshotKey: def.fold,
	});

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
			try {
				if (stateHandle.passivate) stateHandle.passivate(lease);
				else lease.release();
			} catch (error) {
				passivated = true;
				try {
					lease.release();
				} catch {}
				throw error;
			}
			passivated = true;
		},
	});
}

function foldExceptLifecycle<S, M extends FoldEvent>(
	def: ActorDefinition<S, M>,
	state: S,
	event: FoldEvent,
): S {
	if (event.type === "actor.StateAppended" && isRecord(event.payload)) {
		return def.fold(state, event.payload as FoldEvent);
	}
	return state;
}

function isRecord(value: JsonValue | undefined): value is JsonObject {
	return isJsonObject(value) && value !== null;
}
