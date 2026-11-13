/**
 * NATS JWTs on `@nats-io/jwt` (assumption A7): the tenant account with its
 * three scoped signing keys and its auth-callout settings, the static users'
 * credentials, the per-connection device user and the authorization response.
 *
 * Every key of a tenant is derived from the operator signing seed and the
 * tenant (HKDF-SHA-256), so provisioning the same tenant again yields the
 * same account and keys: `provisionTopology` is idempotent without any store
 * of its own. Whoever holds the operator signing seed can already sign any
 * account, so the derivation widens nothing.
 */
import { hkdfSync } from "node:crypto";
import type { TenantId } from "@hobo/core";
import {
	type AuthorizationRequest,
	type ClaimsData,
	decode,
	encodeAccount,
	encodeAuthorizationResponse,
	encodeUser,
	fmtCreds,
	fromPublic,
	fromSeed,
	type KeyPair,
	newScopedSigner,
	type User,
} from "@nats-io/jwt";
import {
	DEVICE_TEMPLATES,
	type DeviceTemplate,
	STATIC_USERS,
	type StaticUser,
	staticUserPermissions,
	TEMPLATES,
} from "./templates.js";

const MINUTE_MS = 60_000;
/** §6.7 step 4: a device's user JWT expires after 10 minutes. */
export const DEVICE_CREDENTIAL_MS = 10 * MINUTE_MS;

// ── Seeds ──────────────────────────────────────────────────────────────────

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** NATS nkey prefix bytes (nkeys `Prefix`). */
const PREFIX = {
	seed: 18 << 3,
	account: 0,
	user: 20 << 3,
	curve: 23 << 3,
} as const;

function crc16(bytes: Uint8Array): number {
	let crc = 0;
	for (const byte of bytes) {
		crc ^= byte << 8;
		for (let bit = 0; bit < 8; bit += 1)
			crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
	}
	return crc;
}

function base32(bytes: Uint8Array): string {
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
	return out;
}

/** The nkeys seed encoding of a raw 32-byte seed for the key type `role`. */
export function encodeSeed(role: number, raw: Uint8Array): string {
	const body = new Uint8Array(2 + raw.length);
	body[0] = PREFIX.seed | (role >> 5);
	body[1] = (role & 31) << 3;
	body.set(raw, 2);
	const crc = crc16(body);
	const full = new Uint8Array(body.length + 2);
	full.set(body);
	full[body.length] = crc & 0xff;
	full[body.length + 1] = crc >> 8;
	return base32(full);
}

const encoder = new TextEncoder();

type KeyRole = "account" | "user" | "curve";

/**
 * A key derived from the operator signing seed. Same inputs, same key.
 * `scope` is a tenant id, or `$SYS` for the system account.
 */
export function deriveKey(
	operatorSigningSeed: string,
	scope: TenantId | "$SYS",
	purpose: string,
	role: KeyRole,
): KeyPair {
	const raw = new Uint8Array(
		hkdfSync(
			"sha256",
			encoder.encode(operatorSigningSeed),
			encoder.encode(`hobo-fleet/nats/${scope}`),
			encoder.encode(purpose),
			32,
		),
	);
	return fromSeed(encoder.encode(encodeSeed(PREFIX[role], raw)));
}

// ── Verification ───────────────────────────────────────────────────────────

/** True when `jwt` is signed by the nkey it names as `iss`. */
export function verifyJwt(jwt: string): boolean {
	const parts = jwt.split(".");
	if (parts.length !== 3) return false;
	const [header, payload, signature] = parts;
	try {
		const claims: ClaimsData<User> = decode(jwt);
		return fromPublic(claims.iss).verify(
			encoder.encode(`${header}.${payload}`),
			Buffer.from(signature ?? "", "base64url"),
		);
	} catch {
		return false;
	}
}

export type VerifiedRequest = Readonly<{
	verified: boolean;
	claims: ClaimsData<AuthorizationRequest> | undefined;
}>;

/** Decodes an auth-callout request and checks that the server named in it signed it. */
export function verifyAuthorizationRequest(jwt: string): VerifiedRequest {
	let claims: ClaimsData<AuthorizationRequest> | undefined;
	try {
		claims = decode(jwt);
	} catch {
		return { verified: false, claims: undefined };
	}
	const server = claims.nats.server_id?.id;
	const verified =
		verifyJwt(jwt) &&
		claims.aud === "nats-authorization-request" &&
		server !== undefined &&
		claims.iss === server &&
		claims.nats.user_nkey !== undefined;
	return { verified, claims };
}

// ── Minting ────────────────────────────────────────────────────────────────

const seconds = (ms: number) => Math.floor(ms / 1000);

