// WP3 provenance verifier: Sigstore bundles (sigstore@5.0.1), HoBo-signed
// attestations, builder and signer pins, exact subjects, fail-closed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { createInMemoryKms, JwtSvidIssuer } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import {
	ArtifactKind,
	type ArtifactRef,
	ArtifactRefSchema,
} from "../../src/_generated/cd_pb.js";
import {
	isJsonObject,
	type JsonObject,
	type JsonValue,
	parseJsonText,
} from "../../src/artifacts/json.js";
import {
	createProvenanceVerifier,
	PROVENANCE_REASON,
	ProvenanceTrustPolicyError,
	SIGSTORE_PUBLIC_GOOD_SEED,
} from "../../src/provenance/index.js";
import {
	context,
	MemoryEventStore,
	RecordingTelemetry,
	ScriptedTransport,
	TENANT,
} from "../artifacts/fakes.js";
import {
	actionsAttestBundle,
	actionsAttestStatement,
	createTestTrustRoot,
	GITHUB_BUILDER,
	GITHUB_ISSUER,
	RELEASE_WORKFLOW,
} from "./sigstore-fixture.js";

const here = dirname(fileURLToPath(import.meta.url));
const SIGNED_AT = Date.UTC(2026, 10, 1, 9, 30, 0);
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const WASM = createHash("sha256").update("api.wasm bytes").digest("hex");
const ASSETS = createHash("sha256").update("static assets bytes").digest("hex");

function ref(name: string, hex: string): ArtifactRef {
	return create(ArtifactRefSchema, {
		name,
		kind: ArtifactKind.WASM_COMPONENT,
		digest: `sha256:${hex}`,
		coordinate: `store://memory/sha256:${hex}`,
		ecosystem: "store",
	});
}

const WASM_REF = ref("api.wasm", WASM);
const ASSETS_REF = ref("assets.tar", ASSETS);
const SUBJECTS = [WASM_REF, ASSETS_REF];
const STATEMENT = actionsAttestStatement([
	{ name: "api.wasm", sha256: WASM },
	{ name: "assets.tar", sha256: ASSETS },
]);

function verifierWith(
	trustPolicy: JsonObject,
	telemetry = new RecordingTelemetry(),
) {
	return {
		telemetry,
		verifier: createProvenanceVerifier({
			store: new MemoryEventStore(),
			tenant: TENANT,
			now: () => NOW,
			http: new ScriptedTransport().http,
			trustPolicy,
			telemetry,
		}),
	};
}

const encodeText = (text: string) => new TextEncoder().encode(text);
const encode = (value: JsonValue) => encodeText(JSON.stringify(value));

function sigstoreSetup() {
	const root = createTestTrustRoot();
	const policy: JsonObject = {
		sigstore: { trustedRoot: root.trustedRoot, issuers: [GITHUB_ISSUER] },
	};
	return { root, policy, ...verifierWith(policy) };
}

const PINS = {
	trustedBuilderIds: [GITHUB_BUILDER],
	trustedSignerIdentities: [RELEASE_WORKFLOW],
};

async function code(
	promise: ReturnType<ReturnType<typeof createProvenanceVerifier>["verify"]>,
) {
	const outcome = await promise;
	return outcome.ok ? "ok" : outcome.reasons[0]?.code;
}

