// `createProvenanceVerifier` (WP3, D3): in-toto/SLSA provenance, verified as
// a Sigstore bundle or as a HoBo-signed attestation, fail-closed throughout.
//
// Order of checks — each refuses on its own typed code:
//   1. a signature is present and well-formed            (unsigned / bundle-invalid)
//   2. the signature verifies over exactly the statement  (payload-mismatch / signature-invalid)
//   3. the signer and issuer are pinned                   (signer-untrusted / issuer-untrusted)
//   4. the statement parses (`@hobo/registry`)            (statement-invalid)
//   5. the builder is pinned                              (builder-untrusted)
//   6. statement subjects equal the artifacts exactly    (subject-mismatch)
//
// A pin list is satisfied only by an exact match. The caller's pins (from the
// subscription) and the trust policy's pins both apply when both are set; at
// least one must be set, so "no pins" never means "trust anyone".
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import type { HttpTransport } from "@hobo/core";
import {
	type ArtifactRef,
	type ProvenanceRef,
	ProvenanceRefSchema,
} from "../_generated/cd_pb.js";
import { parseDigest } from "../artifacts/digest.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonText,
} from "../artifacts/json.js";
import { ARTIFACT_METRICS, emit } from "../artifacts/telemetry.js";
import type {
	CdBase,
	CdContext,
	Outcome,
	ProvenanceVerifier,
	TelemetrySink,
} from "../ports.js";
import { isCompactJwt, verifyHoboJwt } from "./hobo-jwt.js";
import {
	PROVENANCE_REASON,
	type ProvenanceReasonCode,
	refuseProvenance,
} from "./reasons.js";
import {
	enforceSigstorePolicy,
	publicGoodSeedRoot,
	type SigstoreTrust,
	sigstoreTrust,
	verifySigstoreBundle,
} from "./sigstore.js";
import { parseStatement } from "./statement.js";
import {
	parseTrustPolicy,
	SIGSTORE_PUBLIC_GOOD_SEED,
	type TrustPolicy,
} from "./trust-policy.js";

export type ProvenanceVerifierDeps = CdBase & {
	/** Reserved: verification never fetches; trust material comes from the policy. */
	readonly http: HttpTransport;
	readonly trustPolicy: JsonObject;
	readonly telemetry?: TelemetrySink;
};

type Signed = Readonly<{
	verifier: "sigstore" | "hobo-jwt";
	signer: string;
	issuer: string;
	/** The parsed Sigstore bundle, kept to re-run sigstore's identity policy. */
	bundle?: JsonObject;
}>;

const decoder = new TextDecoder("utf-8", { fatal: true });

function decodeText(bytes: Uint8Array): string | undefined {
	try {
		return decoder.decode(bytes);
	} catch {
		return undefined;
	}
}

/** Every non-empty pin list must contain the value; at least one list must be non-empty. */
function pinned(
	value: string,
	...lists: readonly (readonly string[])[]
): boolean | "unpinned" {
	const active = lists.filter((list) => list.length > 0);
	if (active.length === 0) return "unpinned";
	return value !== "" && active.every((list) => list.includes(value));
}