/** The device's user JWT: named by its member id, issued by the template's scoped key, no permissions of its own. */
export function mintDeviceUser(
	input: Readonly<{
		userNkey: string;
		memberId: string;
		accountPublicKey: string;
		scopedSeed: string;
		nowMs: number;
	}>,
): Promise<string> {
	return encodeUser(
		input.memberId,
		input.userNkey,
		input.accountPublicKey,
		{},
		{
			signer: fromSeed(encoder.encode(input.scopedSeed)),
			scopedUser: true,
			exp: seconds(input.nowMs + DEVICE_CREDENTIAL_MS),
		},
	);
}

/** The callout's answer: the user JWT, or an error, for `userNkey` on `serverId`. */
export function mintAuthorizationResponse(
	input: Readonly<{
		userNkey: string;
		serverId: string;
		accountPublicKey: string;
		signerSeed: string;
		answer: Readonly<{ jwt: string } | { error: string }>;
		nowMs: number;
	}>,
): Promise<string> {
	return encodeAuthorizationResponse(
		input.userNkey,
		input.serverId,
		input.accountPublicKey,
		{ ...input.answer },
		{
			signer: fromSeed(encoder.encode(input.signerSeed)),
			exp: seconds(input.nowMs + MINUTE_MS),
		},
	);
}

/** The account a credentials file's user belongs to. */
export function accountOfCredentials(credentials: string): string {
	const claims = userClaimsOf(credentials);
	return claims.nats.issuer_account ?? claims.iss;
}

function userClaimsOf(credentials: string): ClaimsData<User> {
	const jwt = credentials.match(
		/-----BEGIN NATS USER JWT-----\s*([^\s]+)\s*------END NATS USER JWT------/u,
	)?.[1];
	if (jwt === undefined) throw new Error("not a NATS credentials file");
	return decode(jwt);
}

/**
 * Whose audit log a connection with `credentials` holds: the witness's when
 * the credentials are the static `witness` user's, else the authority's.
 */
export function auditRoleOfCredentials(
	credentials: string,
): "authority" | "witness" {
	return userClaimsOf(credentials).name === "witness" ? "witness" : "authority";
}

export type TenantKeys = Readonly<{
	account: KeyPair;
	xkey: KeyPair;
	users: Readonly<Record<StaticUser, KeyPair>>;
	scoped: Readonly<Record<DeviceTemplate, KeyPair>>;
}>;

export function tenantKeys(
	operatorSigningSeed: string,
	tenant: TenantId,
): TenantKeys {
	const derive = (purpose: string, role: KeyRole) =>
		deriveKey(operatorSigningSeed, tenant, purpose, role);
	const users = Object.fromEntries(
		STATIC_USERS.map((user) => [user, derive(`user/${user}`, "user")]),
	);
	const scoped = Object.fromEntries(
		DEVICE_TEMPLATES.map((template) => [
			template,
			derive(`scoped/${template}`, "account"),
		]),
	);
	return {
		account: derive("account", "account"),
		xkey: derive("callout-xkey", "curve"),
		// SAFETY: built from STATIC_USERS on the line above, one entry per user.
		users: users as Record<StaticUser, KeyPair>,
		// SAFETY: built from DEVICE_TEMPLATES on the line above, one entry per template.
		scoped: scoped as Record<DeviceTemplate, KeyPair>,
	};
}

/** The tenant account JWT, signed by the operator signing key. */
export function mintAccount(
	keys: TenantKeys,
	tenant: TenantId,
	operatorSigningSeed: string,
	/** The templates whose scoped keys the account lists; removing one revokes every credential it signs (§6.16). */
	templates: readonly DeviceTemplate[] = DEVICE_TEMPLATES,
): Promise<string> {
	const listed = new Set(templates);
	const scoped = (template: DeviceTemplate) =>
		listed.has(template) ? [keys.scoped[template].getPublicKey()] : [];
	return mintAccountWithSigningKeys(keys, tenant, operatorSigningSeed, {
		account: [],
		scoped: {
			observer: scoped("observer"),
			executor: scoped("executor"),
			dispatcher: scoped("dispatcher"),
		},
	});
}

/**
 * The signing keys a tenant account JWT lists, as the secret-store slots
 * hold them (`<prefix>/account-signing`, `<prefix>/scoped-<template>`):
 * every version a verifier may still need, so that a key can be added,
 * published, switched to and removed without an outage (§6.16).
 */
export type AccountSigningKeys = Readonly<{
	/** Plain account signing keys (nkey `A…`): they sign the static users' credentials. */
	account: readonly string[];
	/** Scoped keys per template (nkey `A…`), each listed with that template's `{{name()}}` permissions. */
	scoped: Readonly<Record<DeviceTemplate, readonly string[]>>;
}>;

