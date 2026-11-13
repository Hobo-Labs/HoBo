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

/** A key of the tenant, derived from the operator signing seed. Same inputs, same key. */
export function deriveKey(
	operatorSigningSeed: string,
	tenant: TenantId,
	purpose: string,
	role: KeyRole,
): KeyPair {
	const raw = new Uint8Array(
		hkdfSync(
			"sha256",
			encoder.encode(operatorSigningSeed),
			encoder.encode(`hobo-fleet/nats/${tenant}`),
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
	const jwt = credentials.match(
		/-----BEGIN NATS USER JWT-----\s*([^\s]+)\s*------END NATS USER JWT------/u,
	)?.[1];
	if (jwt === undefined) throw new Error("not a NATS credentials file");
	const claims: ClaimsData<User> = decode(jwt);
	return claims.nats.issuer_account ?? claims.iss;
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
): Promise<string> {
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
			signing_keys: DEVICE_TEMPLATES.map((template) =>
				newScopedSigner(keys.scoped[template], template, {
					pub: { allow: [...TEMPLATES[template].publish] },
					sub: { allow: [...TEMPLATES[template].subscribe] },
				}),
			),
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

/** A static user's credentials file, signed by the account key. */
export async function staticCredentials(
	keys: TenantKeys,
	user: StaticUser,
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
	const jwt = await encodeUser(user, keys.users[user], keys.account, claims);
	return new TextDecoder().decode(fmtCreds(jwt, keys.users[user]));
}
