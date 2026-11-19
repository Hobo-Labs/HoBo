/**
 * The committed §1.6 harness contract (ADR-0159), verbatim.
 *
 * These shapes are the coordination mechanism between a Bindle author's suite
 * and the harness; they are not free to drift. Field names and string literals
 * are normative. Behaviour that cannot be expressed here — which lane refused,
 * why, and what to change — travels as a `TestHarnessError`, never as a
 * partially-populated record.
 */

import type { Messaging, Queue, SchedulerPort, VirtualClock } from "@hobo/core";
import type { EngineBinding } from "@hobo/data-core";
import type {
	DeliveryPort,
	ExperimentPort,
	FeatureFlagPort,
	SecretsPort,
} from "@hobo/identity";
import type {
	BlobStorePort,
	BucketInspector,
	FlagInspector,
	KeyValuePort,
	ServiceEmulatorFactories,
} from "./emulators.js";
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
	/** In-process overrides; each factory must return an isolated service. */
	readonly emulators?: ServiceEmulatorFactories;
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
	readonly prodReadinessClaimable: boolean;
}

export interface DeployedGraph {
	readonly stage: string;
	readonly lane: Lane;
	// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SAFETY: the legacy outputs contract is an open, caller-typed binding map.
	outputs<T = Record<string, unknown>>(): T;
	resource(alias: string): ResourceHandle;
	http(alias: string): { readonly baseUrl: string };
	queue(alias: string): Queue;
	/** The local queue's controllable clock, if the implementation provides one. */
	queueClock(alias: string): VirtualClock | undefined;
	topic(alias: string): Messaging;
	secret(alias: string): SecretsPort;
	/** The data engine SPI, not a remote database connection or SQL client. */
	data(alias: string): EngineBinding;
	schedule(alias: string): SchedulerPort;
	/** The schedule's controllable clock, if the implementation provides one. */
	scheduleClock(alias: string): VirtualClock | undefined;
	kv(alias: string): KeyValuePort;
	bucket(alias: string): BlobStorePort;
	flag(alias: string): FeatureFlagPort;
	rollout(alias: string): DeliveryPort;
	experiment(alias: string): ExperimentPort;
	/** Optional test-only access to local flag events. */
	flagInspector(alias: string): FlagInspector | undefined;
	/** Optional test-only access to stored object bodies. */
	bucketInspector(alias: string): BucketInspector | undefined;
	fidelity(): FidelityReport;
}

export interface TestHarness {
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: deploy parses collected Bindles at the package boundary.
	deploy(bindle: unknown): () => Promise<DeployedGraph>;
	// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: destroy accepts the same Bindle identity as deploy.
	destroy(bindle: unknown): () => Promise<void>;
	untilReady(
		target: string | ResourceHandle,
		options?: {
			readonly attempts?: number;
			readonly initialDelayMs?: number;
		},
	): Promise<{ readonly status: number }>;
}
