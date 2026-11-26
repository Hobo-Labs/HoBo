import { verifyJwtWithJwks } from "@hobo/identity";

import { type BundleManifest, bundleManifestDigest } from "./ingest.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// Signature/provenance verification, reusing the
// @hobo/identity issuer/verify surface: a bundle attestation is a JWT signed
// by the identity issuer whose codeVersion.digest claim binds the canonical
// manifest digest, optionally accompanied by an SLSA-shaped in-toto provenance
// statement. Fail-closed and credential/key-gated: no verifier configured is
// an explicit "unverified" status — never a silent pass — and any signature,
// claim, or provenance mismatch is "failed".

// public-contract: in-toto statement envelope type accepted at parse time.
export const PROVENANCE_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";

// public-contract: SLSA provenance predicate type accepted at parse time.
export const SLSA_PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";

// Hex digest already parsed at the boundary; the proto message is its wire form.
// domain-view: parsed derived type of data-models ProvenanceSubject
export interface ProvenanceSubject {
	name: string;
	sha256: string;
}

// The proto message is its wire form.
// domain-view: parsed derived type of data-models ProvenancePredicate
export interface ProvenancePredicate {
	builderId: string;
	buildType: string;
}

// Only constructible through parseProvenanceStatement; wire field `_type`
// is the proto statement_type.
// domain-view: parsed derived type of data-models ProvenanceStatement
export interface ProvenanceStatement {
	statementType: typeof PROVENANCE_STATEMENT_TYPE;
	subject: readonly ProvenanceSubject[];
	predicateType: typeof SLSA_PROVENANCE_PREDICATE_TYPE;
	predicate: ProvenancePredicate;
}

export type ProvenanceParseErrorCode =
	| "not-an-object"
	| "unsupported-statement-type"
	| "unsupported-predicate-type"
	| "missing-subject"
	| "invalid-subject"
	| "invalid-predicate";

export interface ProvenanceParseError {
	code: ProvenanceParseErrorCode;
	message: string;
}

export type ProvenanceParseResult =
	| { ok: true; statement: ProvenanceStatement }
	| { ok: false; errors: ProvenanceParseError[] };

const SHA256_HEX = /^[0-9a-f]{64}$/;

// Parse an untrusted in-toto/SLSA provenance document (parse, don't validate):
// unsupported envelope or predicate types, malformed subjects, and builder-less
// predicates all reject — nothing partial survives.
export function parseProvenanceStatement(
	raw: JsonValue,
): ProvenanceParseResult {
	if (raw === null || !isJsonObject(raw) || Array.isArray(raw)) {
		return {
			ok: false,
			errors: [
				{
					code: "not-an-object",
					message: "provenance statement must be a JSON object",
				},
			],
		};
	}
	// SAFETY: `const record = raw as JsonObject;` is required at this I/O or test boundary.
	const record = raw as JsonObject;
	const errors: ProvenanceParseError[] = [];

	if (record._type !== PROVENANCE_STATEMENT_TYPE) {
		errors.push({
			code: "unsupported-statement-type",
			message: `_type must be ${PROVENANCE_STATEMENT_TYPE}`,
		});
	}
	if (record.predicateType !== SLSA_PROVENANCE_PREDICATE_TYPE) {
		errors.push({
			code: "unsupported-predicate-type",
			message: `predicateType must be ${SLSA_PROVENANCE_PREDICATE_TYPE}`,
		});
	}

	const subjects: ProvenanceSubject[] = [];
	if (!Array.isArray(record.subject) || record.subject.length === 0) {
		errors.push({
			code: "missing-subject",
			message: "subject must be a non-empty array",
		});
	} else {
		for (const [index, entry] of record.subject.entries()) {
			// SAFETY: `const subject = entry as {` is required at this I/O or test boundary.
			const subject = entry as {
				name?: JsonValue;
				digest?: { sha256?: unknown };
			} | null;
			const sha256 = subject?.digest?.sha256;
			if (
				!isJsonString(subject?.name) ||
				subject.name.length === 0 ||
				!isJsonString(sha256) ||
				!SHA256_HEX.test(sha256)
			) {
				errors.push({
					code: "invalid-subject",
					message: `subject[${index}] must carry a name and a sha256 hex digest`,
				});
				continue;
			}
			subjects.push({ name: subject.name, sha256 });
		}
	}

	// SAFETY: `const predicate = record.predicate as {` is required at this I/O or test boundary.
	const predicate = record.predicate as {
		builder?: { id?: unknown };
		buildType?: JsonValue;
	} | null;
	const builderId = predicate?.builder?.id;
	if (!isJsonString(builderId) || builderId.length === 0) {
		errors.push({
			code: "invalid-predicate",
			message: "predicate.builder.id must be a non-empty string",
		});
	}

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		statement: {
			statementType: PROVENANCE_STATEMENT_TYPE,
			subject: subjects,
			predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
			predicate: {
				// SAFETY: `builderId: builderId as string,` is required at this I/O or test boundary.
				builderId: builderId as string,
				buildType: isJsonString(predicate?.buildType)
					? predicate.buildType
					: "",
			},
		},
	};
}

