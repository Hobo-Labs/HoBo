// The `hobo.freight-manifest/v1` boundary (D2). Parse, don't validate: every
// manifest that reaches the ledger came through `parseFreightManifest`, which
// either returns a normalized FreightManifestRecord (subject defaulted,
// artifacts and provenance in canonical order) or a typed refusal. Any build
// system writes the same document with `writeFreightManifest`.
import { createHash } from "node:crypto";
import { clone, fromJson, isMessage, toJson } from "@bufbuild/protobuf";
import {
	type ArtifactRef,
	ArtifactKind,
	type FreightManifestRecord,
	FreightManifestRecordSchema,
	FreightSubject,
	type ReasonRecord,
} from "../_generated/cd_pb.js";
import { FREIGHT_MANIFEST_SCHEMA } from "../events.js";
import type { FreightId, Outcome } from "../ports.js";
import { freightAlias } from "./alias.js";
import { canonicalJson } from "./canonical.js";
import { isJsonObject, parseJsonText } from "./json.js";
import { FREIGHT_REASON, reason } from "./reasons.js";

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BINDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const LABEL_KEY_PATTERN = /^[a-z0-9]([a-z0-9._/-]{0,62}[a-z0-9])?$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;
const CONTROL_CHARS = /\p{Cc}/u;
// public-contract: artifact ecosystems a manifest may name (cd.proto ArtifactRef.ecosystem).
export const ARTIFACT_ECOSYSTEMS = Object.freeze([
	"oci",
	"npm",
	"nuget",
	"pypi",
	"maven",
	"cargo",
	"rubygems",
	"git",
	"http",
	"store",
] as const);
const ECOSYSTEMS: ReadonlySet<string> = new Set(ARTIFACT_ECOSYSTEMS);
const MAX_ARTIFACTS = 256;
const MAX_LABELS = 64;
const MAX_TEXT = 1024;
const MAX_MANIFEST_BYTES = 1_048_576;

// Credential shapes that must never enter a record (I9). Matching is a
// refusal, never a redaction: a record that held a secret cannot be repaired
// by the ledger, only by the publisher.
const SECRET_PATTERNS: readonly RegExp[] = [
	/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
	/\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
	/\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
	/\bglpat-[A-Za-z0-9_-]{20,}\b/,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
];

/** Thrown by `writeFreightManifest` for a manifest the parse boundary would refuse. */
export class FreightManifestError extends Error {
	readonly reasons: readonly ReasonRecord[];
	constructor(reasons: readonly ReasonRecord[]) {
		super(`invalid ${FREIGHT_MANIFEST_SCHEMA}: ${reasons.map((item) => `${item.subject}: ${item.message}`).join("; ")}`);
		this.name = "FreightManifestError";
		this.reasons = reasons;
	}
}

export type FreightManifestInput = FreightManifestRecord | Uint8Array | string;

const MANIFEST_REMEDIATION = `write the manifest with writeFreightManifest (${FREIGHT_MANIFEST_SCHEMA}) and resubmit`;

function invalid(subject: string, message: string): ReasonRecord {
	return reason(FREIGHT_REASON.manifestInvalid, message, MANIFEST_REMEDIATION, subject);
}

function secret(subject: string): ReasonRecord {
	return reason(
		FREIGHT_REASON.secretInRecord,
		`${subject} carries credential material; Freight records are secret-free`,
		"move the credential to a credentialRef resolved where the reconciler runs, rotate it, and resubmit",
		subject,
	);
}

function decode(text: string): Outcome<FreightManifestRecord> {
	if (text.length > MAX_MANIFEST_BYTES) {
		return { ok: false, reasons: [invalid("manifest", `manifest exceeds ${MAX_MANIFEST_BYTES} bytes`)] };
	}
	const json = parseJsonText(text);
	if (json === undefined) return { ok: false, reasons: [invalid("manifest", "manifest is not JSON")] };
	if (!isJsonObject(json)) return { ok: false, reasons: [invalid("manifest", "manifest must be a JSON object")] };
	try {
		return { ok: true, value: fromJson(FreightManifestRecordSchema, json) };
	} catch (error) {
		return { ok: false, reasons: [invalid("manifest", error instanceof Error ? error.message : "unreadable manifest")] };
	}
}

