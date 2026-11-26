import { createHash, createPublicKey, createVerify } from "node:crypto";
import type { CredentialAuditRow, CredentialGrantAudit } from "@hobo/cloud";
import type { EventEnvelope } from "@hobo/core";
import { must } from "@hobo/core/total-access";
import { JWT_ALGORITHM, type JwtSvidIssuer } from "@hobo/identity";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// OCSF evidence export for HoBo's audit facts (FR/attest, NFR-018, ADR-0046 §2).
// It maps the replayable `CredentialAuditRow` (grant -> use -> revoke, folded
// from the durable log) onto OCSF 1.x "Authorization" activity records, and the
// wider ADR-0046 §2 audit families (`policy.Decided`, `data.Classified`,
// `erasure.*`, `flag.Changed`, `registry.BundleImported`) onto OCSF
// "Authentication" and configuration-change records, so external GRC/SIEM tools
// can ingest HoBo's security timeline. The credential taxonomy codes below are
// the SAME as the src/draft OCSF-export contract proof (the source of truth):
// token facts are category 3 (Identity & Access Management), class 3004
// (Authorization); the proof's Authentication class is 3002.

export const OCSF_EXPORT_VERSION = "hobo.identity-ocsf-export/v1";

const OCSF_CATEGORY_UID = 3;
const OCSF_CATEGORY_NAME = "Identity & Access Management";
const OCSF_AUTHORIZATION_CLASS_UID = 3004;
const OCSF_AUTHORIZATION_CLASS_NAME = "Authorization";
const OCSF_AUTHENTICATION_CLASS_UID = 3002;
const OCSF_AUTHENTICATION_CLASS_NAME = "Authentication";
// ADR-0046 §2's "Configuration/Change" shorthand maps onto OCSF 1.1's
// config-state-change class in the Discovery category.
const OCSF_DISCOVERY_CATEGORY_UID = 5;
const OCSF_DISCOVERY_CATEGORY_NAME = "Discovery";
const OCSF_CONFIG_CHANGE_CLASS_UID = 5019;
const OCSF_CONFIG_CHANGE_CLASS_NAME = "Device Config State Change";

// activity_id per the draft OCSF_MAPPING: Granted=1, Used=2, Revoked=4.
const ACTIVITY_BY_STATUS = {
	granted: { id: 1, name: "Token Granted" },
	used: { id: 2, name: "Token Used" },
	revoked: { id: 4, name: "Token Revoked" },
} as const;

export interface OcsfCredentialChain {
	readonly grantId: string;
	readonly svidSubject?: string;
	readonly tokenRef?: string;
	readonly scope?: { port: string; resource: string; action: string };
	readonly grantedAt?: string;
	readonly usedAt?: string;
	readonly revokedAt?: string;
	readonly useCount: number;
}

export interface OcsfAuthorizationRecord {
	readonly schema_version: "ocsf-1.x";
	readonly category_uid: typeof OCSF_CATEGORY_UID;
	readonly category_name: typeof OCSF_CATEGORY_NAME;
	readonly class_uid: typeof OCSF_AUTHORIZATION_CLASS_UID;
	readonly class_name: typeof OCSF_AUTHORIZATION_CLASS_NAME;
	readonly activity_id: number;
	readonly activity_name: string;
	readonly type_uid: number;
	readonly severity_id: number;
	readonly status: string;
	readonly message: string;
	readonly metadata: {
		readonly version: string;
		readonly product: { readonly name: string; readonly vendor_name: string };
	};
	readonly hobo: {
		readonly export_kind: "credential-audit";
		readonly export_version: typeof OCSF_EXPORT_VERSION;
		readonly correlation_id: string;
		readonly credential_chain: OcsfCredentialChain;
	};
}

