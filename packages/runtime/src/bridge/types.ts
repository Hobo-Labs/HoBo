// The Bridge: session-scoped boundary routing for local/remote dev
// (generalizes Bridge-to-Kubernetes beyond Kubernetes). Every
// service boundary is a WIT port whose peers are PACT-emulable, so a
// boundary can be re-pointed per DEV SESSION — your calls take the bridge
// to the process on your laptop, everyone else's stay live — on any
// provider, because the routing happens at the boundary, not in the
// orchestrator. The modes are the ADR-0076 set (live · mock · fork/bridge
// · shadow · record/replay · fault); recording is always on, so every
// bridged session doubles as specification-by-example capture.

/** How a boundary served one call. */
import type { JsonValue } from "../json.js";
export type BoundaryServed = "live" | "mock" | "bridge" | "replay" | "fault";

/** A PACT-interaction-shaped example: expected output for a given input. */
export interface BoundaryExample<I = JsonValue, O = JsonValue> {
	readonly input: I;
	readonly output: O;
}

/**
 * The contract a bridged implementation must satisfy BEFORE the bridge
 * carries traffic — typically the boundary's PACT interactions or its
 * recorded live traces. Verification is subset-matching (the expected
 * output must be a recursive subset of the actual), the same discipline
 * the PACT harness applies.
 */
export interface BridgeContract<I = JsonValue, O = JsonValue> {
	readonly examples: readonly BoundaryExample<I, O>[];
}

export interface BridgeOptions<I = JsonValue, O = JsonValue> {
	/**
	 * Dev-session tag (a branch name, a user id, a preview-env id). Only
	 * calls made with the same session tag take the bridge; untagged
	 * traffic stays on the live route. Omit to bridge ALL traffic (a
	 * whole-boundary fork).
	 */
	readonly session?: string;
	/** Verified against the local implementation before activation. */
	readonly contract?: BridgeContract<I, O>;
}

export interface RecordedBoundaryCall<I = JsonValue, O = JsonValue> {
	readonly input: I;
	readonly output?: O;
	readonly error?: string;
	readonly served: BoundaryServed;
	readonly session?: string;
	readonly order: number;
}

/** One shadow comparison: the candidate's output vs the served output. */
export interface ShadowDiff<I = JsonValue> {
	readonly input: I;
	readonly served: JsonValue;
	readonly candidate: unknown;
	readonly matched: boolean;
	readonly order: number;
}

export interface FaultOptions {
	readonly message: string;
	/** Restrict the fault to one dev session (chaos without blast radius). */
	readonly session?: string;
}

export interface BoundaryStatus {
	readonly boundary: string;
	readonly hasLive: boolean;
	readonly mockExamples: number;
	readonly bridgedSessions: readonly string[];
	readonly replaying: boolean;
	readonly shadowing: boolean;
	readonly fault?: string;
	readonly calls: number;
}

export class BridgeContractError extends Error {
	readonly code = "hobo.bridge.contract" as const;
	readonly boundary: string;
	readonly failures: readonly string[];

	constructor(boundary: string, failures: readonly string[]) {
		super(
			`bridged implementation for boundary "${boundary}" fails its contract (${failures.length} interaction${failures.length === 1 ? "" : "s"}): ${failures.join("; ")} — fix the local implementation or refresh the contract from the broker before bridging`,
		);
		this.name = "BridgeContractError";
		this.boundary = boundary;
		this.failures = failures;
	}
}

export class BoundaryRoutingError extends Error {
	readonly code = "hobo.bridge.routing" as const;

	constructor(message: string) {
		super(message);
		this.name = "BoundaryRoutingError";
	}
}
