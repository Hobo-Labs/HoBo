/**
 * Offline fixtures for the framework's own tests.
 *
 * The fixture pack is deliberately not one of the real packs: exercising the
 * mechanics against a synthetic pack keeps these tests from passing only because
 * the postgres pack happens to be shaped a certain way.
 */
import {
	type PackManifestInput,
	type PackSignature,
	type PackSignatureVerdict,
	type PackSignatureVerifier,
	packManifestPayloadDigest,
} from "../src/index.js";

export const FIXTURE_DIGEST_AMD64 =
	"sha256:1111111111111111111111111111111111111111111111111111111111111111";
export const FIXTURE_DIGEST_ARM64 =
	"sha256:2222222222222222222222222222222222222222222222222222222222222222";

export const TRUSTED_KEY_ID = "hobo-pack-signing-2026";

function unsignedFixture(): Omit<PackManifestInput, "signature"> {
	return {
		schemaVersion: "hobo.pack-manifest/v1",
		packId: "pack.example.oci/v1",
		packVersion: "1.0.0",
		displayName: "Example pack",
		description:
			"A synthetic pack used only to exercise the framework mechanics.",
		runtimeModels: ["oci", "vm_iaas"],
		implementsProfiles: [
			{
				profileId: "kv.key-value/v1",
				versionRange: ">=1",
				conformanceRef: "hobo.conformance/kv.key-value/v1#example@2026-08-08",
				conformance: "pass",
			},
		],
		images: [
			{
				architecture: "linux/amd64",
				reference: `registry.example.test/example/pack@${FIXTURE_DIGEST_AMD64}`,
			},
			{
				architecture: "linux/arm64",
				reference: `registry.example.test/example/pack@${FIXTURE_DIGEST_ARM64}`,
			},
		],
		ports: [
			{ name: "main", containerPort: 6379, protocol: "tcp", exposure: "camp" },
		],
		probes: {
			readiness: {
				kind: "exec",
				argv: ["/usr/local/bin/example", "ready"],
				initialDelayMs: 500,
				periodMs: 2000,
				timeoutMs: 1000,
				failureThreshold: 3,
			},
		},
		persistence: {
			requirement: "required",
			volumes: [
				{
					name: "data",
					mountPath: "/var/lib/example",
					minimumBytes: 1024 * 1024 * 256,
					accessMode: "single-writer",
					externalStorageAllowed: false,
				},
			],
		},
		resourceBounds: {
			cpuMillicoresMin: 250,
			memoryBytesMin: 256 * 1024 * 1024,
		},
		configSchema: [
			{
				key: "dataVolume",
				kind: "volume-name",
				necessity: "required",
				description: "Name of the declared volume that carries durable state.",
			},
			{
				key: "authPasswordRef",
				kind: "secret-ref",
				necessity: "required",
				description: "Locator for the credential minted in secret custody.",
			},
			{
				key: "maxMemoryBytes",
				kind: "integer",
				necessity: "optional",
				description: "Soft memory ceiling.",
				minimum: 1024 * 1024,
				defaultValue: 256 * 1024 * 1024,
			},
		],
		producesBindingProfiles: ["binding.redis-protocol/v1"],
		operations: [
			{
				id: "example.backup",
				kind: "backup",
				description: "Copy durable state out of the volume.",
				credentialDelivery: "environment",
				shell: false,
				argvBuilderRef: "buildExampleBackupArgv",
			},
		],
		ownership: "yard-owned",
		provenance: {
			builder: "example upstream publisher",
			buildType: "upstream-published",
			sourceRepository: "https://github.com/example/pack",
			sourceRevision: "0000000000000000000000000000000000000000",
			attestationRefs: [],
			sourceRefs: [
				{
					url: "https://example.test/docs",
					checkedAt: "2026-08-08",
					note: "Synthetic fixture source; no live claim is made.",
				},
			],
		},
		conformance: {
			suiteRef: "hobo.conformance/pack.example.oci/v1",
			outcome: "pass",
			evidenceCheckedAt: "2026-08-08",
			executedAgainstContainer: false,
		},
	};
}

/**
 * Build a fixture manifest whose signature covers its own canonical payload.
 * `mutate` runs before the digest is computed, so an overridden fixture is still
 * correctly signed unless a test deliberately breaks that.
 */
export function fixtureManifest(
	mutate: (
		draft: Omit<PackManifestInput, "signature">,
	) => Omit<PackManifestInput, "signature"> = (draft) => draft,
	signatureOverrides: Partial<PackSignature> = {},
): PackManifestInput {
	const unsigned = mutate(unsignedFixture());
	const signature: PackSignature = {
		algorithm: "ed25519",
		keyId: TRUSTED_KEY_ID,
		value: "ZmFrZS1zaWduYXR1cmU=",
		payloadDigest: packManifestPayloadDigest(unsigned),
		signedAt: "2026-08-08T00:00:00Z",
		...signatureOverrides,
	};
	return { ...unsigned, signature };
}

/** A verifier that returns a fixed verdict. No key material, no crypto. */
export function stubVerifier(
	verdict: PackSignatureVerdict = "valid",
): PackSignatureVerifier {
	return { verify: () => verdict };
}

export const FIXTURE_ANCHORS = {
	trustedKeyIds: [TRUSTED_KEY_ID],
	allowedRegistries: ["registry.example.test"],
} as const;
