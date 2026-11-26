/**
 * Parsing `create-db` output.
 *
 * Two modes, and the difference between them is the point:
 *
 * - `json` — the pinned CLI's `--json` flag prints exactly one
 *   `JSON.stringify(DatabaseResult | DatabaseError, null, 2)` document. That is
 *   a real machine contract and it is what this package uses.
 * - `human-v1` — a *narrow*, versioned reader for the pretty output, for hosts
 *   stuck on a CLI without `--json`. It requires the exact documented labels
 *   and refuses anything else. It does not go looking for a URI somewhere in
 *   the text: heuristic scraping is how a parser keeps "working" after the
 *   format changes, and a provisioning parser that keeps working while being
 *   wrong is worse than one that stops.
 *
 * Verified against https://docs.prisma.io/docs/postgres/npx-create-db and the
 * published `create-db@1.2.1` type declarations (both checked 2026-08-08).
 */
import { PrismaProviderError, redactProviderText } from "./errors.js";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import {
	assertAllowedProviderUrl,
	DEFAULT_CLAIM_URL_POLICY,
	PRISMA_CLAIM_HOSTS,
} from "./urls.js";

export const CREATE_DB_OUTPUT_MODES = ["json", "human-v1"] as const;

export type CreateDbOutputMode = (typeof CREATE_DB_OUTPUT_MODES)[number];

/**
 * The CLI's success document. `deletionDate` is computed by the CLI from its
 * own clock (`Date.now() + ttl`), not returned by the service — see
 * {@link PrismaCreateResult.expirySource}.
 */
export type PrismaCreateResult = {
	readonly connectionString: string | null;
	readonly claimUrl: string;
	readonly deletionDateIso: string;
	readonly deletionDateMs: number;
	readonly region: string;
	readonly name: string;
	readonly projectId: string;
	readonly expirySource: "cli-local-clock";
	readonly outputMode: CreateDbOutputMode;
};

const PROJECT_ID = /^proj_[A-Za-z0-9_-]{1,120}$/u;
const REGION = /^[a-z]{2}-[a-z]+-\d$/u;
const NAME = /^[\x20-\x7e]{1,128}$/u;

function contractError(
	message: string,
	detail?: { preview?: string; field?: string },
): never {
	throw new PrismaProviderError("PROVIDER_CONTRACT_CHANGED", message, {
		...(detail !== undefined ? { detail } : undefined),
	});
}

export type PrismaCliFailure = {
	readonly error: string;
	readonly message: string;
	readonly status?: number;
	readonly retryAfterMs?: number;
};

/** Map the CLI's own error taxonomy onto HoBo codes. */
export function providerErrorForCliFailure(
	failure: PrismaCliFailure,
): PrismaProviderError {
	const detail = {
		error: failure.error,
		...(failure.status !== undefined ? { status: failure.status } : undefined),
	};
	const message = `create-db failed: ${redactProviderText(failure.message, 160)}`;
	if (failure.error.toLowerCase() === "rate_limit_exceeded") {
		return new PrismaProviderError("PROVIDER_RATE_LIMITED", message, {
			retryable: true,
			...(failure.retryAfterMs !== undefined
				? { retryAfterMs: failure.retryAfterMs }
				: undefined),
			detail,
		});
	}
	if (failure.status === 401 || failure.status === 403) {
		return new PrismaProviderError("PROVIDER_AUTH_FAILED", message, { detail });
	}
	if (failure.status === 409) {
		return new PrismaProviderError("PROVISIONING_CONFLICT", message, {
			detail,
		});
	}
	if (failure.status !== undefined && failure.status >= 500) {
		// The CLI reached the service and got a 5xx; it may or may not have
		// created a project before failing.
		return new PrismaProviderError("PROVIDER_OPERATION_AMBIGUOUS", message, {
			detail,
		});
	}
	if (failure.error === "invalid_json") {
		return new PrismaProviderError("PROVIDER_CONTRACT_CHANGED", message, {
			detail,
		});
	}
	return new PrismaProviderError("PROVIDER_CONTRACT_CHANGED", message, {
		detail,
	});
}