// The credential/key gate: verification runs only against explicitly injected
// key material (a JWKS) plus the issuer/audience it was minted for. There is
// no ambient default.
export interface SignatureVerifier {
	jwks: Readonly<{ keys: JsonObject[] }>;
	issuer: string;
	audience: string;
	now: number;
}

export type VerificationResult =
	| { status: "verified"; manifestDigest: string; signedBy: string }
	| { status: "unverified"; reason: string }
	| { status: "failed"; reasons: string[] };

export interface VerifyBundleInput {
	manifest: BundleManifest;
	// Compact JWT minted by the identity issuer (JwtSvidIssuer.signJwtSvid)
	// whose codeVersion.digest claim carries the canonical manifest digest.
	attestation: string;
	// Optional SLSA-shaped provenance statement; when present its subject
	// digest must also bind the manifest.
	statement?: JsonValue;
	verifier?: SignatureVerifier;
}

// Verify a bundle's signature and provenance against its parsed manifest.
// Missing verifier => explicit "unverified" (never a pass); unverifiable
// signature, digest mismatch, or provenance mismatch => "failed".
export async function verifyBundleProvenance(
	input: VerifyBundleInput,
): Promise<VerificationResult> {
	if (input.verifier === undefined) {
		return {
			status: "unverified",
			reason: "no signature verifier configured (missing key material)",
		};
	}

	let claims: JsonObject;
	try {
		const verified = await verifyJwtWithJwks(
			input.attestation,
			{
				keys: [...input.verifier.jwks.keys],
			},
			{
				issuer: input.verifier.issuer,
				audience: input.verifier.audience,
				now: input.verifier.now,
			},
		);
		claims = verified.claims;
	} catch (error) {
		return {
			status: "failed",
			reasons: [
				`signature verification failed: ${error instanceof Error ? error.message : String(error)}`,
			],
		};
	}

	const manifestDigest = bundleManifestDigest(input.manifest);
	// SAFETY: `const codeVersion = claims.codeVersion as { digest?: unknown } | undefined;` is required at this I/O or test boundary.
	const codeVersion = claims.codeVersion as { digest?: unknown } | undefined;
	if (codeVersion?.digest !== manifestDigest) {
		return {
			status: "failed",
			reasons: ["attested digest does not match the canonical manifest digest"],
		};
	}

	if (input.statement !== undefined) {
		const parsed = parseProvenanceStatement(input.statement);
		if (!parsed.ok) {
			return {
				status: "failed",
				reasons: parsed.errors.map(
					(error) => `provenance statement: ${error.message}`,
				),
			};
		}
		const hex = manifestDigest.replace(/^sha256:/, "");
		const bound = parsed.statement.subject.some(
			(subject) => subject.sha256 === hex,
		);
		if (!bound) {
			return {
				status: "failed",
				reasons: ["provenance subject digest does not bind the manifest"],
			};
		}
	}

	const signedBy = isJsonString(claims.sub) ? claims.sub : "";
	return { status: "verified", manifestDigest, signedBy };
}
