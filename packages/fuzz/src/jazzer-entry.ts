import {
	fuzzBindleManifest,
	fuzzEventEnvelope,
	fuzzPolicyDocument,
} from "./harness.js";

export function fuzz(data: Buffer): void {
	fuzzBindleManifest(data);
	fuzzEventEnvelope(data);
	fuzzPolicyDocument(data);
}
