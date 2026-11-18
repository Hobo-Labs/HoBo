import type { JsonObject } from "@hobo/core";
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
