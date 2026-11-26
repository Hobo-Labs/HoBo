import type {
	ActorHost,
	ActorStateHandle,
	EventEnvelope,
	EventStore,
	FoldHandlers,
	FoldResult,
	Queue,
	VirtualClock,
} from "@hobo/core";
import type { JsonValue } from "../../json.js";

export const RUNTIME_PORT_CONFORMANCE_VERSION =
	"hobo.runtime-port-conformance/v1";

// The ActorHost seam under test is the canonical `@hobo/core` port (ADR-0156);
// the suite keeps its historical exported names as aliases.
export type { ActorLease as ActorHostLease } from "@hobo/core";
export type ActorHostState<S = JsonValue> = ActorStateHandle<S>;
export type { ActorHost as ActorHostPort } from "@hobo/core";

export interface ConformanceEventStore extends EventStore {
	fold<S>(
		streamId: string,
		opts: { initialState: S; handlers: FoldHandlers<S> },
	): Promise<FoldResult<S>>;
}

export interface RuntimeDurabilityBackend {
	readonly name: string;
	readonly eventStore: ConformanceEventStore;
	readonly queue: Queue;
	readonly clock: VirtualClock;
	readonly actorHost: ActorHost;
}

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface ConformanceCheckResult {
	readonly checkId: string;
	readonly port: string;
	readonly tag: "local";
	readonly status: "pass" | "fail";
}

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface ConformanceFailure {
	readonly checkId: string;
	readonly message: string;
}

// domain-view: parse-dont-validate parsed/derived type (branded ids, generics, or richer domain fields); its generated *_pb.ts is the wire form (technical-standards.md, IMPL-011).
export interface RuntimePortConformanceReport {
	readonly contract: typeof RUNTIME_PORT_CONFORMANCE_VERSION;
	readonly backend: string;
	readonly status: "pass" | "fail";
	readonly checks: readonly ConformanceCheckResult[];
	readonly failures: readonly ConformanceFailure[];
	readonly coverage: {
		readonly local: {
			readonly status: "pass" | "fail";
			readonly passed: number;
			readonly failed: number;
			readonly total: number;
		};
	};
}

export async function readEventStream(
	store: EventStore,
	streamId: string,
): Promise<EventEnvelope[]> {
	const events: EventEnvelope[] = [];
	for await (const event of store.read(streamId)) {
		events.push(event);
	}
	return events;
}
