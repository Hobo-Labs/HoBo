import type { JsonValue } from "../json.js";
export type BoundaryServed = "live" | "mock" | "bridge" | "replay" | "fault";

export interface BoundaryExample<I = JsonValue, O = JsonValue> {
	readonly input: I;
	readonly output: O;
}

export interface BridgeContract<I = JsonValue, O = JsonValue> {
	readonly examples: readonly BoundaryExample<I, O>[];
}

export interface BridgeOptions<I = JsonValue, O = JsonValue> {
	readonly session?: string;
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

export interface ShadowDiff<I = JsonValue> {
	readonly input: I;
	readonly served: JsonValue;
	readonly candidate: unknown;
	readonly matched: boolean;
	readonly order: number;
}

export interface FaultOptions {
	readonly message: string;
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