function checkText(subject: string, value: string, reasons: ReasonRecord[]): void {
	if (value.length > MAX_TEXT) reasons.push(invalid(subject, `${subject} exceeds ${MAX_TEXT} characters`));
	else if (CONTROL_CHARS.test(value)) reasons.push(invalid(subject, `${subject} contains control characters`));
	else if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) reasons.push(secret(subject));
}

function checkArtifact(item: ArtifactRef, index: number, seen: Set<string>, reasons: ReasonRecord[]): void {
	const at = `artifacts[${index}]`;
	if (item.name.trim() === "") reasons.push(invalid(`${at}.name`, "artifact name is required"));
	else if (seen.has(item.name)) reasons.push(invalid(`${at}.name`, `duplicate artifact name ${item.name}`));
	else if (!DIGEST_PATTERN.test(item.digest)) reasons.push(invalid(`${at}.digest`, "digest must be sha256:<64 lowercase hex>"));
	else if (item.kind === ArtifactKind.UNSPECIFIED || ArtifactKind[item.kind] === undefined) {
		reasons.push(invalid(`${at}.kind`, "artifact kind must be specified"));
	} else if (item.coordinate.trim() === "") reasons.push(invalid(`${at}.coordinate`, "artifact coordinate is required"));
	else if (item.ecosystem !== "" && !ECOSYSTEMS.has(item.ecosystem)) {
		reasons.push(invalid(`${at}.ecosystem`, `ecosystem must be one of ${ARTIFACT_ECOSYSTEMS.join(", ")}`));
	} else {
		checkText(`${at}.name`, item.name, reasons);
		checkText(`${at}.coordinate`, item.coordinate, reasons);
		checkText(`${at}.mediaType`, item.mediaType, reasons);
	}
	seen.add(item.name);
}

function check(manifest: FreightManifestRecord): ReasonRecord[] {
	const reasons: ReasonRecord[] = [];
	if (manifest.schemaVersion !== FREIGHT_MANIFEST_SCHEMA) {
		reasons.push(invalid("schemaVersion", `schemaVersion must be ${FREIGHT_MANIFEST_SCHEMA}`));
	}
	if (!BINDLE_PATTERN.test(manifest.bindle)) {
		reasons.push(invalid("bindle", "bindle must be 1-128 characters of [A-Za-z0-9._:@/-]"));
	}
	if (!DIGEST_PATTERN.test(manifest.declarationHash)) {
		reasons.push(invalid("declarationHash", "declarationHash must be sha256:<64 lowercase hex>"));
	}
	if (FreightSubject[manifest.subject] === undefined) reasons.push(invalid("subject", "unknown Freight subject"));
	if (manifest.subject === FreightSubject.RAIL && manifest.artifacts.length > 0) {
		reasons.push(invalid("artifacts", "RAIL Freight carries no artifacts (D24)"));
	}
	if (manifest.artifacts.length > MAX_ARTIFACTS) reasons.push(invalid("artifacts", `at most ${MAX_ARTIFACTS} artifacts`));
	const seen = new Set<string>();
	manifest.artifacts.forEach((item, index) => checkArtifact(item, index, seen, reasons));
	const source = manifest.source;
	if (source) {
		if (source.commit !== "" && !COMMIT_PATTERN.test(source.commit)) {
			reasons.push(invalid("source.commit", "commit must be 7-64 lowercase hex"));
		}
		for (const [field, value] of [
			["source.repository", source.repository],
			["source.ref", source.ref],
			["source.ciRunId", source.ciRunId],
			["source.ciSystem", source.ciSystem],
			["source.builderId", source.builderId],
		] as const) {
			checkText(field, value, reasons);
		}
	}
	manifest.provenance.forEach((ref, index) => {
		const at = `provenance[${index}]`;
		if (!DIGEST_PATTERN.test(ref.statementDigest)) reasons.push(invalid(`${at}.statementDigest`, "statementDigest must be sha256"));
		if (ref.subjectDigests.some((digest) => !DIGEST_PATTERN.test(digest))) {
			reasons.push(invalid(`${at}.subjectDigests`, "subject digests must be sha256"));
		}
		if (!["", "sigstore", "hobo-jwt"].includes(ref.verifier)) reasons.push(invalid(`${at}.verifier`, "verifier is sigstore or hobo-jwt"));
		checkText(`${at}.builderId`, ref.builderId, reasons);
		checkText(`${at}.signerIdentity`, ref.signerIdentity, reasons);
	});
	const labels = Object.entries(manifest.labels);
	if (labels.length > MAX_LABELS) reasons.push(invalid("labels", `at most ${MAX_LABELS} labels`));
	for (const [key, value] of labels) {
		if (!LABEL_KEY_PATTERN.test(key)) reasons.push(invalid(`labels.${key}`, "label keys are lowercase [a-z0-9._/-]"));
		else checkText(`labels.${key}`, value, reasons);
	}
	return reasons;
}

