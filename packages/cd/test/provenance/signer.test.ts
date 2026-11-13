// npm provenance signing for HoBo's own releases: the statement npm's client
// builds, signed and bound to one tarball. Offline: the signer is a per-run
// Sigstore trust root (sigstore-fixture.ts), and the bundle it returns is
// verified end to end by HoBo's own ProvenanceVerifier.
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ArtifactKind, ArtifactRefSchema } from "../../src/_generated/cd_pb.js";
import {
	createProvenanceVerifier,
	githubActionsBuild,
	INTOTO_PAYLOAD_TYPE,
	npmPackagePurl,
	npmProvenanceStatement,
	ProvenanceSigningError,
	signNpmProvenance,
	type WorkflowRunBuild,
} from "../../src/provenance/index.js";
import {
	context,
	MemoryEventStore,
	ScriptedTransport,
	TENANT,
} from "../artifacts/fakes.js";
import {
	actionsAttestBundle,
	createTestTrustRoot,
	GITHUB_ISSUER,
} from "./sigstore-fixture.js";

const SIGNED_AT = Date.UTC(2026, 10, 12, 9, 30, 0);
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const TARBALL = new TextEncoder().encode("hobo-labs-core-0.1.0.tgz bytes");
const SHA256 = createHash("sha256").update(TARBALL).digest("hex");
const SHA512 = createHash("sha512").update(TARBALL).digest("hex");

const ENV = {
	GITHUB_SERVER_URL: "https://github.com",
	GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
	GITHUB_REPOSITORY_ID: "812345678",
	GITHUB_REPOSITORY_OWNER_ID: "98765432",
	GITHUB_WORKFLOW_REF:
		"Hobo-Labs/HoBo/.github/workflows/release-hobo.yml@refs/heads/main",
	GITHUB_REF: "refs/heads/main",
	GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
	GITHUB_EVENT_NAME: "push",
	GITHUB_RUN_ID: "42",
	GITHUB_RUN_ATTEMPT: "1",
	RUNNER_ENVIRONMENT: "github-hosted",
};
const WORKFLOW =
	"https://github.com/Hobo-Labs/HoBo/.github/workflows/release-hobo.yml@refs/heads/main";
const PKG = { name: "@hobo-labs/core", version: "0.1.0", tarball: TARBALL };

function testSigner(build: WorkflowRunBuild) {
	const root = createTestTrustRoot();
	const signed: Uint8Array[] = [];
	const signer = async (payload: Uint8Array, payloadType: string) => {
		expect(payloadType).toBe(INTOTO_PAYLOAD_TYPE);
		signed.push(payload);
		return actionsAttestBundle(root, {
			statement: Buffer.from(payload),
			signedAtMs: SIGNED_AT,
			san: `${build.serverUrl}/${build.workflowRef}`,
		});
	};
	return { root, signer, signed };
}

describe("npm provenance signing", () => {
	it("builds npm's GitHub Actions statement: scoped purl, sha512 and sha256 of the tarball, the run as builder", () => {
		const statement = npmProvenanceStatement(PKG, githubActionsBuild(ENV));
		expect(statement.subject).toEqual([
			{
				name: "pkg:npm/%40hobo-labs/core@0.1.0",
				digest: { sha512: SHA512, sha256: SHA256 },
			},
		]);
		expect(statement).toMatchObject({
			_type: "https://in-toto.io/Statement/v1",
			predicateType: "https://slsa.dev/provenance/v1",
			predicate: {
				buildDefinition: {
					buildType:
						"https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
					externalParameters: {
						workflow: {
							ref: "refs/heads/main",
							repository: "https://github.com/Hobo-Labs/HoBo",
							path: ".github/workflows/release-hobo.yml",
						},
					},
				},
				runDetails: {
					builder: { id: "https://github.com/actions/runner/github-hosted" },
					metadata: {
						invocationId:
							"https://github.com/Hobo-Labs/HoBo/actions/runs/42/attempts/1",
					},
				},
			},
		});
		expect(npmPackagePurl("left-pad", "1.0.0")).toBe("pkg:npm/left-pad@1.0.0");
	});

	it("refuses to sign outside a GitHub Actions run (fail closed)", () => {
		const { GITHUB_WORKFLOW_REF: _ref, ...partial } = ENV;
		expect(() => githubActionsBuild(partial)).toThrow(ProvenanceSigningError);
		expect(() =>
			githubActionsBuild({
				...ENV,
				GITHUB_WORKFLOW_REF: "someone/else/.github/workflows/x.yml@main",
			}),
		).toThrow(/does not name a workflow/u);
	});

	it("returns a bundle that HoBo's verifier accepts for the tarball, with its ProvenanceRef facts", async () => {
		const build = githubActionsBuild(ENV);
		const { root, signer, signed } = testSigner(build);
		const provenance = await signNpmProvenance(PKG, build, signer);
		expect(provenance).toMatchObject({
			predicateType: "https://slsa.dev/provenance/v1",
			builderId: "https://github.com/actions/runner/github-hosted",
			signerIdentity: WORKFLOW,
			issuer: GITHUB_ISSUER,
			subjectDigest: `sha256:${SHA256}`,
			statementDigest: `sha256:${createHash("sha256")
				.update(signed[0] ?? new Uint8Array())
				.digest("hex")}`,
		});
		const verifier = createProvenanceVerifier({
			store: new MemoryEventStore(),
			tenant: TENANT,
			now: () => NOW,
			http: new ScriptedTransport().http,
			trustPolicy: {
				sigstore: { trustedRoot: root.trustedRoot, issuers: [GITHUB_ISSUER] },
			},
		});
		const outcome = await verifier.verify(
			{
				statement: signed[0] ?? new Uint8Array(),
				bundle: provenance.bundle,
				subjects: [
					create(ArtifactRefSchema, {
						name: "@hobo-labs/core@0.1.0",
						kind: ArtifactKind.PACKAGE,
						digest: `sha256:${SHA256}`,
						coordinate: `store://filesystem/sha256:${SHA256}`,
						ecosystem: "store",
					}),
				],
				trustedBuilderIds: [provenance.builderId],
				trustedSignerIdentities: [WORKFLOW],
			},
			context(() => NOW),
		);
		expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
		if (outcome.ok)
			expect(outcome.value[0]).toMatchObject({
				verified: true,
				verifier: "sigstore",
				statementDigest: provenance.statementDigest,
				subjectDigests: [`sha256:${SHA256}`],
			});
	});

	it("refuses a bundle the signer made over another statement (nothing reaches the Freight)", async () => {
		const build = githubActionsBuild(ENV);
		const root = createTestTrustRoot();
		const other = Buffer.from(
			JSON.stringify(
				npmProvenanceStatement(
					{ ...PKG, tarball: new TextEncoder().encode("other bytes") },
					build,
				),
			),
		);
		await expect(
			signNpmProvenance(PKG, build, async () =>
				actionsAttestBundle(root, { statement: other, signedAtMs: SIGNED_AT }),
			),
		).rejects.toThrow(ProvenanceSigningError);
		await expect(
			signNpmProvenance(PKG, build, async () => ({ mediaType: "text/plain" })),
		).rejects.toThrow(ProvenanceSigningError);
	});
});
