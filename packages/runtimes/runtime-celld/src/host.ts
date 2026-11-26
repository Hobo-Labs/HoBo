import type { JsonValue } from "./json.js";
import {
	CELLD_ON_FLUX,
	type CelldCasProbe,
	type CelldRuntimeConfig,
	evaluateCelldBucketCas,
	parseCelldRuntimeConfig,
} from "./parse.js";

// domain-view: parse-don't-validate parsed/derived type; wire form is CelldDoctorReport in data-models/runtime_celld.proto.
export interface CelldDoctorReport {
	readonly overlayRequired: true;
	readonly overlayPresent: boolean;
	readonly operatorPortPrivate: true;
	readonly bucketCasProbed: boolean;
	readonly bucketCasOk: boolean;
	readonly hostileRejected: true;
	readonly fidelity: "config-only" | "cas-mocked";
	readonly celldOnFlux: typeof CELLD_ON_FLUX;
	readonly notes: readonly string[];
	readonly remediation: readonly string[];
}

export interface CelldRuntimeBundle {
	readonly kind: "celld";
	readonly config: CelldRuntimeConfig;
	readonly doctor: CelldDoctorReport;
	ensure(): { kind: "celld"; ready: true; placementMode: "celld" };
}

export function createCelldRuntimeHost(
	input: JsonValue,
	cas?: CelldCasProbe,
): CelldRuntimeBundle {
	const config = parseCelldRuntimeConfig(input);
	const bucketCasProbed = cas !== undefined;
	const bucketCasOk = cas !== undefined && evaluateCelldBucketCas(cas);
	const doctor: CelldDoctorReport = {
		overlayRequired: true,
		overlayPresent: true,
		operatorPortPrivate: true,
		bucketCasProbed,
		bucketCasOk,
		hostileRejected: true,
		fidelity: cas !== undefined ? "cas-mocked" : "config-only",
		celldOnFlux: CELLD_ON_FLUX,
		notes: [
			"celld is an experimental Durable Objects dialect.",
			"Not a HoBo WASM component host.",
			"celld-on-Flux is unsupported until overlay proofs exist.",
		],
		remediation: bucketCasOk
			? []
			: ["Provide a mocked or live CAS probe before claiming bucket fidelity."],
	};
	return {
		kind: "celld",
		config,
		doctor,
		ensure() {
			return { kind: "celld", ready: true, placementMode: "celld" };
		},
	};
}
