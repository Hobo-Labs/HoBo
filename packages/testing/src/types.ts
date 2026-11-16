/**
 * The committed §1.6 harness contract (ADR-0159), verbatim.
 *
 * These shapes are the coordination mechanism between a Bindle author's suite
 * and the harness; they are not free to drift. Field names and string literals
 * are normative. Behaviour that cannot be expressed here — which lane refused,
 * why, and what to change — travels as a `TestHarnessError`, never as a
 * partially-populated record.
 */

import type { RunnerAdapter } from "./runner.js";

export const LANES: readonly string[] = Object.freeze([
	"in-process",
	"ephemeral-camp",
]);

export type Lane = "in-process" | "ephemeral-camp";
export type Fidelity = "real" | "simulated" | "mocked" | "camp-only";

export const DEFAULT_LANE: Lane = "in-process"; // public-contract: the lane authors get when none is declared
export const DEFAULT_STAGE = "test"; // public-contract: the stage authors get when none is declared

export interface TestHarnessOptions {
	readonly lane?: Lane;
	readonly stage?: string;
	readonly yard?: unknown;
	readonly runner?: RunnerAdapter;
}

export interface ResourceHandle {
	readonly alias: string;
	readonly kind: string;
	readonly fidelity: Fidelity;
	readonly endpoint?: string;
}

export interface FidelityReport {
	readonly byFidelity: Readonly<Record<Fidelity, number>>;
	readonly assertedAgainst: readonly {
		readonly alias: string;
		readonly fidelity: Fidelity;
	}[];
	/** true only when no assertion rested on a `mocked` handle. */
	readonly prodReadinessClaimable: boolean;
}

export interface DeployedGraph {
	readonly stage: string;
	readonly lane: Lane;
	outputs<T = Record<string, unknown>>(): T;
	resource(alias: string): ResourceHandle;
	http(alias: string): { readonly baseUrl: string };
	fidelity(): FidelityReport;
}

export interface TestHarness {
	deploy(bindle: unknown): () => Promise<DeployedGraph>;
	destroy(bindle: unknown): () => Promise<void>;
	untilReady(
		target: string | ResourceHandle,
		options?: {
			readonly attempts?: number;
			readonly initialDelayMs?: number;
		},
	): Promise<{ readonly status: number }>;
}