// One OCSF record per wider ADR-0046 §2 audit event, with per-line
// traceability back to the source event (id/type/seq/stream) and the exported
// payload passed through the crypto-shred redaction boundary.
export interface OcsfAuditEventRecord {
	readonly schema_version: "ocsf-1.x";
	readonly category_uid: number;
	readonly category_name: string;
	readonly class_uid: number;
	readonly class_name: string;
	readonly activity_id: number;
	readonly activity_name: string;
	readonly type_uid: number;
	readonly severity_id: number;
	readonly status: string;
	readonly message: string;
	readonly metadata: {
		readonly version: string;
		readonly product: { readonly name: string; readonly vendor_name: string };
	};
	readonly hobo: {
		readonly export_kind: "audit-event";
		readonly export_version: typeof OCSF_EXPORT_VERSION;
		readonly correlation_id: string;
		readonly source_event: {
			readonly id: string;
			readonly type: string;
			readonly seq: number;
			readonly stream_id: string;
			readonly ts: string;
			readonly tenant: string;
			readonly actor: unknown;
		};
		readonly data: JsonValue;
	};
}

export type OcsfExportRecord = OcsfAuthorizationRecord | OcsfAuditEventRecord;

// A verifiable signature envelope over the batch's `sealDigest`: the KMS key id,
// the JWS algorithm, and a compact JWS whose payload binds the digest.
export interface OcsfSealSignature {
	readonly kid: string;
	readonly alg: string;
	readonly jws: string;
}

export interface OcsfBatch {
	readonly export_version: typeof OCSF_EXPORT_VERSION;
	readonly correlationId: string;
	// Monotonic when the source timeline is ordered; otherwise labeled with a
	// reason (mirrors the draft contract's ordering guarantee).
	readonly ordering: {
		readonly mode: "ordered" | "unordered";
		readonly reason?: string;
	};
	readonly records: readonly OcsfExportRecord[];
	// A content digest over the canonical records — an integrity seal for the
	// export.
	readonly sealDigest: string;
	// Present only when a signer is configured: a KMS-backed JWS over the seal
	// digest (verify with `verifyOcsfBatchSignature` + the issuer's JWKS).
	readonly sealSignature?: OcsfSealSignature;
}

// A crypto-shredded subject is redacted to a stable, non-reversible ref so the
// evidence stays linkable (same subject -> same ref) without exposing the
// erased identifier (HOBO-295).
function redactSubject(subject: string): string {
	return `[erased:${createHash("sha256").update(subject).digest("hex").slice(0, 16)}]`;
}

// Deep-redact every erased-subject string in an exported payload — the export
// is a one-way boundary the erasure tombstone cannot reach (ADR-0046 §2), so
// no raw erased identifier may cross it, wherever it sits in the event data.
function redactDeep(
	value: JsonValue | undefined,
	erased: ReadonlySet<string>,
): JsonValue {
	if (isJsonString(value)) {
		return erased.has(value) ? redactSubject(value) : value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactDeep(item, erased));
	}
	if (value && isJsonObject(value)) {
		return Object.fromEntries(
			// SAFETY: assertion required at this I/O or test boundary.
			Object.entries(value as JsonObject).map(([key, item]) => [
				key,
				redactDeep(item, erased),
			]),
		);
	}
	return value ?? null;
}

function chainFor(
	grant: CredentialGrantAudit,
	erased: ReadonlySet<string>,
): OcsfCredentialChain {
	const svidSubject =
		grant.svidSubject !== undefined && erased.has(grant.svidSubject)
			? redactSubject(grant.svidSubject)
			: grant.svidSubject;
	return {
		grantId: grant.grantId,
		...(svidSubject !== undefined ? { svidSubject } : undefined),
		...(grant.tokenRef !== undefined
			? { tokenRef: grant.tokenRef }
			: undefined),
		...(grant.scope !== undefined ? { scope: grant.scope } : undefined),
		...(grant.grantedAt !== undefined
			? { grantedAt: grant.grantedAt }
			: undefined),
		...(grant.usedAt !== undefined ? { usedAt: grant.usedAt } : undefined),
		...(grant.revokedAt !== undefined
			? { revokedAt: grant.revokedAt }
			: undefined),
		useCount: grant.useCount,
	};
}

