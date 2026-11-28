/**
 * Persisted HOBO_HOME profile: default Station occupancy + broker association + login.
 * Local `hobo up` never requires this file; remote authenticated paths prefer it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PrincipalKind, PrincipalRef } from "@hobo/core";
import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "./json.js";

// public-contract: profile document schema under HOBO_HOME.
export const HOBO_PROFILE_SCHEMA = "hobo.profile/v1" as const;

export interface HoboProfileSession {
	readonly principal: PrincipalRef;
	readonly tenant: string;
	readonly token: string;
	readonly issuedAt: string;
	/** Optional DPoP / sender-constrained proof material id (never the raw key). */
	readonly proofKeyId?: string;
	readonly brokerUri?: string;
}

export interface HoboProfileDefaultStation {
	readonly id: string;
	readonly dataDir?: string;
}

export type HoboAlchemyVaultProvider = "owner-store" | "infisical" | "doppler";

export type HoboAlchemyStorageKind =
	| "sqlite-local"
	| "sqlite-shared"
	| "secondary-sqlite"
	| "rivet-actor";

export interface HoboAlchemyAuthProfile {
	readonly workspaceId: string;
	readonly ownerPrincipalId: string;
	readonly profileName: string;
	readonly stage: string;
	readonly vaultProvider: HoboAlchemyVaultProvider;
	readonly issuerOrigin: string;
	readonly basePath: string;
	readonly signingKeyLocator: string;
	readonly storageKind: HoboAlchemyStorageKind;
	readonly boxId: string;
	readonly sessionId: string;
	readonly handleDigest: string;
	readonly signingKeyFingerprint: string;
	readonly expiresAtMs: number;
	readonly allowCrossBoxReuse: boolean;
	readonly authDbPath?: string;
	readonly domainDbPath?: string;
}

export interface HoboProfile {
	readonly schemaVersion: typeof HOBO_PROFILE_SCHEMA;
	/**
	 * Optional remote Conductor HTTP base URI for login/placement over the network.
	 * Local setup is always Station occupancy — this is not a parallel setup path.
	 */
	readonly defaultBrokerUri?: string;
	/** Required for control-plane work once Station is initialized. */
	readonly defaultStation?: HoboProfileDefaultStation;
	readonly activeRail?: string;
	readonly session?: HoboProfileSession;
	readonly alchemyAuth?: HoboAlchemyAuthProfile;
	readonly updatedAt: string;
}

export function profilePath(hoboHome: string): string {
	return join(hoboHome, "profile.json");
}

export function loadHoboProfile(hoboHome: string): HoboProfile | null {
	const path = profilePath(hoboHome);
	if (!existsSync(path)) return null;
	try {
		const text = readFileSync(path, "utf8");
		JSON.parse(text);
		return parseHoboProfile(parseJsonValue(text));
	} catch {
		return null;
	}
}

export function saveHoboProfile(
	hoboHome: string,
	profile: HoboProfile,
): string {
	mkdirSync(hoboHome, { recursive: true });
	const path = profilePath(hoboHome);
	writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
	return path;
}

export function upsertLoginProfile(input: {
	readonly hoboHome: string;
	readonly principal: PrincipalRef;
	readonly tenant: string;
	readonly token: string;
	readonly brokerUri?: string;
	readonly proofKeyId?: string;
	readonly stationId?: string;
}): HoboProfile {
	const existing = loadHoboProfile(input.hoboHome);
	const session: HoboProfileSession = {
		principal: input.principal,
		tenant: input.tenant,
		token: input.token,
		issuedAt: new Date().toISOString(),
		...(input.proofKeyId !== undefined
			? { proofKeyId: input.proofKeyId }
			: undefined),
		...(input.brokerUri !== undefined
			? { brokerUri: input.brokerUri }
			: existing?.session?.brokerUri !== undefined
				? { brokerUri: existing.session.brokerUri }
				: undefined),
	};
	const profile: HoboProfile = {
		schemaVersion: HOBO_PROFILE_SCHEMA,
		updatedAt: new Date().toISOString(),
		session,
		...(input.brokerUri !== undefined
			? { defaultBrokerUri: input.brokerUri }
			: existing?.defaultBrokerUri !== undefined
				? { defaultBrokerUri: existing.defaultBrokerUri }
				: session.brokerUri !== undefined
					? { defaultBrokerUri: session.brokerUri }
					: undefined),
		...(input.stationId !== undefined
			? { defaultStation: { id: input.stationId } }
			: existing?.defaultStation !== undefined
				? { defaultStation: existing.defaultStation }
				: undefined),
		...(existing?.activeRail !== undefined
			? { activeRail: existing.activeRail }
			: undefined),
		...(existing?.alchemyAuth !== undefined
			? { alchemyAuth: existing.alchemyAuth }
			: undefined),
	};
	saveHoboProfile(input.hoboHome, profile);
	return profile;
}