function finishResult(
	fields: {
		readonly connectionString: string | null;
		readonly claimUrl: string;
		readonly deletionDate: string;
		readonly region: string;
		readonly name: string;
		readonly projectId: string;
	},
	outputMode: CreateDbOutputMode,
): PrismaCreateResult {
	if (!PROJECT_ID.test(fields.projectId)) {
		contractError(
			"create-db returned a project id that is not a `proj_…` identifier",
		);
	}
	if (!REGION.test(fields.region)) {
		contractError("create-db returned an unrecognised region identifier");
	}
	if (!NAME.test(fields.name)) {
		contractError(
			"create-db returned a database name outside the printable ASCII bound",
		);
	}
	const deletionDateMs = Date.parse(fields.deletionDate);
	if (!Number.isFinite(deletionDateMs)) {
		contractError(
			"create-db returned a deletion date that is not an ISO 8601 instant",
		);
	}
	if (
		fields.connectionString !== null &&
		fields.connectionString.length > 2048
	) {
		contractError(
			"create-db returned a connection string over the 2048 byte cap",
		);
	}
	const claimUrl = assertAllowedProviderUrl(
		fields.claimUrl,
		DEFAULT_CLAIM_URL_POLICY,
	);
	if (!claimUrl.searchParams.get("projectID")) {
		contractError("create-db claim URL carries no projectID");
	}
	return {
		connectionString: fields.connectionString,
		claimUrl: claimUrl.toString(),
		deletionDateIso: new Date(deletionDateMs).toISOString(),
		deletionDateMs,
		region: fields.region,
		name: fields.name,
		projectId: fields.projectId,
		// Honest labelling: the pinned CLI derives this from its own clock.
		expirySource: "cli-local-clock",
		outputMode,
	};
}

/** Parse the `--json` document. Exactly one JSON value, nothing else. */
function requireRecordString(record: JsonObject, key: string): string {
	const value = record[key];
	if (!isJsonString(value) || value.length === 0) {
		contractError(`create-db JSON mode is missing the string field \`${key}\``);
	}
	return value;
}

export function parseCreateDbJson(stdout: string): PrismaCreateResult {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) {
		contractError("create-db produced no output in JSON mode");
	}
	let decoded: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		decoded = JSON.parse(trimmed) as JsonValue;
	} catch {
		contractError("create-db JSON mode did not emit a single JSON document", {
			preview: redactProviderText(trimmed, 80),
		});
	}
	if (!isJsonObject(decoded)) {
		contractError("create-db JSON mode did not emit an object");
	}
	const record = decoded;

	if (record.success === false) {
		const rateLimitInfo = isJsonObject(record.rateLimitInfo)
			? record.rateLimitInfo
			: undefined;
		const retryAfterMs = isJsonNumber(rateLimitInfo?.retryAfterMs)
			? rateLimitInfo.retryAfterMs
			: undefined;
		throw providerErrorForCliFailure({
			error: isJsonString(record.error) ? record.error : "unknown",
			message: isJsonString(record.message)
				? record.message
				: "unknown failure",
			...(isJsonNumber(record.status) ? { status: record.status } : undefined),
			...(retryAfterMs !== undefined ? { retryAfterMs } : undefined),
		});
	}
	if (record.success !== true) {
		contractError(
			"create-db JSON mode emitted a document with no boolean `success` field",
		);
	}

	const claimUrl = requireRecordString(record, "claimUrl");
	const deletionDate = requireRecordString(record, "deletionDate");
	const region = requireRecordString(record, "region");
	const name = requireRecordString(record, "name");
	const projectId = requireRecordString(record, "projectId");
	// Nullable by contract when the CLI is asked not to print it, so absence
	// and null are different: absence is a renamed field.
	if (!("connectionString" in record)) {
		contractError(
			"create-db JSON mode is missing the field `connectionString`",
		);
	}
	const connectionString = record.connectionString;
	if (connectionString !== null && !isJsonString(connectionString)) {
		contractError("create-db `connectionString` is neither a string nor null");
	}

	return finishResult(
		{
			connectionString: isJsonString(connectionString)
				? connectionString
				: null,
			claimUrl,
			deletionDate,
			region,
			name,
			projectId,
		},
		"json",
	);
}