/** Throws unless `key` is an account public key; never echoes the value, which could be a seed passed by mistake. */
function checkAccountKey(key: string, place: number): void {
	let valid = false;
	try {
		valid = key.startsWith("A") && fromPublic(key).getPublicKey() === key;
	} catch {
		valid = false;
	}
	if (!valid)
		throw new Error(`signing key ${place} is not an account public key`);
}

/**
 * The tenant account JWT listing exactly `signing`, signed by the operator
 * signing key. The account identity, its limits and its auth-callout
 * settings are those `mintAccount` gives it.
 */
export async function mintAccountWithSigningKeys(
	keys: TenantKeys,
	tenant: TenantId,
	operatorSigningSeed: string,
	signing: AccountSigningKeys,
): Promise<string> {
	const seen = new Set<string>();
	const all = [
		...signing.account,
		...DEVICE_TEMPLATES.flatMap((template) => signing.scoped[template]),
	];
	for (const [index, key] of all.entries()) {
		checkAccountKey(key, index + 1);
		if (seen.has(key)) throw new Error(`signing key ${key} is listed twice`);
		seen.add(key);
	}
	const account = keys.account.getPublicKey();
	return encodeAccount(
		`T_${tenant}`,
		account,
		{
			limits: {
				subs: -1,
				data: -1,
				payload: -1,
				imports: -1,
				exports: -1,
				wildcards: true,
				conn: -1,
				leaf: 0,
				mem_storage: -1,
				disk_storage: -1,
				streams: -1,
				consumer: -1,
			},
			signing_keys: [
				...signing.account,
				...DEVICE_TEMPLATES.flatMap((template) =>
					signing.scoped[template].map((key) =>
						newScopedSigner(key, template, {
							pub: { allow: [...TEMPLATES[template].publish] },
							sub: { allow: [...TEMPLATES[template].subscribe] },
						}),
					),
				),
			],
			authorization: {
				auth_users: (["authority", "witness", "provisioner"] as const).map(
					(user) => keys.users[user].getPublicKey(),
				),
				allowed_accounts: [account],
				xkey: keys.xkey.getPublicKey(),
			},
		},
		{ signer: fromSeed(encoder.encode(operatorSigningSeed)) },
	);
}

/**
 * A static user's credentials file, signed by the account key, or by the
 * account signing key `signerSeed` (then the JWT names the account as
 * `issuer_account`). The user's own key is the same either way, so the
 * account's `auth_users` still lets it past the callout.
 */
export async function staticCredentials(
	keys: TenantKeys,
	user: StaticUser,
	signerSeed?: string,
): Promise<string> {
	const permissions = staticUserPermissions(user);
	const denyAll = permissions.denyPublish.includes(">");
	const claims: Partial<User> = {
		pub: {
			allow: [...permissions.publish],
			deny: [...permissions.denyPublish],
		},
		sub: denyAll ? { deny: [">"] } : { allow: [...permissions.subscribe] },
	};
	if (permissions.allowResponses) claims.resp = { max: 1, ttl: 0 };
	const jwt = await encodeUser(
		user,
		keys.users[user],
		keys.account,
		claims,
		signerSeed === undefined
			? {}
			: { signer: fromSeed(encoder.encode(signerSeed)) },
	);
	return new TextDecoder().decode(fmtCreds(jwt, keys.users[user]));
}

/**
 * The system account's key, derived from the operator signing seed. The
 * operator JWT names this account as its `system_account`;
 * `provisionTopology` pushes account JWTs to the resolver
 * (`$SYS.REQ.CLAIMS.UPDATE`) as a user of it.
 */
export function systemAccount(operatorSigningSeed: string): KeyPair {
	return deriveKey(operatorSigningSeed, "$SYS", "account", "account");
}

/** The system account JWT, signed by the operator signing key. */
export function mintSystemAccount(
	operatorSigningSeed: string,
): Promise<string> {
	return encodeAccount(
		"SYS",
		systemAccount(operatorSigningSeed).getPublicKey(),
		// The server reads an absent limit as zero: no connections, no subscriptions.
		{
			limits: {
				subs: -1,
				data: -1,
				payload: -1,
				imports: -1,
				exports: -1,
				wildcards: true,
				conn: -1,
				leaf: -1,
			},
		},
		{ signer: fromSeed(encoder.encode(operatorSigningSeed)) },
	);
}

/** Credentials of the system-account user that pushes account JWTs. */
export async function systemCredentials(
	operatorSigningSeed: string,
): Promise<string> {
	const user = deriveKey(
		operatorSigningSeed,
		"$SYS",
		"user/provisioner",
		"user",
	);
	const jwt = await encodeUser(
		"hobo-fleet-provisioner",
		user,
		systemAccount(operatorSigningSeed),
		{
			pub: { allow: ["$SYS.REQ.CLAIMS.UPDATE"] },
			sub: { allow: ["_INBOX.>"] },
		},
	);
	return new TextDecoder().decode(fmtCreds(jwt, user));
}
