/**
 * Shared Temporary / agent Environment Station contract (provider-neutral).
 * Cloudflare Temporary Accounts, Lakebed anonymous deploy, and broker
 * AnonymousSessionResult all project onto this fixture.
 *
 * Providers keep vendor transports private; only this result + helpers are shared.
 */

// public-contract: temporary Environment Station schema id consumers pin.
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";

export const TEMPORARY_ENVIRONMENT_STATION_SCHEMA =
	"hobo.temporary-environment-station/v1" as const;

/** Default TTL for temporary/agent stations (1h), matching CF Temporary Accounts. */
export const TEMPORARY_STATION_TTL_MS = 60 * 60 * 1000;

export type TemporaryEnvironmentStationResult = {
	readonly stationId: string;
	readonly stationUrl: string;
	readonly claimUrl: string;
	readonly expiresAt: string;
	readonly anonymous: true;
	readonly temporary: true;
	/** Provider target id (e.g. cloudflare, lakebed). */
	readonly providerId: string;
	/** Alias of stationUrl for broker AnonymousSessionResult.primaryUrl. */
	readonly primaryUrl?: string;
	readonly ttlSeconds?: number;
	readonly accountId?: string;
	readonly scriptName?: string;
};

export type TemporaryEnvironmentStationInput = {
	readonly stationId: string;
	readonly providerId: string;
	readonly fetchImpl?: typeof fetch;
	/** Opaque provider-specific payload (capsule dir, worker module, …). */
	readonly artifact?: unknown;
};

/**
 * Broker-aligned projection of a temporary station result.
 * Maps onto AnonymousSessionResult claim/primary/ttl fields without inventing
 * a second session type.
 */
export type TemporaryStationAnonymousSessionView = {
	readonly stationId: string;
	readonly providerId: string;
	readonly claimUrl: string;
	readonly primaryUrl: string;
	readonly expiresAt: string;
	readonly ttlSeconds: number;
	readonly anonymous: true;
	readonly temporary: true;
};

export function temporaryStationExpiresAt(
	ttlMs: number = TEMPORARY_STATION_TTL_MS,
	nowMs: number = Date.now(),
): string {
	return new Date(nowMs + ttlMs).toISOString();
}

export function temporaryStationTtlSeconds(
	ttlMs: number = TEMPORARY_STATION_TTL_MS,
): number {
	return Math.max(1, Math.floor(ttlMs / 1000));
}

export function temporaryStationToAnonymousSessionView(
	result: TemporaryEnvironmentStationResult,
): TemporaryStationAnonymousSessionView {
	const primaryUrl = result.primaryUrl ?? result.stationUrl;
	const ttlSeconds =
		result.ttlSeconds ??
		Math.max(
			1,
			Math.floor(
				(Date.parse(result.expiresAt) - Date.now()) / 1000 ||
					TEMPORARY_STATION_TTL_MS / 1000,
			),
		);
	return {
		stationId: result.stationId,
		providerId: result.providerId,
		claimUrl: result.claimUrl,
		primaryUrl,
		expiresAt: result.expiresAt,
		ttlSeconds,
		anonymous: true,
		temporary: true,
	};
}

export function assertTemporaryEnvironmentStationResult(
	value: JsonValue | undefined,
): TemporaryEnvironmentStationResult {
	if (value === null || !isJsonObject(value)) {
		throw new Error("temporary Environment Station result must be an object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const obj = value as JsonObject;
	for (const key of [
		"stationId",
		"stationUrl",
		"claimUrl",
		"expiresAt",
		"providerId",
	] as const) {
		if (!isJsonString(obj[key]) || obj[key].length === 0) {
			throw new Error(
				`temporary Environment Station result missing string field ${key}`,
			);
		}
	}
	if (obj.anonymous !== true || obj.temporary !== true) {
		throw new Error(
			"temporary Environment Station result must set anonymous:true and temporary:true",
		);
	}
	return {
		// SAFETY: assertion required at this I/O or test boundary.
		stationId: obj.stationId as string,
		// SAFETY: assertion required at this I/O or test boundary.
		stationUrl: obj.stationUrl as string,
		// SAFETY: assertion required at this I/O or test boundary.
		claimUrl: obj.claimUrl as string,
		// SAFETY: assertion required at this I/O or test boundary.
		expiresAt: obj.expiresAt as string,
		// SAFETY: assertion required at this I/O or test boundary.
		providerId: obj.providerId as string,
		anonymous: true,
		temporary: true,
		...(isJsonString(obj.primaryUrl)
			? { primaryUrl: obj.primaryUrl }
			: undefined),
		...(isJsonNumber(obj.ttlSeconds)
			? { ttlSeconds: obj.ttlSeconds }
			: undefined),
		...(isJsonString(obj.accountId) ? { accountId: obj.accountId } : undefined),
		...(isJsonString(obj.scriptName)
			? { scriptName: obj.scriptName }
			: undefined),
	};
}
