/**
 * Coverage-guided entry used by `npx jazzer packages/fuzz/src/jazzer-entry.ts`
 * when `@jazzer.js/core` is installed. PR smoke imports the named harnesses
 * directly and does not start a long Jazzer campaign.
 */
import {
	fuzzBindleManifest,
	fuzzEventEnvelope,
	fuzzPolicyDocument,
} from "./harness.js";

export default function fuzz(data: Buffer): void {
	fuzzBindleManifest(data);
	fuzzEventEnvelope(data);
	fuzzPolicyDocument(data);
}
