import {
	isJsonBoolean,
	isJsonInteger,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import { validatePassedRecordConstraints } from "./record-constraints.js";
import type {
	CheckEvidence,
	CheckResult,
	CheckStatus,
	ComponentArtifact,
	RecordStatus,
	SignatureEvidence,
	StageGateRecord,
	StageGateRecordJson,
} from "./types.js";
import { StageGateParseError } from "./types.js";

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const HTTPS_RE = /^https:\/\//;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;
const CHECK_STATUS: readonly CheckStatus[] = [
	"passed",
	"failed",
	"skipped",
	"not_run",
];
const RECORD_STATUS: readonly RecordStatus[] = [
	"passed",
	"failed",
	"skipped",
	"not_run",
];

function memberOf<T extends string>(
	allowed: readonly T[],
	value: JsonValue | undefined,
): T | undefined {
	return allowed.find((entry) => entry === value);
}

/** Own field only: a key named like an Object.prototype member reads as absent. */
function fieldOf(raw: JsonObject, key: string): JsonValue | undefined {
	return Object.hasOwn(raw, key) ? raw[key] : undefined;
}

/** A field under its snake_case wire name, else its camelCase alias (null falls through, as `??` does). */
function wireField(
	raw: JsonObject,
	snake: string,
	camel: string,
): JsonValue | undefined {
	return fieldOf(raw, snake) ?? fieldOf(raw, camel);
}

function nonEmptyString(value: JsonValue | undefined): string | undefined {
	return isJsonString(value) && value.length > 0 ? value : undefined;
}

function parseCommand(
	raw: JsonValue | undefined,
	issues: string[],
	path: string,
): string[] {
	if (!Array.isArray(raw)) {
		// eli5: a non-array `command` is an error and yields no command words.
		issues.push(`${path}.command: expected array`);
		return [];
	}
	return raw.map((entry: JsonValue, index) => {
		if (isJsonString(entry)) return entry;
		issues.push(`${path}.command[${index}]: expected string`);
		return "";
	});
}

function parseEvidence(
	raw: JsonValue | undefined,
	issues: string[],
	path: string,
): CheckEvidence {
	const evidence: Record<string, string> = {};
	if (raw === undefined) return evidence;
	if (!isJsonObject(raw)) {
		issues.push(`${path}.evidence: expected object`);
		return evidence;
	}
	for (const [key, value] of Object.entries(raw)) {
		if (isJsonString(value)) {
			evidence[key] = value;
		} else {
			issues.push(`${path}.evidence.${key}: expected string`);
		}
	}
	return evidence;
}

function parseCheckResult(
	raw: JsonValue,
	issues: string[],
	path: string,
): CheckResult | null {
	if (!isJsonObject(raw)) {
		issues.push(`${path}: expected object`);
		return null;
	}
	const checkId = nonEmptyString(wireField(raw, "check_id", "checkId"));
	if (checkId === undefined) {
		issues.push(`${path}.check_id: required non-empty string`);
	}
	const command = parseCommand(fieldOf(raw, "command"), issues, path);
	const exitCode = wireField(raw, "exit_code", "exitCode");
	if (!isJsonInteger(exitCode)) {
		issues.push(`${path}.exit_code: expected integer`);
	}
	const status = memberOf(CHECK_STATUS, fieldOf(raw, "status"));
	if (status === undefined) {
		issues.push(`${path}.status: expected passed|failed|skipped|not_run`);
	}
	const evidence = parseEvidence(fieldOf(raw, "evidence"), issues, path);
	if (
		issues.length > 0 ||
		checkId === undefined ||
		!isJsonInteger(exitCode) ||
		status === undefined
	) {
		return null;
	}
	return { checkId, command, exitCode, status, evidence };
}

function parseComponentArtifact(
	raw: JsonValue | undefined,
	issues: string[],
	path: string,
): ComponentArtifact | null {
	if (!isJsonObject(raw)) {
		issues.push(`${path}: expected object`);
		return null;
	}
	const digest = wireField(raw, "digest_sha256", "digestSha256");
	const digestSha256 =
		isJsonString(digest) && DIGEST_RE.test(digest) ? digest : undefined;
	if (digestSha256 === undefined) {
		issues.push(`${path}.digest_sha256: expected sha256:<64 hex>`);
	}
	const length = wireField(raw, "byte_length", "byteLength");
	const byteLength = isJsonInteger(length) && length >= 0 ? length : undefined;
	if (byteLength === undefined) {
		issues.push(`${path}.byte_length: expected non-negative integer`);
	}
	const mediaType = nonEmptyString(wireField(raw, "media_type", "mediaType"));
	if (mediaType === undefined) {
		issues.push(`${path}.media_type: required non-empty string`);
	}
	if (
		issues.length > 0 ||
		digestSha256 === undefined ||
		byteLength === undefined ||
		mediaType === undefined
	) {
		return null;
	}
	return { digestSha256, byteLength, mediaType };
}

function parseConformanceDigest(
	raw: JsonValue | undefined,
	issues: string[],
	path: string,
): string {
	if (raw === undefined || raw === "") return "";
	if (isJsonString(raw) && DIGEST_RE.test(raw)) return raw;
	issues.push(`${path}.conformance_report_digest: invalid digest`);
	return "";
}

function parseSignatureEvidence(
	raw: JsonValue | undefined,
	issues: string[],
	path: string,
): SignatureEvidence | null {
	if (!isJsonObject(raw)) {
		issues.push(`${path}: expected object`);
		return null;
	}
	const verified = fieldOf(raw, "verified");
	if (!isJsonBoolean(verified)) {
		issues.push(`${path}.verified: expected boolean`);
	}
	const signerIdentity = wireField(raw, "signer_identity", "signerIdentity");
	if (!isJsonString(signerIdentity)) {
		issues.push(`${path}.signer_identity: expected string`);
	}
	const provenanceTier = wireField(raw, "provenance_tier", "provenanceTier");
	if (!isJsonString(provenanceTier)) {
		issues.push(`${path}.provenance_tier: expected string`);
	}
	const conformanceReportDigest = parseConformanceDigest(
		wireField(raw, "conformance_report_digest", "conformanceReportDigest"),
		issues,
		path,
	);
	if (
		issues.length > 0 ||
		!isJsonBoolean(verified) ||
		!isJsonString(signerIdentity) ||
		!isJsonString(provenanceTier)
	) {
		return null;
	}
	return { verified, signerIdentity, provenanceTier, conformanceReportDigest };
}

function isoTimestamp(
	raw: JsonObject,
	snake: string,
	camel: string,
	issues: string[],
): string | undefined {
	const value = wireField(raw, snake, camel);
	if (isJsonString(value) && ISO_RE.test(value)) return value;
	issues.push(`${snake}: expected ISO-8601 timestamp`);
	return undefined;
}

function parseCiRunUrl(raw: JsonObject, issues: string[]): string {
	const ciRunUrl = wireField(raw, "ci_run_url", "ciRunUrl") ?? "";
	if (!isJsonString(ciRunUrl)) {
		issues.push("ci_run_url: expected string");
		return "";
	}
	if (ciRunUrl.length > 0 && !HTTPS_RE.test(ciRunUrl)) {
		issues.push("ci_run_url: must start with https:// when set");
	}
	return ciRunUrl;
}

function parseChecks(raw: JsonObject, issues: string[]): CheckResult[] {
	const checksRaw = fieldOf(raw, "checks");
	const checks: CheckResult[] = [];
	if (!Array.isArray(checksRaw)) {
		issues.push("checks: expected array");
		return checks;
	}
	for (const [index, entry] of checksRaw.entries()) {
		const parsed = parseCheckResult(entry, issues, `checks[${index}]`);
		if (parsed) {
			checks.push(parsed);
		}
	}
	return checks;
}

const ZERO_ARTIFACT: ComponentArtifact = {
	digestSha256: `sha256:${"0".repeat(64)}`,
	byteLength: 0,
	mediaType: "application/octet-stream",
};

const UNSIGNED: SignatureEvidence = {
	verified: false,
	signerIdentity: "",
	provenanceTier: "",
	conformanceReportDigest: "",
};

export function parseStageGateRecord(raw: JsonValue): StageGateRecord {
	const issues: string[] = [];
	if (!isJsonObject(raw)) {
		throw new StageGateParseError(["record: expected object"]);
	}

	const gateId = nonEmptyString(wireField(raw, "gate_id", "gateId"));
	if (gateId === undefined) {
		issues.push("gate_id: required non-empty string");
	}
	const status = memberOf(RECORD_STATUS, fieldOf(raw, "status"));
	if (status === undefined) {
		issues.push("status: expected passed|failed|skipped|not_run");
	}
	const repoCommit = wireField(raw, "repo_commit", "repoCommit");
	if (!isJsonString(repoCommit)) {
		issues.push("repo_commit: expected string");
	}
	const ciRunUrl = parseCiRunUrl(raw, issues);
	const startedAt = isoTimestamp(raw, "started_at", "startedAt", issues);
	const finishedAt = isoTimestamp(raw, "finished_at", "finishedAt", issues);
	if (
		startedAt !== undefined &&
		finishedAt !== undefined &&
		startedAt >= finishedAt
	) {
		issues.push("finished_at must be >= started_at");
	}

	const checks = parseChecks(raw, issues);

	const artifactIssues: string[] = [];
	const artifact =
		parseComponentArtifact(
			fieldOf(raw, "artifact"),
			artifactIssues,
			"artifact",
		) ?? ZERO_ARTIFACT;
	issues.push(...artifactIssues);

	const signatureIssues: string[] = [];
	const signature =
		parseSignatureEvidence(
			fieldOf(raw, "signature"),
			signatureIssues,
			"signature",
		) ?? UNSIGNED;
	issues.push(...signatureIssues);

	if (
		issues.length > 0 ||
		gateId === undefined ||
		status === undefined ||
		!isJsonString(repoCommit) ||
		startedAt === undefined ||
		finishedAt === undefined
	) {
		throw new StageGateParseError(issues);
	}

	const record: StageGateRecord = {
		gateId,
		status,
		repoCommit,
		ciRunUrl,
		startedAt,
		finishedAt,
		checks,
		artifact,
		signature,
	};

	const passedIssues: string[] = [];
	validatePassedRecordConstraints(record, passedIssues);
	if (passedIssues.length > 0) {
		throw new StageGateParseError(passedIssues);
	}

	return record;
}

export function serializeStageGateRecord(
	record: StageGateRecord,
): StageGateRecordJson {
	return {
		gate_id: record.gateId,
		status: record.status,
		repo_commit: record.repoCommit,
		ci_run_url: record.ciRunUrl,
		started_at: record.startedAt,
		finished_at: record.finishedAt,
		checks: record.checks.map((check) => ({
			check_id: check.checkId,
			command: [...check.command],
			exit_code: check.exitCode,
			status: check.status,
			evidence: { ...check.evidence },
		})),
		artifact: {
			digest_sha256: record.artifact.digestSha256,
			byte_length: record.artifact.byteLength,
			media_type: record.artifact.mediaType,
		},
		signature: {
			verified: record.signature.verified,
			signer_identity: record.signature.signerIdentity,
			provenance_tier: record.signature.provenanceTier,
			conformance_report_digest: record.signature.conformanceReportDigest,
		},
	};
}