describe("Sigstore bundles", () => {
	it("A Sigstore bundle from a GitHub actions/attest fixture verifies", async () => {
		const { root, verifier, telemetry } = sigstoreSetup();
		const bundle = actionsAttestBundle(root, {
			statement: STATEMENT,
			signedAtMs: SIGNED_AT,
		});
		const outcome = await verifier.verify(
			{
				statement: STATEMENT,
				bundle: encode(bundle),
				subjects: SUBJECTS,
				...PINS,
			},
			context(() => NOW),
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const [provenance] = outcome.value;
		expect(provenance).toMatchObject({
			statementDigest: `sha256:${createHash("sha256").update(STATEMENT).digest("hex")}`,
			predicateType: "https://slsa.dev/provenance/v1",
			builderId: GITHUB_BUILDER,
			signerIdentity: RELEASE_WORKFLOW,
			issuer: GITHUB_ISSUER,
			verified: true,
			verifier: "sigstore",
			subjectDigests: [`sha256:${WASM}`, `sha256:${ASSETS}`].sort(),
		});
		expect(
			telemetry.count("hobo.cd.provenance.verify", { outcome: "verified" }),
		).toBe(1);
	});

	it("a tampered subject digest fails", async () => {
		const { root, verifier } = sigstoreSetup();
		const bundle = actionsAttestBundle(root, {
			statement: STATEMENT,
			signedAtMs: SIGNED_AT,
		});
		const tampered = Buffer.from(
			STATEMENT.toString("utf8").replace(WASM, "f".repeat(64)),
		);
		// The statement no longer is the signed payload.
		expect(
			await code(
				verifier.verify(
					{
						statement: tampered,
						bundle: encode(bundle),
						subjects: SUBJECTS,
						...PINS,
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.payloadMismatch);
		// Rewriting the envelope payload too breaks the DSSE signature.
		const forged = structuredClone(bundle);
		forged.dsseEnvelope.payload = tampered.toString("base64");
		expect(
			await code(
				verifier.verify(
					{
						statement: tampered,
						bundle: encode(forged),
						subjects: SUBJECTS,
						...PINS,
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.signatureInvalid);
		// An artifact whose digest the statement does not attest is refused.
		const swapped = [ref("api.wasm", "e".repeat(64)), ASSETS_REF];
		expect(
			await code(
				verifier.verify(
					{
						statement: STATEMENT,
						bundle: encode(bundle),
						subjects: swapped,
						...PINS,
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.subjectMismatch);
	});

	it("subjects must match the artifacts exactly, in both directions", async () => {
		const { root, verifier } = sigstoreSetup();
		const bundle = encode(
			actionsAttestBundle(root, {
				statement: STATEMENT,
				signedAtMs: SIGNED_AT,
			}),
		);
		expect(
			await code(
				verifier.verify(
					{
						statement: STATEMENT,
						bundle,
						subjects: [WASM_REF],
						...PINS,
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.subjectMismatch);
		expect(
			await code(
				verifier.verify(
					{
						statement: STATEMENT,
						bundle,
						subjects: [...SUBJECTS, ref("extra", "a".repeat(64))],
						...PINS,
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.subjectMismatch);
		expect(
			await code(
				verifier.verify(
					{ statement: STATEMENT, bundle, subjects: [], ...PINS },
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.subjectMismatch);
	});

	it("A wrong signer identity fails", async () => {
		const { root, verifier } = sigstoreSetup();
		const fork = actionsAttestBundle(root, {
			statement: STATEMENT,
			signedAtMs: SIGNED_AT,
			san: "https://github.com/mallory/api/.github/workflows/release.yml@refs/heads/main",
		});
		expect(
			await code(
				verifier.verify(
					{
						statement: STATEMENT,
						bundle: encode(fork),
						subjects: SUBJECTS,
						...PINS,
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.signerUntrusted);
		const otherIssuer = actionsAttestBundle(root, {
			statement: STATEMENT,
			signedAtMs: SIGNED_AT,
			issuer: "https://gitlab.example.com",
		});
		expect(
			await code(
				verifier.verify(
					{
						statement: STATEMENT,
						bundle: encode(otherIssuer),
						subjects: SUBJECTS,
						...PINS,
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.issuerUntrusted);
	});

	it("Builder and signer pins are enforced and never default to trust-all", async () => {
		const { root, verifier } = sigstoreSetup();
		const bundle = encode(
			actionsAttestBundle(root, {
				statement: STATEMENT,
				signedAtMs: SIGNED_AT,
			}),
		);
		const base = { statement: STATEMENT, bundle, subjects: SUBJECTS };
		expect(
			await code(
				verifier.verify(
					{
						...base,
						trustedBuilderIds: ["https://builder.example/other"],
						trustedSignerIdentities: [RELEASE_WORKFLOW],
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.builderUntrusted);
		expect(
			await code(
				verifier.verify(
					{
						...base,
						trustedBuilderIds: [],
						trustedSignerIdentities: [RELEASE_WORKFLOW],
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.builderUntrusted);
		expect(
			await code(
				verifier.verify(
					{
						...base,
						trustedBuilderIds: [GITHUB_BUILDER],
						trustedSignerIdentities: [],
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.signerUntrusted);
	});

	it("applies the trust policy's pins as defaults and as bounds", async () => {
		const root = createTestTrustRoot();
		const bundle = encode(
			actionsAttestBundle(root, {
				statement: STATEMENT,
				signedAtMs: SIGNED_AT,
			}),
		);
		const policy: JsonObject = {
			builderIds: [GITHUB_BUILDER],
			signerIdentities: [RELEASE_WORKFLOW],
			sigstore: { trustedRoot: root.trustedRoot, issuers: [GITHUB_ISSUER] },
		};
		const { verifier } = verifierWith(policy);
		const base = { statement: STATEMENT, bundle, subjects: SUBJECTS };
		expect(
			await code(
				verifier.verify(
					{ ...base, trustedBuilderIds: [], trustedSignerIdentities: [] },
					context(() => NOW),
				),
			),
		).toBe("ok");
		// A subscription pin that the policy does not also allow cannot widen trust.
		expect(
			await code(
				verifier.verify(
					{
						...base,
						trustedBuilderIds: [GITHUB_BUILDER],
						trustedSignerIdentities: [
							"https://github.com/acme/api/.github/workflows/other.yml@refs/heads/main",
						],
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.signerUntrusted);
	});

	it("refuses a bundle chained to a root the policy does not trust", async () => {
		const { verifier } = sigstoreSetup();
		const stranger = createTestTrustRoot();
		const bundle = encode(
			actionsAttestBundle(stranger, {
				statement: STATEMENT,
				signedAtMs: SIGNED_AT,
			}),
		);
		expect(
			await code(
				verifier.verify(
					{ statement: STATEMENT, bundle, subjects: SUBJECTS, ...PINS },
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.signatureInvalid);
	});

	it("refuses unsigned statements, junk bundles, and Sigstore without a configured root", async () => {
		const { root, verifier } = sigstoreSetup();
		expect(
			await code(
				verifier.verify(
					{ statement: STATEMENT, subjects: SUBJECTS, ...PINS },
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.unsigned);
		expect(
			await code(
				verifier.verify(
					{
						statement: STATEMENT,
						bundle: encodeText("not a bundle"),
						subjects: SUBJECTS,
						...PINS,
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.bundleInvalid);
		expect(
			await code(
				verifier.verify(
					{
						statement: STATEMENT,
						bundle: encode({
							mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
						}),
						subjects: SUBJECTS,
						...PINS,
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.bundleInvalid);
		const bare = verifierWith({}).verifier;
		const bundle = encode(
			actionsAttestBundle(root, {
				statement: STATEMENT,
				signedAtMs: SIGNED_AT,
			}),
		);
		expect(
			await code(
				bare.verify(
					{ statement: STATEMENT, bundle, subjects: SUBJECTS, ...PINS },
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.verifierUnconfigured);
	});

	it("verifies a real GitHub Actions bundle against the public-good root, then refuses its sha512-only statement", async () => {
		const bundleText = readFileSync(
			join(here, "fixtures", "npm-sigstore-5.0.1-slsa.sigstore.json"),
			"utf8",
		);
		const bundle: { dsseEnvelope: { payload: string } } =
			JSON.parse(bundleText);
		const statement = Buffer.from(bundle.dsseEnvelope.payload, "base64");
		const { verifier } = verifierWith({
			sigstore: {
				trustedRoot: SIGSTORE_PUBLIC_GOOD_SEED,
				issuers: [GITHUB_ISSUER],
			},
		});
		const signer =
			"https://github.com/sigstore/sigstore-js/.github/workflows/release.yml@refs/heads/main";
		// Signature, certificate chain, SCT, Rekor SET and inclusion proof all pass;
		// the statement then fails registry parsing: npm attests sha512 only.
		expect(
			await code(
				verifier.verify(
					{
						statement,
						bundle: encodeText(bundleText),
						subjects: SUBJECTS,
						trustedBuilderIds: [GITHUB_BUILDER],
						trustedSignerIdentities: [signer],
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.statementInvalid);
		expect(
			await code(
				verifier.verify(
					{
						statement,
						bundle: encodeText(bundleText),
						subjects: SUBJECTS,
						trustedBuilderIds: [GITHUB_BUILDER],
						trustedSignerIdentities: [RELEASE_WORKFLOW],
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.signerUntrusted);
	});
});

describe("HoBo-signed attestations", () => {
	async function issued(claims: {
		digest: string;
		exp?: number;
		sub?: string;
	}) {
		const kms = createInMemoryKms();
		kms.generateRsaKey("cd-attest-1");
		const issuer = new JwtSvidIssuer({
			issuerUrl: "https://identity.hobo.test",
			kms,
			activeKeyId: "cd-attest-1",
			jwksKeyIds: ["cd-attest-1"],
		});
		const nowSeconds = Math.floor(NOW / 1000);
		const token = await issuer.signJwtSvid({
			sub: claims.sub ?? "spiffe://acme/ci/release",
			aud: "hobo-cd",
			tenant: TENANT,
			parentPrincipal: { kind: "service", id: "hobo-ci" },
			codeVersion: { digest: claims.digest, version: "1.4.0" },
			scope: [],
			exp: claims.exp ?? nowSeconds + 600,
			nbf: nowSeconds - 10,
			iat: nowSeconds - 10,
		});
		const policy = parseJsonText(
			JSON.stringify({
				hoboJwt: {
					jwks: issuer.jwks(),
					issuer: "https://identity.hobo.test",
					audience: "hobo-cd",
				},
			}),
		);
		if (!isJsonObject(policy)) throw new Error("policy is a JSON object");
		return { token, policy };
	}

	const statementDigest = `sha256:${createHash("sha256").update(STATEMENT).digest("hex")}`;
	const JWT_PINS = {
		trustedBuilderIds: [GITHUB_BUILDER],
		trustedSignerIdentities: ["spiffe://acme/ci/release"],
	};

	it("verifies a JWT whose codeVersion.digest binds the statement", async () => {
		const { token, policy } = await issued({ digest: statementDigest });
		const outcome = await verifierWith(policy).verifier.verify(
			{
				statement: STATEMENT,
				bundle: encodeText(token),
				subjects: SUBJECTS,
				...JWT_PINS,
			},
			context(() => NOW),
		);
		expect(outcome.ok).toBe(true);
		if (outcome.ok)
			expect(outcome.value[0]).toMatchObject({
				verifier: "hobo-jwt",
				signerIdentity: "spiffe://acme/ci/release",
				issuer: "https://identity.hobo.test",
			});
	});

	it("refuses a JWT bound to another statement, an expired JWT, and an unpinned subject", async () => {
		const other = await issued({ digest: `sha256:${"0".repeat(64)}` });
		expect(
			await code(
				verifierWith(other.policy).verifier.verify(
					{
						statement: STATEMENT,
						bundle: encodeText(other.token),
						subjects: SUBJECTS,
						...JWT_PINS,
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.payloadMismatch);
		const expired = await issued({
			digest: statementDigest,
			exp: Math.floor(NOW / 1000) - 1,
		});
		expect(
			await code(
				verifierWith(expired.policy).verifier.verify(
					{
						statement: STATEMENT,
						bundle: encodeText(expired.token),
						subjects: SUBJECTS,
						...JWT_PINS,
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.signatureInvalid);
		const stranger = await issued({
			digest: statementDigest,
			sub: "spiffe://acme/ci/someone-else",
		});
		expect(
			await code(
				verifierWith(stranger.policy).verifier.verify(
					{
						statement: STATEMENT,
						bundle: encodeText(stranger.token),
						subjects: SUBJECTS,
						...JWT_PINS,
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.signerUntrusted);
	});

	it("refuses a JWT signed by a key outside the configured JWKS", async () => {
		const signer = await issued({ digest: statementDigest });
		const trusted = await issued({ digest: statementDigest });
		expect(
			await code(
				verifierWith(trusted.policy).verifier.verify(
					{
						statement: STATEMENT,
						bundle: encodeText(signer.token),
						subjects: SUBJECTS,
						...JWT_PINS,
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.signatureInvalid);
	});

	it("refuses a statement that is not SLSA provenance v1", async () => {
		const notSlsa = Buffer.from(
			JSON.stringify({
				_type: "https://in-toto.io/Statement/v1",
				subject: [{ name: "api.wasm", digest: { sha256: WASM } }],
				predicateType: "https://example.com/custom",
				predicate: {},
			}),
		);
		const { token, policy } = await issued({
			digest: `sha256:${createHash("sha256").update(notSlsa).digest("hex")}`,
		});
		expect(
			await code(
				verifierWith(policy).verifier.verify(
					{
						statement: notSlsa,
						bundle: encodeText(token),
						subjects: [WASM_REF],
						...JWT_PINS,
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.statementInvalid);
	});
});

describe("trust policy", () => {
	it("rejects malformed policies at construction with a typed error", () => {
		const bad: JsonObject[] = [
			{ sigstore: { trustedRoot: "anything", issuers: [GITHUB_ISSUER] } },
			{ sigstore: { trustedRoot: {}, issuers: [] } },
			{
				sigstore: {
					trustedRoot: SIGSTORE_PUBLIC_GOOD_SEED,
					issuers: [GITHUB_ISSUER],
					tlogThreshold: 0,
				},
			},
			{ hoboJwt: { jwks: { keys: [] }, issuer: "x", audience: "y" } },
			{ builderIds: "github" },
			{ trustEverything: true },
		];
		for (const policy of bad)
			expect(() => verifierWith(policy)).toThrow(ProvenanceTrustPolicyError);
	});

	it("an empty policy is valid and trusts nothing", async () => {
		const { verifier } = verifierWith({});
		expect(
			await code(
				verifier.verify(
					{
						statement: STATEMENT,
						bundle: encodeText("a.b.c"),
						subjects: SUBJECTS,
						...PINS,
					},
					context(() => NOW),
				),
			),
		).toBe(PROVENANCE_REASON.verifierUnconfigured);
	});
});
