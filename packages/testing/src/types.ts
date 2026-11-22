import type {
	JsonObject,
	Messaging,
	Queue,
	SchedulerPort,
	VirtualClock,
} from "@hobo/core";
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
	ScheduleDriver,
	ServiceEmulatorFactories,
} from "./emulators.js";
import type { RunnerAdapter } from "./runner.js";

export const LANES: readonly string[] = Object.freeze([
	"in-process",
	"ephemeral-camp",
]);

export type Lane = "in-process" | "ephemeral-camp";
export type Fidelity = "real" | "simulated" | "mocked" | "camp-only";

export interface BindleResourceInput {
	readonly kind?: string;
	readonly dependsOn?: readonly string[];
}

export interface BindleEdgeInput {
	readonly from?: string;
	readonly to?: string;
}

export type BindleEntrypoint = (
	request: Request,
) => Response | Promise<Response>;

export interface BindleInput {
	readonly name?: string;
	readonly resources?: Readonly<Record<string, BindleResourceInput>>;
	readonly edges?: readonly BindleEdgeInput[];
	readonly requirements?: {
		readonly require?: readonly string[];
		readonly prefer?: readonly string[];
		readonly runtimes?: readonly string[];
		readonly labels?: Readonly<Record<string, string>>;
	};
	entrypoint?(alias: string): (() => BindleEntrypoint) | undefined;
}

export interface EphemeralCampYardInput {
	readonly name?: string;
	readonly providerId?: string;
}

export const DEFAULT_LANE: Lane = "in-process"; // public-contract: the lane authors get when none is declared
export const DEFAULT_STAGE = "test"; // public-contract: the stage authors get when none is declared

export interface TestHarnessOptions {
	readonly lane?: Lane;
	readonly stage?: string;
	readonly yard?: EphemeralCampYardInput;
	readonly campDriver?: EphemeralCampDriver;
	readonly runner?: RunnerAdapter;
	/** In-process overrides; each factory must return an isolated service. */
	readonly emulators?: ServiceEmulatorFactories;
}

export interface EphemeralCampDeployRequest {
	readonly bindle: BindleInput;
	readonly stage: string;
	readonly yardName: string;
	readonly providerId: string;
	readonly credentialRef: string;
}

export interface EphemeralCampResource {
	readonly alias: string;
	readonly kind: string;
	readonly endpoint?: string;
}

export interface EphemeralCampDeployResult {
	readonly resources: readonly EphemeralCampResource[];
	readonly outputs: JsonObject;
	destroy(): Promise<void>;
}

export interface EphemeralCampDriver {
	deploy(
		request: EphemeralCampDeployRequest,
	): Promise<EphemeralCampDeployResult>;
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
	outputs<T extends JsonObject = JsonObject>(): T;
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
	scheduleDriver(alias: string): ScheduleDriver | undefined;
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
	deploy(bindle: BindleInput): () => Promise<DeployedGraph>;
	destroy(bindle: BindleInput): () => Promise<void>;
	untilReady(
		target: string | ResourceHandle,
		options?: {
			readonly attempts?: number;
			readonly initialDelayMs?: number;
		},
	): Promise<{ readonly status: number }>;
}