function byKey<T>(key: (item: T) => string): (a: T, b: T) => number {
	return (a, b) => {
		const left = key(a);
		const right = key(b);
		return left < right ? -1 : left > right ? 1 : 0;
	};
}

/** Normalized copy: subject defaulted to BINDLE, artifacts by name, provenance by statement digest. */
function normalize(manifest: FreightManifestRecord): FreightManifestRecord {
	const copy = clone(FreightManifestRecordSchema, manifest);
	if (copy.subject === FreightSubject.UNSPECIFIED) copy.subject = FreightSubject.BINDLE;
	copy.artifacts.sort(byKey((item) => item.name));
	copy.provenance.sort(byKey((ref) => `${ref.statementDigest}|${ref.builderId}|${ref.verifier}`));
	for (const ref of copy.provenance) ref.subjectDigests.sort();
	return copy;
}

function checked(manifest: FreightManifestRecord): Outcome<FreightManifestRecord> {
	const reasons = check(manifest);
	return reasons.length > 0 ? { ok: false, reasons } : { ok: true, value: normalize(manifest) };
}

/** Parse an untrusted manifest (bytes, JSON text, or a record) into the canonical form, or refuse. */
export function parseFreightManifest(input: FreightManifestInput): Outcome<FreightManifestRecord> {
	if (isMessage(input, FreightManifestRecordSchema)) return checked(input);
	const decoded = decode(input instanceof Uint8Array ? new TextDecoder().decode(input) : input);
	return decoded.ok ? checked(decoded.value) : decoded;
}

/** The canonical `hobo.freight-manifest/v1` document (sorted keys, no whitespace). */
export function writeFreightManifest(manifest: FreightManifestRecord): Uint8Array {
	const parsed = parseFreightManifest(manifest);
	if (!parsed.ok) throw new FreightManifestError(parsed.reasons);
	return new TextEncoder().encode(canonicalJson(toJson(FreightManifestRecordSchema, parsed.value)));
}

/**
 * Freight id and alias. The id covers what makes Freight *the same bytes for
 * the same declaration*: schema, subject, Bindle, declaration hash, and each
 * artifact's name, kind and digest. Coordinates, labels, source and provenance
 * are recorded metadata, so the same build reached through any ingress path
 * (or a digest-preserving mirror) is one Freight.
 */
export function freightIdentity(manifest: FreightManifestRecord): Readonly<{ freightId: FreightId; alias: string }> {
	const identity = {
		schemaVersion: manifest.schemaVersion,
		subject: FreightSubject[manifest.subject === FreightSubject.UNSPECIFIED ? FreightSubject.BINDLE : manifest.subject],
		bindle: manifest.bindle,
		declarationHash: manifest.declarationHash,
		artifacts: [...manifest.artifacts]
			.sort(byKey((item) => item.name))
			.map((item) => ({ name: item.name, kind: ArtifactKind[item.kind] ?? "", digest: item.digest })),
	};
	const hex = createHash("sha256").update(canonicalJson(identity)).digest("hex");
	// SAFETY: the brand is minted here, from a sha256 over the canonical identity.
	const freightId = `sha256:${hex}` as FreightId;
	return Object.freeze({ freightId, alias: freightAlias(freightId) });
}

