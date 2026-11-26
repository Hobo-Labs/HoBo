import {
	buildHelloBindleComponent,
	emitEvidence,
} from "./hello-bindle-fixture.mts";

const build = await buildHelloBindleComponent();
const {
	createArtifactPayload,
	createFixtureSigningKey,
	createTrustBoundary,
	publishSignedArtifact,
	verifyInstallCandidate,
} = await import(
	"../../../src/draft/technical-proofs/signed-artifact-publish-install-contract/src/publish-install-contract.ts"
);

const signingKey = createFixtureSigningKey({
	keyId: "hobo-stage-gate-fixture",
	builderId: "https://hobo.dev/stage-gate/s0",
});
const trustBoundary = createTrustBoundary({
	trustedKeyIds: [signingKey.keyId],
	trustedBuilderIds: [signingKey.builderId],
	requiredConformanceSuites: ["toy-math-port"],
	allowedCoordinateScopes: ["hobo:examples/hello-bindle"],
	minimumProvenanceTier: "sandboxed-builder",
});
const artifact = createArtifactPayload({
	coordinate: "hobo:examples/hello-bindle",
	version: "0.1.0",
	mediaType: build.component.mediaType,
	bytes: build.component.bytes.toString("base64"),
});
const candidate = publishSignedArtifact({
	artifact,
	signingKey,
	conformanceReport: {
		suiteId: "toy-math-port",
		passed: true,
	},
	issuedAt: "2024-01-01T00:00:00.000Z",
	provenanceTier: "sandboxed-builder",
});
const verdict = verifyInstallCandidate({ candidate, trustBoundary });
if (!verdict.ok) {
	console.error(`verification failed: ${JSON.stringify(verdict.reasons)}`);
	process.exit(1);
}

emitEvidence({
	component_digest: build.component.digest,
	digest_sha256: build.component.digest,
	byte_length: String(build.component.bytes.length),
	media_type: build.component.mediaType,
	signature_verified: "true",
	signer_identity: signingKey.builderId,
	provenance_tier: "sandboxed-builder",
	conformance_report_digest: candidate.conformance.digest,
});