function recordFor(
	correlationId: string,
	grant: CredentialGrantAudit,
	erased: ReadonlySet<string>,
): OcsfAuthorizationRecord {
	const activity = ACTIVITY_BY_STATUS[grant.status];
	// A revoked grant is a benign, expected end-of-life (severity Informational=1).
	const severity_id = 1;
	return {
		schema_version: "ocsf-1.x",
		category_uid: OCSF_CATEGORY_UID,
		category_name: OCSF_CATEGORY_NAME,
		class_uid: OCSF_AUTHORIZATION_CLASS_UID,
		class_name: OCSF_AUTHORIZATION_CLASS_NAME,
		activity_id: activity.id,
		activity_name: activity.name,
		type_uid: OCSF_AUTHORIZATION_CLASS_UID * 100 + activity.id,
		severity_id,
		status: "Success",
		message: `credential ${grant.grantId} ${grant.status}`,
		metadata: {
			version: "1.0.0",
			product: { name: "HoBo Credential OCSF Export", vendor_name: "HoBo" },
		},
		hobo: {
			export_kind: "credential-audit",
			export_version: OCSF_EXPORT_VERSION,
			correlation_id: correlationId,
			credential_chain: chainFor(grant, erased),
		},
	};
}

// The ADR-0046 §2 audit-family taxonomy: `policy.Decided` is an Authentication
// access decision; classification, erasure lifecycle, flag changes, and bundle
// imports are configuration-change facts. Activity ids are HoBo's contract
// (same style as the draft proof's ACTIVITY table); type_uid = class*100+activity.
interface AuditClassMapping {
	readonly category_uid: number;
	readonly category_name: string;
	readonly class_uid: number;
	readonly class_name: string;
	readonly activity_id: number;
	readonly activity_name: string;
}

function authenticationMapping(
	activity_id: number,
	activity_name: string,
): AuditClassMapping {
	return {
		category_uid: OCSF_CATEGORY_UID,
		category_name: OCSF_CATEGORY_NAME,
		class_uid: OCSF_AUTHENTICATION_CLASS_UID,
		class_name: OCSF_AUTHENTICATION_CLASS_NAME,
		activity_id,
		activity_name,
	};
}

function configChangeMapping(
	activity_id: number,
	activity_name: string,
): AuditClassMapping {
	return {
		category_uid: OCSF_DISCOVERY_CATEGORY_UID,
		category_name: OCSF_DISCOVERY_CATEGORY_NAME,
		class_uid: OCSF_CONFIG_CHANGE_CLASS_UID,
		class_name: OCSF_CONFIG_CHANGE_CLASS_NAME,
		activity_id,
		activity_name,
	};
}

interface AuditEventMap {
	readonly [eventType: string]: AuditClassMapping | undefined;
}

const AUDIT_EVENT_MAPPING: AuditEventMap = {
	"policy.Decided": authenticationMapping(1, "Policy Decided"),
	"flag.Changed": configChangeMapping(1, "Flag Changed"),
	"registry.BundleImported": configChangeMapping(2, "Bundle Imported"),
	"data.Classified": configChangeMapping(3, "Data Classified"),
	"erasure.Requested": configChangeMapping(4, "Erasure Requested"),
	"erasure.Completed": configChangeMapping(5, "Erasure Completed"),
};

// Every `erasure.*` fact is exportable (the family is open-ended); other
// unmapped families are not part of the ADR-0046 §2 export surface.
function auditMappingFor(eventType: string): AuditClassMapping | undefined {
	const mapped = AUDIT_EVENT_MAPPING[eventType];
	if (mapped) return mapped;
	if (eventType.startsWith("erasure.")) {
		return configChangeMapping(6, "Erasure Progressed");
	}
	return undefined;
}

// `policy.Decided` carries its decision in `data.effect`; a deny is the only
// failed outcome — everything else (allow, obligations, approvals) succeeded.
function auditStatusFor(event: EventEnvelope): string {
	if (event.type === "policy.Decided") {
		// SAFETY: assertion required at this I/O or test boundary.
		const effect = (event.data as { effect?: unknown } | undefined)?.effect;
		return effect === "deny" ? "Failure" : "Success";
	}
	return "Success";
}

