/**
 * Parse-don't-validate boundary for the claimable-database REST responses.
 *
 * Source of truth: https://neon.com/docs/reference/claimable-postgres
 * (checked 2026-08-08). Every field the driver relies on is checked here once;
 * downstream code sees {@link NeonDatabaseResponse} and never a bag of unknowns.
 */
import { NeonProviderError, redactProviderText } from "./errors.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export const NEON_DATABASE_STATUSES = [
	"UNCLAIMED",
	"CLAIMING",
	"CLAIMED",
] as const;

export type NeonDatabaseStatus = (typeof NEON_DATABASE_STATUSES)[number];

export type NeonDatabaseResponse = {
	/** UUID v7 assigned by the claimable-database service. */
	readonly databaseId: string;
	readonly status: NeonDatabaseStatus;
	readonly neonProjectId: string;
	/** Pooled Postgres URI. `null` once the database has been claimed. */
	readonly connectionString: string | null;
	readonly claimUrl: string;
	/**
	 * Provider-reported expiry, verbatim from `expires_at`. This driver never
	 * synthesizes a 72-hour timer from a local clock: the documented lifetime
	 * is a default, not a guarantee, and a locally computed deadline silently
	 * disagrees with the provider the moment either one changes.
	 */
	readonly expiresAtMs: number;
	readonly expiresAtIso: string;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CLAIM_URL_HOSTS = new Set(["neon.new"]);

function contractError(
	message: string,
	detail?: { preview?: string; message?: string; host?: string },
): never {
	throw new NeonProviderError("PROVIDER_CONTRACT_CHANGED", message, {
		...(detail !== undefined ? { detail } : undefined),
	});
}

function requireString(
	record: JsonObject,
	key: string,
	maxLength: number,
): string {
	const value = record[key];
	if (!isJsonString(value) || value.length === 0 || value.length > maxLength) {
		contractError(
			`claimable-database response field ${key} is not a bounded string`,
		);
	}
	return value;
}

function requireInstantMs(record: JsonObject, key: string): number {
	const raw = requireString(record, key, 64);
	const parsed = Date.parse(raw);
	if (!Number.isFinite(parsed)) {
		contractError(
			`claimable-database response field ${key} is not an ISO 8601 instant`,
		);
	}
	return parsed;
}

function isNeonDatabaseStatus(value: string): value is NeonDatabaseStatus {
	switch (value) {
		case "UNCLAIMED":
		case "CLAIMING":
		case "CLAIMED":
			return true;
		default:
			return false;
	}
}

/** Parse a response body from `POST /api/v1/database` or `GET /api/v1/database/:id`. */
export function parseNeonDatabaseResponse(body: string): NeonDatabaseResponse {
	let decoded: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		decoded = JSON.parse(body) as JsonValue;
	} catch {
		contractError("claimable-database response was not JSON", {
			preview: redactProviderText(body, 80),
		});
	}
	if (!isJsonObject(decoded)) {
		contractError("claimable-database response was not a JSON object");
	}
	const record = decoded;

	// The documented error envelope: `{ message, hint? }` with no `id`.
	if (record.id === undefined && isJsonString(record.message)) {
		contractError("claimable-database returned an error envelope", {
			message: redactProviderText(record.message, 120),
		});
	}

	const databaseId = requireString(record, "id", 64);
	if (!UUID.test(databaseId)) {
		contractError("claimable-database id is not a UUID");
	}

	const status = requireString(record, "status", 32);
	if (!isNeonDatabaseStatus(status)) {
		contractError(
			`claimable-database returned unknown status ${redactProviderText(status, 32)}`,
		);
	}

	const neonProjectId = requireString(record, "neon_project_id", 128);
	if (!PROJECT_ID.test(neonProjectId)) {
		contractError(
			"claimable-database neon_project_id is not a plain identifier",
		);
	}

	const rawConnection = record.connection_string;
	if (rawConnection !== null && !isJsonString(rawConnection)) {
		contractError(
			"claimable-database connection_string is neither a string nor null",
		);
	}
	if (isJsonString(rawConnection) && rawConnection.length > 2048) {
		contractError(
			"claimable-database connection_string exceeds the 2048 byte cap",
		);
	}

	const claimUrl = requireString(record, "claim_url", 512);
	let parsedClaimUrl: URL;
	try {
		parsedClaimUrl = new URL(claimUrl);
	} catch {
		contractError("claimable-database claim_url is not a URL");
	}
	if (
		parsedClaimUrl.protocol !== "https:" ||
		!CLAIM_URL_HOSTS.has(parsedClaimUrl.hostname)
	) {
		contractError(
			"claimable-database claim_url does not point at an official Neon host",
			{
				host: parsedClaimUrl.hostname,
			},
		);
	}

	const expiresAtMs = requireInstantMs(record, "expires_at");
	const createdAtMs = requireInstantMs(record, "created_at");
	const updatedAtMs = requireInstantMs(record, "updated_at");
	if (expiresAtMs <= createdAtMs) {
		contractError("claimable-database expires_at is not after created_at");
	}

	return {
		databaseId,
		status,
		neonProjectId,
		connectionString: isJsonString(rawConnection) ? rawConnection : null,
		claimUrl: parsedClaimUrl.toString(),
		expiresAtMs,
		expiresAtIso: new Date(expiresAtMs).toISOString(),
		createdAtMs,
		updatedAtMs,
	};
}