export function upsertAlchemyAuthProfile(
	hoboHome: string,
	alchemyAuth: HoboAlchemyAuthProfile,
): HoboProfile {
	const existing = loadHoboProfile(hoboHome);
	const profile: HoboProfile = {
		schemaVersion: HOBO_PROFILE_SCHEMA,
		updatedAt: new Date().toISOString(),
		alchemyAuth,
		...(existing?.defaultBrokerUri !== undefined
			? { defaultBrokerUri: existing.defaultBrokerUri }
			: undefined),
		...(existing?.defaultStation !== undefined
			? { defaultStation: existing.defaultStation }
			: undefined),
		...(existing?.activeRail !== undefined
			? { activeRail: existing.activeRail }
			: undefined),
		...(existing?.session !== undefined
			? { session: existing.session }
			: undefined),
	};
	saveHoboProfile(hoboHome, profile);
	return profile;
}

export function setDefaultStation(
	hoboHome: string,
	station: HoboProfileDefaultStation,
	activeRail?: string,
): HoboProfile {
	const existing = loadHoboProfile(hoboHome);
	const profile: HoboProfile = {
		schemaVersion: HOBO_PROFILE_SCHEMA,
		updatedAt: new Date().toISOString(),
		defaultStation: station,
		...(activeRail !== undefined
			? { activeRail }
			: existing?.activeRail !== undefined
				? { activeRail: existing.activeRail }
				: undefined),
		...(existing?.defaultBrokerUri !== undefined
			? { defaultBrokerUri: existing.defaultBrokerUri }
			: undefined),
		...(existing?.session !== undefined
			? { session: existing.session }
			: undefined),
		...(existing?.alchemyAuth !== undefined
			? { alchemyAuth: existing.alchemyAuth }
			: undefined),
	};
	saveHoboProfile(hoboHome, profile);
	return profile;
}