function auditRecordFor(
	event: EventEnvelope,
	mapping: AuditClassMapping,
	erased: ReadonlySet<string>,
): OcsfAuditEventRecord {
	return {
		schema_version: "ocsf-1.x",
		category_uid: mapping.category_uid,
		category_name: mapping.category_name,
		class_uid: mapping.class_uid,
		class_name: mapping.class_name,
		activity_id: mapping.activity_id,
		activity_name: mapping.activity_name,
		type_uid: mapping.class_uid * 100 + mapping.activity_id,
		severity_id: 1,
		status: auditStatusFor(event),
		// Message carries only the event type + id — never payload fields, so no
		// PII can leak through it.
		message: `${event.type} audit event ${event.id}`,
		metadata: {
			version: "1.0.0",
			product: { name: "HoBo Audit OCSF Export", vendor_name: "HoBo" },
		},
		hobo: {
			export_kind: "audit-event",
			export_version: OCSF_EXPORT_VERSION,
			correlation_id: event.correlationId ?? event.streamId,
			source_event: {
				id: event.id,
				type: event.type,
				seq: event.seq,
				stream_id: event.streamId,
				ts: event.ts,
				tenant: event.tenant,
				actor: redactDeep(cloneAsJson(event.actor), erased),
			},
			data: redactDeep(cloneAsJson(event.data), erased),
		},
	};
}