const HUMAN_CONNECTION_LABEL = "Connection String:";
const HUMAN_CLAIM_HOST = PRISMA_CLAIM_HOSTS[0];
const HUMAN_DELETION_LABEL = "will be deleted on";

/**
 * `human-v1`: the documented pretty output, read by exact label.
 *
 * Requirements, all of which fail closed:
 * - exactly one `Connection String:` label, with the URI on the next
 *   non-empty line;
 * - exactly one `https://create-db.prisma.io…?projectID=proj_…` claim URL;
 * - a `will be deleted on <date> if not claimed` sentence, parsed with the
 *   caller's `referenceNow` only to resolve the CLI's locale-formatted date.
 */
export function parseCreateDbHumanV1(
	stdout: string,
	options: { readonly region: string },
): PrismaCreateResult {
	const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
	const text = stdout.replace(ansi, "");
	if (text.length > 64 * 1024) {
		contractError("create-db human output exceeded the 64 KiB cap");
	}
	const lines = text
		.split("\n")
		.map((line) => line.replace(/^[\s│┌◇●◆└|]*\s*/u, "").trimEnd());

	const labelIndexes = lines
		.map((line, index) => (line.includes(HUMAN_CONNECTION_LABEL) ? index : -1))
		.filter((index) => index >= 0);
	if (labelIndexes.length !== 1) {
		contractError(
			`create-db human output must contain exactly one "${HUMAN_CONNECTION_LABEL}" label, found ${labelIndexes.length}`,
		);
	}
	// SAFETY: value was established by the surrounding parse or typed constructor.
	const labelIndex = labelIndexes[0] as number;
	const connectionLine = lines
		.slice(labelIndex + 1, labelIndex + 3)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (
		connectionLine === undefined ||
		!/^postgres(?:ql)?:\/\//u.test(connectionLine)
	) {
		contractError(
			`create-db human output has no postgres URI on the line after "${HUMAN_CONNECTION_LABEL}"`,
		);
	}

	// Host equality, not prefix matching: `create-db.prisma.io.attacker.example`
	// starts with the official prefix and is not the official host.
	const claimLines = lines
		.map((line) => line.trim())
		.filter((line) => {
			if (!line.startsWith("https://")) return false;
			try {
				assertAllowedProviderUrl(line, DEFAULT_CLAIM_URL_POLICY);
				return true;
			} catch {
				return false;
			}
		});
	if (claimLines.length !== 1) {
		contractError(
			`create-db human output must contain exactly one ${HUMAN_CLAIM_HOST} claim URL, found ${claimLines.length}`,
		);
	}
	// SAFETY: value was established by the surrounding parse or typed constructor.
	const claimUrl = claimLines[0] as string;
	const projectMatch = /[?&]projectID=(proj_[A-Za-z0-9_-]{1,120})/u.exec(
		claimUrl,
	);
	if (projectMatch === null) {
		contractError("create-db human output claim URL carries no projectID");
	}

	const deletionLine = lines.find((line) =>
		line.includes(HUMAN_DELETION_LABEL),
	);
	if (deletionLine === undefined) {
		contractError(
			`create-db human output has no "${HUMAN_DELETION_LABEL}" sentence`,
		);
	}
	const deletionMatch = new RegExp(
		`${HUMAN_DELETION_LABEL}\\s+(.+?)\\s+if not claimed`,
		"u",
	).exec(deletionLine);
	if (deletionMatch === null) {
		contractError(
			"create-db human output deletion sentence does not match the documented shape",
		);
	}
	const deletionMs = Date.parse(
		// SAFETY: value was established by the surrounding parse or typed constructor.
		(deletionMatch[1] as string).replace(/,\s+/u, " "),
	);
	if (!Number.isFinite(deletionMs)) {
		contractError(
			"create-db human output prints a locale-formatted deletion date this parser cannot read; use --json",
		);
	}

	return finishResult(
		{
			connectionString: connectionLine,
			claimUrl,
			deletionDate: new Date(deletionMs).toISOString(),
			region: options.region,
			// The pretty output does not print the database name; the JSON
			// document does. Naming the gap beats inventing a value.
			name: "unnamed-human-output",
			// SAFETY: value was established by the surrounding parse or typed constructor.
			projectId: projectMatch[1] as string,
		},
		"human-v1",
	);
}