export function parseHoboProfile(raw: JsonValue | undefined): HoboProfile {
	if (raw === null || !isJsonObject(raw)) {
		throw new TypeError("hobo profile must be an object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const obj = raw as JsonObject;
	if (obj.schemaVersion !== HOBO_PROFILE_SCHEMA) {
		throw new TypeError(
			`hobo profile schemaVersion must be ${HOBO_PROFILE_SCHEMA}`,
		);
	}
	if (!isJsonString(obj.updatedAt) || obj.updatedAt.length === 0) {
		throw new TypeError("hobo profile.updatedAt must be a non-empty string");
	}
	const profile: HoboProfile = {
		schemaVersion: HOBO_PROFILE_SCHEMA,
		updatedAt: obj.updatedAt,
		...(isJsonString(obj.defaultBrokerUri) && obj.defaultBrokerUri.length > 0
			? { defaultBrokerUri: obj.defaultBrokerUri }
			: undefined),
		...(isJsonString(obj.activeRail) && obj.activeRail.length > 0
			? { activeRail: obj.activeRail }
			: undefined),
	};
	if (obj.defaultStation !== undefined && obj.defaultStation !== null) {
		// SAFETY: assertion required at this I/O or test boundary.
		const ds = obj.defaultStation as JsonObject;
		if (!isJsonString(ds.id) || ds.id.length === 0) {
			throw new TypeError("hobo profile.defaultStation.id required");
		}
		Object.assign(profile, {
			defaultStation: Object.freeze({
				id: ds.id,
				...(isJsonString(ds.dataDir) ? { dataDir: ds.dataDir } : undefined),
			}),
		});
	}
	if (obj.alchemyAuth !== undefined && obj.alchemyAuth !== null) {
		Object.assign(profile, {
			alchemyAuth: parseAlchemyAuthProfile(obj.alchemyAuth),
		});
	}
	if (obj.session !== undefined && obj.session !== null) {
		// SAFETY: assertion required at this I/O or test boundary.
		const s = obj.session as JsonObject;
		const principal = parsePrincipal(s.principal);
		if (!isJsonString(s.tenant) || s.tenant.length === 0) {
			throw new TypeError("hobo profile.session.tenant required");
		}
		if (!isJsonString(s.token) || s.token.length === 0) {
			throw new TypeError("hobo profile.session.token required");
		}
		if (!isJsonString(s.issuedAt) || s.issuedAt.length === 0) {
			throw new TypeError("hobo profile.session.issuedAt required");
		}
		return {
			...profile,
			session: {
				principal,
				tenant: s.tenant,
				token: s.token,
				issuedAt: s.issuedAt,
				...(isJsonString(s.proofKeyId)
					? { proofKeyId: s.proofKeyId }
					: undefined),
				...(isJsonString(s.brokerUri) ? { brokerUri: s.brokerUri } : undefined),
			},
		};
	}
	return profile;
}

function parseVaultProvider(
	value: JsonValue | undefined,
): HoboAlchemyVaultProvider {
	switch (value) {
		case "owner-store":
		case "infisical":
		case "doppler":
			return value;
		default:
			throw new TypeError("hobo profile.alchemyAuth.vaultProvider invalid");
	}
}

function parseStorageKind(
	value: JsonValue | undefined,
): HoboAlchemyStorageKind {
	switch (value) {
		case "sqlite-local":
		case "sqlite-shared":
		case "secondary-sqlite":
		case "rivet-actor":
			return value;
		default:
			throw new TypeError("hobo profile.alchemyAuth.storageKind invalid");
	}
}

function requireProfileString(
	obj: JsonObject,
	key: string,
	pattern?: RegExp,
): string {
	const value = obj[key];
	if (!isJsonString(value) || value.length === 0) {
		throw new TypeError(`hobo profile.alchemyAuth.${key} required`);
	}
	if (pattern !== undefined && !pattern.test(value)) {
		throw new TypeError(`hobo profile.alchemyAuth.${key} invalid`);
	}
	return value;
}

function parseAlchemyAuthProfile(
	raw: JsonValue | undefined,
): HoboAlchemyAuthProfile {
	if (raw === null || !isJsonObject(raw)) {
		throw new TypeError("hobo profile.alchemyAuth must be an object");
	}
	const expiresAtMs = raw.expiresAtMs;
	if (
		!isJsonNumber(expiresAtMs) ||
		!Number.isInteger(expiresAtMs) ||
		expiresAtMs < 0
	) {
		throw new TypeError(
			"hobo profile.alchemyAuth.expiresAtMs must be a non-negative integer",
		);
	}
	const allowCrossBoxReuse = raw.allowCrossBoxReuse;
	if (!isJsonBoolean(allowCrossBoxReuse)) {
		throw new TypeError(
			"hobo profile.alchemyAuth.allowCrossBoxReuse must be a boolean",
		);
	}
	return Object.freeze({
		workspaceId: requireProfileString(raw, "workspaceId"),
		ownerPrincipalId: requireProfileString(raw, "ownerPrincipalId"),
		profileName: requireProfileString(raw, "profileName"),
		stage: requireProfileString(raw, "stage"),
		vaultProvider: parseVaultProvider(raw.vaultProvider),
		issuerOrigin: requireProfileString(raw, "issuerOrigin", /^https?:\/\//u),
		basePath: requireProfileString(raw, "basePath", /^\//u),
		signingKeyLocator: requireProfileString(
			raw,
			"signingKeyLocator",
			/^owner:\/\/[A-Z][A-Z0-9_]{1,127}$/u,
		),
		storageKind: parseStorageKind(raw.storageKind),
		boxId: requireProfileString(raw, "boxId"),
		sessionId: requireProfileString(raw, "sessionId"),
		handleDigest: requireProfileString(
			raw,
			"handleDigest",
			/^sha256:[a-f0-9]{16,64}$/u,
		),
		signingKeyFingerprint: requireProfileString(
			raw,
			"signingKeyFingerprint",
			/^sha256:[a-f0-9]{16,64}$/u,
		),
		expiresAtMs,
		allowCrossBoxReuse,
		...(isJsonString(raw.authDbPath) && raw.authDbPath.length > 0
			? { authDbPath: raw.authDbPath }
			: undefined),
		...(isJsonString(raw.domainDbPath) && raw.domainDbPath.length > 0
			? { domainDbPath: raw.domainDbPath }
			: undefined),
	});
}

function parsePrincipal(raw: JsonValue | undefined): PrincipalRef {
	if (raw === null || !isJsonObject(raw)) {
		throw new TypeError("principal must be an object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const obj = raw as JsonObject;
	const kinds: PrincipalKind[] = ["user", "agent", "service", "system"];
	// SAFETY: assertion required at this I/O or test boundary.
	if (!isJsonString(obj.kind) || !(kinds as string[]).includes(obj.kind)) {
		throw new TypeError("principal.kind invalid");
	}
	if (!isJsonString(obj.id) || obj.id.length === 0) {
		throw new TypeError("principal.id required");
	}
	return {
		// SAFETY: assertion required at this I/O or test boundary.
		kind: obj.kind as PrincipalKind,
		id: obj.id,
		...(obj.delegatedBy !== undefined
			? { delegatedBy: parsePrincipal(obj.delegatedBy) }
			: undefined),
	};
}
