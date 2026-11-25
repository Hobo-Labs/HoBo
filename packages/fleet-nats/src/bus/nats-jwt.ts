import { hkdfSync } from "node:crypto";
import type { TenantId } from "@hobo/core";
import {
	type Account,
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
	type StaticUser,
	staticUserPermissions,
	TEMPLATES,
} from "./templates.js";

const MINUTE_MS = 60_000;
export const DEVICE_CREDENTIAL_MS = 10 * MINUTE_MS;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
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

const seconds = (ms: number) => Math.floor(ms / 1000);

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
	const user = (name: StaticUser) => derive(`user/${name}`, "user");
	const template = (name: DeviceTemplate) =>
		derive(`scoped/${name}`, "account");
	const users = {
		authority: user("authority"),
		witness: user("witness"),
		provisioner: user("provisioner"),
		sentinel: user("sentinel"),
	} satisfies Record<StaticUser, KeyPair>;
	const scoped = {
		observer: template("observer"),
		executor: template("executor"),
		dispatcher: template("dispatcher"),
	} satisfies Record<DeviceTemplate, KeyPair>;
	return {
		account: derive("account", "account"),
		xkey: derive("callout-xkey", "curve"),
		users,
		scoped,
	};
}

export function mintAccount(
	keys: TenantKeys,
	tenant: TenantId,
	operatorSigningSeed: string,
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

export type AccountSigningKeys = Readonly<{
	account: readonly string[];
	scoped: Readonly<Record<DeviceTemplate, readonly string[]>>;
}>;

export function signingKeysOfAccountJwt(
	jwt: string,
	account: string,
): AccountSigningKeys | undefined {
	let claims: ClaimsData<Account>;
	try {
		claims = decode(jwt);
	} catch {
		throw new Error("the resolver's account JWT does not decode");
	}
	if (claims.sub !== account)
		throw new Error("the resolver answered another account's JWT");
	const listed = claims.nats.signing_keys ?? [];
	if (listed.length === 0) return undefined;
	const plain: string[] = [];
	const roles: Readonly<{ role: DeviceTemplate; key: string }>[] = [];
	for (const key of listed) {
		if (!(key instanceof Object)) {
			plain.push(key);
			continue;
		}
		const role = DEVICE_TEMPLATES.find((name) => name === key.role);
		if (role === undefined)
			throw new Error("the published account lists an unknown scoped role");
		roles.push({ role, key: key.key });
	}
	const keysOf = (template: DeviceTemplate) =>
		roles.filter((entry) => entry.role === template).map((entry) => entry.key);
	return {
		account: plain,
		scoped: {
			observer: keysOf("observer"),
			executor: keysOf("executor"),
			dispatcher: keysOf("dispatcher"),
		},
	};
}

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

export function systemAccount(operatorSigningSeed: string): KeyPair {
	return deriveKey(operatorSigningSeed, "$SYS", "account", "account");
}

export function mintSystemAccount(
	operatorSigningSeed: string,
): Promise<string> {
	return encodeAccount(
		"SYS",
		systemAccount(operatorSigningSeed).getPublicKey(),
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
			pub: {
				allow: ["$SYS.REQ.CLAIMS.UPDATE", "$SYS.REQ.ACCOUNT.*.CLAIMS.LOOKUP"],
			},
			sub: { allow: ["_INBOX.>"] },
		},
	);
	return new TextDecoder().decode(fmtCreds(jwt, user));
}
