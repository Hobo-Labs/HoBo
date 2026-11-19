import type { JsonValue } from "../json.js";
import { createPortDescriptor, type PortDescriptor } from "../ports.js";

// public-contract: extension-point id for actor-host runtime adapters (extension-points.md).
export const ACTOR_HOST_EXTENSION_POINT = "hobo.actor-host/v1";

// public-contract: WIT-style interface id of the actor-host port
export const ACTOR_HOST_PORT_INTERFACE = "hobo:runtime/actor-host@0.1.0";

export const ACTOR_HOST_PORT_DESCRIPTOR: PortDescriptor = createPortDescriptor({
	kind: "runtime",
	name: "actor-host",
	interface: ACTOR_HOST_PORT_INTERFACE,
	stability: "preview",
});

export interface FoldEvent {
	type: string;
	[key: string]: JsonValue;
}

export interface ActorLease {
	readonly key: string;
	readonly holderId: string;
	readonly fenceToken: bigint;
	readonly expiresAt: string;
	release(): void;
}

export interface ActorStateHandle<S> {
	append(
		lease: ActorLease,
		event: FoldEvent,
	): { streamId: string; seq: number; fenceToken: bigint };
	read(): { streamId: string; seq: number; state: S };
	passivate?(lease: ActorLease): { streamId: string; seq: number; state: S };
}

export interface ActorLeaseHost {
	acquire(key: string, request: { holderId: string }): ActorLease;
}

export interface AsyncActorLease {
	readonly key: string;
	readonly holderId: string;
	readonly fenceToken: bigint;
	readonly expiresAt: string;
	revalidate(): Promise<void>;
	release(): Promise<void>;
}

export interface AsyncActorLeaseHost {
	acquire(key: string, request: { holderId: string }): Promise<AsyncActorLease>;
}

export interface ActorHost extends ActorLeaseHost {
	state<S>(
		key: string,
		request: {
			initialState: S;
			fold: (state: S, event: FoldEvent) => S;
			snapshotKey?: object;
		},
	): ActorStateHandle<S>;
}
