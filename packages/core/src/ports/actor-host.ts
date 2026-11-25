import type { JsonValue } from "../json.js";
import { createPortDescriptor, type PortDescriptor } from "../ports.js";

// The canonical ActorHost port (ADR-0156). Before ADR-0156 this seam was
// re-declared, structurally identically, in @hobo/runtime, @hobo/data,
// @hobo/conformance, and each actor-capable runtime adapter — compatible by
// accident, not by contract. glossary.md always listed ActorHost among the
// runtime ports; this module makes that true. Wire form:
// data-models/actor_host_port.proto (+ CUE constraints). Actor addressing
// stays with ports/actor-identity.ts; resolver capability matching with
// ports/actor-requirements.ts.

// public-contract: extension-point id for actor-host runtime adapters (extension-points.md).
export const ACTOR_HOST_EXTENSION_POINT = "hobo.actor-host/v1";

// public-contract: WIT-style interface id of the actor-host port
// (hobo:runtime/actor is the guest-facing WIT; this is the host seam).
export const ACTOR_HOST_PORT_INTERFACE = "hobo:runtime/actor-host@0.1.0";

export const ACTOR_HOST_PORT_DESCRIPTOR: PortDescriptor = createPortDescriptor({
	kind: "runtime",
	name: "actor-host",
	interface: ACTOR_HOST_PORT_INTERFACE,
	stability: "preview",
});

/** A folded actor event: a discriminated `type` plus an open payload. */
export interface FoldEvent {
	type: string;
	[key: string]: JsonValue;
}

/**
 * Single-writer lease with a monotonic fence token (sdk-api.md §Layer 1).
 * Acquiring an already-held key is denied; a newer holder gets a strictly
 * greater `fenceToken`, so a stale writer's append is rejected. Fence tokens
 * are per-key monotonic — a host sharing one epoch across keys does not
 * conform.
 */
export interface ActorLease {
	readonly key: string;
	readonly holderId: string;
	readonly fenceToken: bigint;
	readonly expiresAt: string;
	release(): void;
}

/** The actor's durable state, folded from its own event stream under a lease. */
export interface ActorStateHandle<S> {
	append(
		lease: ActorLease,
		event: FoldEvent,
	): { streamId: string; seq: number; fenceToken: bigint };
	read(): { streamId: string; seq: number; state: S };
}

/**
 * The lease-only narrowing of the host: single-writer placement without the
 * durable state handle. `@hobo/data` realizes an aggregate's consistency
 * boundary against exactly this shape.
 */
export interface ActorLeaseHost {
	acquire(key: string, request: { holderId: string }): ActorLease;
}

/** A distributed lease must await the shared authority for every transition. */
export interface AsyncActorLease {
	readonly key: string;
	readonly holderId: string;
	readonly fenceToken: bigint;
	readonly expiresAt: string;
	/** Revalidate against the shared authority; this does not fence external I/O. */
	revalidate(): Promise<void>;
	release(): Promise<void>;
}

export interface AsyncActorLeaseHost {
	acquire(key: string, request: { holderId: string }): Promise<AsyncActorLease>;
}

/** The virtual-actor host: lease placement + durable per-key state. */
export interface ActorHost extends ActorLeaseHost {
	state<S>(
		key: string,
		request: { initialState: S; fold: (state: S, event: FoldEvent) => S },
	): ActorStateHandle<S>;
}
