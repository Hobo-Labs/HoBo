import type {
	LaneReport as LaneReportWire,
	LoweringFixture as LoweringFixtureWire,
	SdkConformanceReport as SdkConformanceReportWire,
	SdkResilienceVector as SdkResilienceVectorWire,
	SemanticsAnnexVector as SemanticsAnnexVectorWire,
	VectorCaseResult as VectorCaseResultWire,
} from "../_generated/sdk_conformance_pb.js";
import type { JsonObject, JsonValue } from "../json.js";

export type AnnexCategory =
	| "error-mapping"
	| "cancellation"
	| "async-ordering"
	| "ifc-side-effects";

export type LaneStatus = "passed" | "failed";

export type Authorship = "hand-authored" | "generated";

export const SEMANTICS_ANNEX_SPEC_VERSION =
	"hobo.sdk.semantics-annex/v1" as const;

export interface WitResult<T> {
	ok?: T;
	err?: {
		tag: string;
		message?: string;
		deadlineMs?: number;
		retry?: string;
	};
}

export interface CancellationSignal {
	reason: string;
	deadlineMs?: number;
}

export interface CollectionFact {
	sequence: number;
	kind: "resource" | "handler";
	name?: string;
	resource?: string;
	event?: string;
}

export interface LoweredOutput {
	witCalls: readonly WitCall[];
	manifest: ManifestIr;
}

export interface WitCall {
	interface: string;
	function: string;
	args: JsonObject;
}

export interface ManifestIr {
	schema: "hobo.manifest/v1";
	bindle: string;
	resources: readonly { kind: string; name: string; allow?: JsonValue }[];
	handlers?: readonly {
		resource: string;
		event: string;
		exportName: string;
	}[];
}

export interface LowerProgram {
	bindle: string;
	resources: readonly { kind: string; name: string }[];
	handlers?: readonly {
		resource: string;
		event: string;
		exportName: string;
	}[];
}

export interface SdkIdiomAdapter {
	lower(program: LowerProgram): LoweredOutput;
	mapResult<T>(result: WitResult<T>): T;
	mapCancellation(signal: CancellationSignal): WitResult<never>;
	collect(facts: readonly CollectionFact[]): Promise<WitResult<string[]>>;
	exerciseResilience?(input: JsonValue): Promise<JsonValue> | JsonValue;
}

export type ResilienceVector = Readonly<
	Omit<SdkResilienceVectorWire, "$typeName" | "input" | "expected"> & {
		input: JsonValue;
		expected: JsonValue;
	}
>;

export type SemanticsAnnexVector = Readonly<
	Omit<
		SemanticsAnnexVectorWire,
		| "$typeName"
		| "category"
		| "specVersion"
		| "result"
		| "expectedThrow"
		| "signal"
		| "expected"
		| "facts"
	> & {
		category: AnnexCategory;
		specVersion: typeof SEMANTICS_ANNEX_SPEC_VERSION;
		result?: WitResult<JsonValue>;
		expectedThrow?: { name: string; tag: string };
		signal?: CancellationSignal;
		expected?: WitResult<JsonValue>;
		facts?: readonly CollectionFact[];
	}
>;

export type LoweringFixture = Readonly<
	Omit<
		LoweringFixtureWire,
		"$typeName" | "program" | "expectedWitCalls" | "expectedManifest"
	> & {
		program: LowerProgram;
		expectedWitCalls: readonly WitCall[];
		expectedManifest: ManifestIr;
	}
>;

export type VectorCaseResult = Readonly<
	Omit<VectorCaseResultWire, "$typeName" | "status" | "diffPaths"> & {
		status: LaneStatus;
		diffPaths?: readonly string[];
	}
>;

export type LaneReport = Readonly<
	Omit<LaneReportWire, "$typeName" | "status" | "cases"> & {
		status: LaneStatus;
		cases: readonly VectorCaseResult[];
	}
>;

export type SdkConformanceReport = Readonly<
	Omit<
		SdkConformanceReportWire,
		"$typeName" | "suite" | "contract" | "authorship" | "status" | "lanes"
	> & {
		suite: "@hobo/conformance/sdk";
		contract: "hobo:sdk@0.1.0";
		authorship: Authorship;
		status: LaneStatus;
		lanes: readonly LaneReport[];
	}
>;

export interface SourceFileScan {
	readonly path: string;
	readonly source: string;
}

export interface RunSdkIdiomConformanceOptions {
	readonly layerName?: string;
	readonly authorship?: Authorship;
	readonly corpus: readonly LoweringFixture[];
	readonly corpusPath?: string;
	readonly annexVectors: readonly SemanticsAnnexVector[];
	readonly resilienceVectors?: readonly ResilienceVector[];
	readonly annexPath?: string;
	readonly adapter: SdkIdiomAdapter;
	readonly helperClaims?: readonly string[];
	readonly sourceFiles?: readonly SourceFileScan[];
}