export function createProvenanceVerifier(
	d: ProvenanceVerifierDeps,
): ProvenanceVerifier {
	const policy: TrustPolicy = parseTrustPolicy(d.trustPolicy);
	const sigstore = policy.sigstore;
	const trust: SigstoreTrust | undefined =
		sigstore === undefined
			? undefined
			: sigstoreTrust(
					sigstore.trustedRoot === SIGSTORE_PUBLIC_GOOD_SEED
						? publicGoodSeedRoot()
						: sigstore.trustedRoot,
					sigstore,
				);

	async function signature(
		bundleBytes: Uint8Array,
		statement: Uint8Array,
		statementDigest: string,
		ctx: CdContext,
	): Promise<Outcome<Signed>> {
		const text = decodeText(bundleBytes)?.trim();
		if (text === undefined || text === "")
			return refuseProvenance(
				PROVENANCE_REASON.bundleInvalid,
				"the bundle is not UTF-8 text",
			);
		if (isCompactJwt(text)) {
			if (policy.hoboJwt === undefined)
				return refuseProvenance(
					PROVENANCE_REASON.verifierUnconfigured,
					"a HoBo attestation JWT was sent but hoboJwt is not configured",
				);
			const result = await verifyHoboJwt(text, statementDigest, {
				...policy.hoboJwt,
				now: Math.floor(ctx.now() / 1000),
			});
			if (!result.ok)
				return result.stage === "payload"
					? refuseProvenance(
							PROVENANCE_REASON.payloadMismatch,
							`HoBo attestation: ${result.detail}`,
						)
					: refuseProvenance(
							PROVENANCE_REASON.signatureInvalid,
							`HoBo attestation: ${result.detail}`,
						);
			return {
				ok: true,
				value: {
					verifier: "hobo-jwt",
					signer: result.signer,
					issuer: result.issuer,
				},
			};
		}
		const bundle = parseJsonText(text);
		if (
			!isJsonObject(bundle) ||
			!isJsonString(bundle.mediaType) ||
			!bundle.mediaType.startsWith("application/vnd.dev.sigstore.bundle")
		)
			return refuseProvenance(
				PROVENANCE_REASON.bundleInvalid,
				"the bundle is neither a Sigstore bundle nor a compact JWT",
			);
		if (trust === undefined)
			return refuseProvenance(
				PROVENANCE_REASON.verifierUnconfigured,
				"a Sigstore bundle was sent but sigstore is not configured",
			);
		const result = verifySigstoreBundle(trust, bundle, statement);
		if (!result.ok) {
			const code: ProvenanceReasonCode =
				result.stage === "bundle"
					? PROVENANCE_REASON.bundleInvalid
					: result.stage === "payload"
						? PROVENANCE_REASON.payloadMismatch
						: PROVENANCE_REASON.signatureInvalid;
			return refuseProvenance(code, `sigstore: ${result.detail}`);
		}
		return {
			ok: true,
			value: {
				verifier: "sigstore",
				signer: result.subjectAlternativeName,
				issuer: result.issuer,
				bundle,
			},
		};
	}

	async function verify(
		input: Readonly<{
			statement: Uint8Array;
			bundle?: Uint8Array;
			subjects: readonly ArtifactRef[];
			trustedBuilderIds: readonly string[];
			trustedSignerIdentities: readonly string[];
		}>,
		ctx: CdContext,
	): Promise<Outcome<readonly ProvenanceRef[]>> {
		const statementDigest = `sha256:${createHash("sha256").update(input.statement).digest("hex")}`;
		if (input.bundle === undefined || input.bundle.byteLength === 0)
			return refuseProvenance(
				PROVENANCE_REASON.unsigned,
				"the statement carries no signature bundle",
			);

		const signed = await signature(
			input.bundle,
			input.statement,
			statementDigest,
			ctx,
		);
		if (!signed.ok) return signed;
		const { verifier, signer, issuer, bundle } = signed.value;

		const signerPinned = pinned(
			signer,
			input.trustedSignerIdentities,
			policy.signerIdentities,
		);
		if (signerPinned !== true)
			return refuseProvenance(
				PROVENANCE_REASON.signerUntrusted,
				signerPinned === "unpinned"
					? "no signer identity is pinned, so no signer can be trusted"
					: `signer ${signer || "(none)"} is not a pinned identity`,
			);
		if (verifier === "sigstore") {
			const issuers = policy.sigstore?.issuers ?? [];
			if (!issuers.includes(issuer))
				return refuseProvenance(
					PROVENANCE_REASON.issuerUntrusted,
					`certificate issuer ${issuer || "(none)"} is not trusted`,
				);
			if (
				trust === undefined ||
				bundle === undefined ||
				!enforceSigstorePolicy(trust, bundle, input.statement, {
					subjectAlternativeName: signer,
					issuer,
				})
			)
				return refuseProvenance(
					PROVENANCE_REASON.signerUntrusted,
					"sigstore identity policy rejected the signer",
				);
		}

		const parsed = parseStatement(input.statement);
		if (!parsed.ok)
			return refuseProvenance(
				PROVENANCE_REASON.statementInvalid,
				parsed.detail,
			);
		const statement = parsed.statement;

		const builderPinned = pinned(
			statement.predicate.builderId,
			input.trustedBuilderIds,
			policy.builderIds,
		);
		if (builderPinned !== true)
			return refuseProvenance(
				PROVENANCE_REASON.builderUntrusted,
				builderPinned === "unpinned"
					? "no builder id is pinned, so no builder can be trusted"
					: `builder ${statement.predicate.builderId} is not a pinned builder`,
			);

		const attested = new Set(
			statement.subject.map((subject) => `sha256:${subject.sha256}`),
		);
		const expected = new Set<string>();
		for (const subject of input.subjects) {
			const digest = parseDigest(subject.digest);
			if (digest === undefined)
				return refuseProvenance(
					PROVENANCE_REASON.subjectMismatch,
					"an artifact digest is not sha256",
					subject.name,
				);
			expected.add(digest);
		}
		const missing = [...expected].filter((digest) => !attested.has(digest));
		const extra = [...attested].filter((digest) => !expected.has(digest));
		if (missing.length > 0 || extra.length > 0 || expected.size === 0)
			return refuseProvenance(
				PROVENANCE_REASON.subjectMismatch,
				`statement subjects and artifacts differ (unattested: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`,
			);

		return {
			ok: true,
			value: [
				create(ProvenanceRefSchema, {
					statementDigest,
					predicateType: statement.predicateType,
					builderId: statement.predicate.builderId,
					signerIdentity: signer,
					issuer,
					verified: true,
					verifier,
					subjectDigests: [...attested].sort(),
				}),
			],
		};
	}

	return {
		async verify(input, ctx) {
			const outcome = await verify(input, ctx);
			emit(d.telemetry, ARTIFACT_METRICS.provenance, ctx.now(), {
				outcome: outcome.ok
					? "verified"
					: (outcome.reasons[0]?.code ?? "refused"),
			});
			return outcome;
		},
	};
}
