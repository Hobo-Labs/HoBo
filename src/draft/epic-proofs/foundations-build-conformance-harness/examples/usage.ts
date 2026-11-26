/**
 * Runnable example for foundations-build-conformance-harness. The draft-artifact gate
 * EXECUTES this with `node --import tsx` and diffs stdout against usage.expected.txt.
 *
 * Runs the same reference simulation the cucumber steps drive
 * (services/foundations-reference-architecture.ts): workspace skeleton + boundary
 * lint, deterministic componentize, the artifact trust gate, and OIDC-gated CI lanes.
 */
import { strict as assert } from "node:assert";

import { runFoundationsBuildConformanceSimulation } from "../services/foundations-reference-architecture.ts";

const result = await runFoundationsBuildConformanceSimulation();
assert.equal(result.epic.slug, "foundations-build-conformance-harness");

// 1) Workspace skeleton validates; adapter boundary violations are denied.
assert.equal(result.workspace.packageManager, "pnpm");
assert.equal(result.workspace.status, "valid");
assert.equal(result.workspace.boundaryViolation.effect, "deny");
assert.equal(result.negative.adapterImport.effect, "deny");
assert.match(
	result.negative.adapterImport.reason,
	/adapters may import only core ports/,
);
console.log(
	`workspace status=${result.workspace.status} packageManager=${result.workspace.packageManager} boundaryViolation=${result.workspace.boundaryViolation.effect}`,
);
console.log(
	`adapter import lint effect=${result.negative.adapterImport.effect}`,
);

// 2) hello-bindle componentizes deterministically: wasm validates, OCI descriptor, smoke run.
const componentize = result.componentize;
assert.equal(componentize.validation.passed, true);
assert.equal(componentize.smoke.exitCode, 0);
assert.equal(
	componentize.oci.mediaType,
	"application/vnd.oci.image.manifest.v1+json",
);
console.log(
	`componentize wasmValid=${componentize.validation.passed} smokeExit=${componentize.smoke.exitCode} ociMediaType=${componentize.oci.mediaType}`,
);

// 3) Trust gate: signed artifacts verify and reach Matching without auto-selection;
//    unsigned artifacts are refused.
assert.equal(result.artifactTrust.install.ok, true);
assert.equal(result.artifactTrust.install.availableToMatching, true);
assert.equal(result.artifactTrust.install.selectedByMatching, false);
assert.deepEqual(result.negative.unsignedArtifact.reasons, [
	"signature.required",
]);
console.log(
	`trust gate installOk=${result.artifactTrust.install.ok} availableToMatching=${result.artifactTrust.install.availableToMatching} autoSelected=${result.artifactTrust.install.selectedByMatching}`,
);
console.log(
	`unsigned artifact refused reasons=${result.negative.unsignedArtifact.reasons.join(",")}`,
);

// 4) CI: contract lane passes; E2E runs on short-lived OIDC tokens; missing OIDC fails closed.
assert.equal(result.ci.contract.passed, true);
assert.equal(result.ci.e2e.status, "passed");
assert.equal(result.ci.e2e.token.expiresInSeconds, 900);
assert.equal(result.negative.ciMissingOidc.passed, false);
console.log(
	`ci contract=${result.ci.contract.passed} e2e=${result.ci.e2e.status} tokenTtl=${result.ci.e2e.token.expiresInSeconds}s missingOidcPasses=${result.negative.ciMissingOidc.passed}`,
);

console.log(
	"EPIC HELD: skeleton lint, deterministic builds, signed-artifact trust, and OIDC-gated CI all enforce",
);