// Canonicalize + digest the records for a stable integrity seal. Sorting object
// keys makes the digest independent of property insertion order.
function sealFor(records: readonly OcsfExportRecord[]): string {
	const canonical = JSON.stringify(records, sortedReplacer());
	return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function sortedReplacer(): (
	key: string,
	value: JsonValue | undefined,
) => JsonValue {
	return (_key, value) => {
		if (value && isJsonObject(value) && !Array.isArray(value)) {
			return Object.fromEntries(
				// SAFETY: assertion required at this I/O or test boundary.
				Object.entries(value as JsonObject).sort(([a], [b]) =>
					a.localeCompare(b),
				),
			);
		}
		return value ?? null;
	};
}

export interface OcsfExportOptions {
	// Data subjects that have requested crypto-shred erasure (HOBO-295). Their
	// identifiers are redacted from the exported credential chains on rebuild,
	// without rewriting any historical event.
	readonly erasedSubjects?: ReadonlySet<string>;
	// Optional batch signer (reuses the identity plane's KMS-backed issuer).
	// When present, the batch carries a `sealSignature` JWS over the seal
	// digest; when absent, output is the existing digest-only shape.
	readonly signer?: JwtSvidIssuer;
}

// Sign the batch's seal digest with the issuer's active KMS key: a compact JWS
// (RS256) whose payload binds the digest + export version, so any SIEM holding
// the issuer's JWKS can verify the batch was produced by this identity plane.
function signSeal(
	signer: JwtSvidIssuer,
	sealDigest: string,
): OcsfSealSignature {
	const header = {
		alg: JWT_ALGORITHM,
		kid: signer.activeKeyId,
		typ: "JOSE",
	};
	const payload = { digest: sealDigest, export_version: OCSF_EXPORT_VERSION };
	const signingInput = `${toBase64UrlJson(header)}.${toBase64UrlJson(payload)}`;
	const signature = signer.kms.sign(signer.activeKeyId, signingInput);
	return {
		kid: signer.activeKeyId,
		alg: JWT_ALGORITHM,
		jws: `${signingInput}.${Buffer.from(signature).toString("base64url")}`,
	};
}

function toBase64UrlJson(value: JsonValue | undefined): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export interface OcsfSealVerification {
	readonly valid: boolean;
	readonly reason?: string;
}

// Verify a signed batch against a JWKS (e.g. `issuer.jwks()`): the seal digest
// must match the batch's records (tamper evidence), the JWS payload must bind
// that digest, and the RS256 signature must verify under the declared kid.
export function verifyOcsfBatchSignature(
	batch: OcsfBatch,
	jwks: Readonly<{ keys: JsonObject[] }>,
): OcsfSealVerification {
	const seal = batch.sealSignature;
	if (!seal) return { valid: false, reason: "unsigned" };
	const recomputed = sealFor(batch.records);
	if (recomputed !== batch.sealDigest) {
		return { valid: false, reason: "seal-digest-mismatch" };
	}
	const [encodedHeader, encodedPayload, encodedSignature] = seal.jws.split(".");
	if (!encodedHeader || !encodedPayload || !encodedSignature) {
		return { valid: false, reason: "malformed-jws" };
	}
	let header: JsonObject;
	let payload: JsonObject;
	try {
		header = JSON.parse(
			Buffer.from(encodedHeader, "base64url").toString("utf8"),
		);
		payload = JSON.parse(
			Buffer.from(encodedPayload, "base64url").toString("utf8"),
		);
	} catch {
		return { valid: false, reason: "malformed-jws" };
	}
	if (header.alg !== JWT_ALGORITHM || header.kid !== seal.kid) {
		return { valid: false, reason: "header-mismatch" };
	}
	if (payload.digest !== batch.sealDigest) {
		return { valid: false, reason: "signed-digest-mismatch" };
	}
	const key = jwks.keys.find((candidate) => candidate.kid === seal.kid);
	if (!key) return { valid: false, reason: "unknown-kid" };
	const verifier = createVerify("RSA-SHA256")
		.update(`${encodedHeader}.${encodedPayload}`)
		.end();
	const valid = verifier.verify(
		createPublicKey({ key, format: "jwk" }),
		Buffer.from(encodedSignature, "base64url"),
	);
	return valid ? { valid: true } : { valid: false, reason: "bad-signature" };
}

function assembleBatch(
	correlationId: string,
	ordering: OcsfBatch["ordering"],
	records: readonly OcsfExportRecord[],
	options: OcsfExportOptions,
): OcsfBatch {
	const sealDigest = sealFor(records);
	return {
		export_version: OCSF_EXPORT_VERSION,
		correlationId,
		ordering,
		records,
		sealDigest,
		...(options.signer !== undefined
			? { sealSignature: signSeal(options.signer, sealDigest) }
			: undefined),
	};
}

// Map a folded CredentialAuditRow to a signed-ready OCSF Authorization batch,
// one record per grant (its terminal lifecycle state), each carrying the full
// credential_chain. Ordering follows the row's timeline monotonicity. Erased
// subjects (from `options.erasedSubjects`) are redacted on rebuild.
export function credentialAuditToOcsf(
	row: CredentialAuditRow,
	options: OcsfExportOptions = {},
): OcsfBatch {
	const erased = options.erasedSubjects ?? new Set<string>();
	const grants = Object.values(row.grants).sort((a, b) =>
		a.grantId.localeCompare(b.grantId),
	);
	const records = grants.map((grant) =>
		recordFor(row.correlationId, grant, erased),
	);

	const ordering = orderingFor(row.timeline.map((entry) => entry.seq));
	return assembleBatch(row.correlationId, ordering, records, options);
}

function orderingFor(seqs: readonly number[]): OcsfBatch["ordering"] {
	for (let i = 1; i < seqs.length; i++) {
		if (must(seqs[i]) <= must(seqs[i - 1])) {
			return { mode: "unordered", reason: "non-monotonic-seq" };
		}
	}
	return { mode: "ordered" };
}

// Map the wider ADR-0046 §2 audit families (`policy.Decided`, `data.Classified`,
// `erasure.*`, `flag.Changed`, `registry.BundleImported`) onto OCSF
// Authentication / configuration-change records — one record per source event,
// with per-line traceability (`hobo.source_event`). Events outside the export
// surface are skipped, never guessed. Erased subjects are deep-redacted from
// every exported payload (the one-way PII boundary), and a configured signer
// yields the same `sealSignature` envelope as the credential export.
export function auditEventsToOcsf(
	events: readonly EventEnvelope[],
	options: OcsfExportOptions = {},
): OcsfBatch {
	const erased = options.erasedSubjects ?? new Set<string>();
	const exported: { event: EventEnvelope; record: OcsfAuditEventRecord }[] = [];
	for (const event of events) {
		const mapping = auditMappingFor(event.type);
		if (!mapping) continue;
		exported.push({ event, record: auditRecordFor(event, mapping, erased) });
	}
	const correlationId =
		exported[0]?.event.correlationId ??
		exported[0]?.event.streamId ??
		"audit-export";
	const ordering = orderingFor(exported.map(({ event }) => event.seq));
	return assembleBatch(
		correlationId,
		ordering,
		exported.map(({ record }) => record),
		options,
	);
}
