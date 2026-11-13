/**
 * What `hobo fleet` keeps under `HOBO_FLEET_HOME` (default `~/.hobo/fleet`),
 * besides the device key store:
 *
 * - `person.json` (0600): the signed-in person's DPoP-bound token and the
 *   ES256 sign-in key it is bound to (PKCS#8, base64url). Without the key the
 *   token is useless, so they live and die together; `logout` deletes both.
 * - `enrollment.json` (0644): the discovery document and member id from the
 *   last enrollment, which `run` needs to find relays before the agent has
 *   connected. It holds no secret: overlay join credentials are used at
 *   enrollment and never written.
 *
 * Nothing here logs a token or a key (rule 11).
 */
import {
	createPrivateKey,
	generateKeyPairSync,
	type KeyObject,
	randomBytes,
	sign,
} from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
	type Discovery,
	DiscoverySchema,
	KeyAlgorithm,
	type Outcome,
	type PersonCredential,
	type PublicJwk,
	parseKeyId,
	type Signer,
} from "@hobo/fleet";
import { jwkThumbprint, memberIdFromJwk } from "@hobo/fleet/keys";
import type { SignInKey } from "./fleet-command.js";
import { isJsonObject, isJsonString, parseJsonObject } from "./json.js";

export function fleetHome(env: Readonly<Record<string, string | undefined>>) {
	const configured = env.HOBO_FLEET_HOME;
	return configured !== undefined && configured.length > 0
		? configured
		: join(homedir(), ".hobo", "fleet");
}

/** Atomic replace with the given mode. */
export async function writeAtomic(
	path: string,
	text: string,
	mode: number,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temporary, text, { encoding: "utf8", mode, flag: "wx" });
	try {
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

function es256Signer(privateKey: KeyObject, publicJwk: PublicJwk): Signer {
	return {
		keyId: parseKeyId(`${memberIdFromJwk(publicJwk)}#identity`),
		algorithm: KeyAlgorithm.ES256,
		async sign(bytes) {
			return new Uint8Array(
				sign("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" }),
			);
		},
	};
}

function publicJwkOf(privateKey: KeyObject): PublicJwk {
	const jwk = privateKey.export({ format: "jwk" });
	return {
		kty: "EC",
		crv: "P-256",
		x: jwk.x ?? "",
		y: jwk.y ?? "",
	};
}

function signInKeyOf(privateKey: KeyObject): SignInKey {
	const publicJwk = publicJwkOf(privateKey);
	return {
		signer: es256Signer(privateKey, publicJwk),
		publicJwk,
		thumbprint: jwkThumbprint(publicJwk),
	};
}

// domain-view: a held sign-in key with its private half, for writing to person.json only.
type HeldSignInKey = SignInKey & Readonly<{ pkcs8: string }>;

const heldKeys = new WeakMap<SignInKey, string>();

/** A fresh ES256 sign-in key; its private half is kept for `savePerson` only. */
export function newSignInKey(): SignInKey {
	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const key = signInKeyOf(privateKey);
	heldKeys.set(
		key,
		privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
	);
	return key;
}

// domain-view: the stored sign-in as `person.json` holds it.
export type StoredPerson = Readonly<{
	token: string;
	expiresAt: string;
	principal: string;
	tenant: string;
	key: SignInKey;
}>;

const PERSON_FILE = "person.json";
const ENROLLMENT_FILE = "enrollment.json";

export async function savePerson(
	home: string,
	credential: PersonCredential,
	key: SignInKey,
): Promise<void> {
	const pkcs8 = heldKeys.get(key);
	if (pkcs8 === undefined)
		throw new Error("only a sign-in key this process made can be saved");
	const held: HeldSignInKey = { ...key, pkcs8 };
	await writeAtomic(
		join(home, PERSON_FILE),
		`${JSON.stringify({
			v: 1,
			token: credential.token,
			expiresAt: credential.expiresAt,
			refreshUntil: credential.refreshUntil,
			principal: credential.principal,
			tenant: credential.tenant,
			key: held.pkcs8,
		})}\n`,
		0o600,
	);
}

export async function readPerson(
	home: string,
): Promise<StoredPerson | undefined> {
	let text: string;
	try {
		text = await readFile(join(home, PERSON_FILE), "utf8");
	} catch {
		return undefined;
	}
	let value: ReturnType<typeof parseJsonObject>;
	try {
		value = parseJsonObject(text);
	} catch {
		return undefined;
	}
	const { token, expiresAt, principal, tenant, key } = value;
	if (
		!isJsonString(token) ||
		!isJsonString(key) ||
		!isJsonString(principal) ||
		!isJsonString(tenant)
	)
		return undefined;
	let privateKey: KeyObject;
	try {
		privateKey = createPrivateKey({
			key: Buffer.from(key, "base64url"),
			format: "der",
			type: "pkcs8",
		});
	} catch {
		return undefined;
	}
	return {
		token,
		expiresAt: isJsonString(expiresAt) ? expiresAt : "",
		principal,
		tenant,
		key: signInKeyOf(privateKey),
	};
}

export async function deletePerson(home: string): Promise<void> {
	await rm(join(home, PERSON_FILE), { force: true });
}

// domain-view: what `enrollment.json` holds.
export type StoredEnrollment = Readonly<{
	memberId: string;
	tenant: string;
	discovery: Discovery;
}>;

export async function saveEnrollment(
	home: string,
	enrollment: StoredEnrollment,
): Promise<void> {
	await writeAtomic(
		join(home, ENROLLMENT_FILE),
		`${JSON.stringify({
			v: 1,
			memberId: enrollment.memberId,
			tenant: enrollment.tenant,
			discovery: JSON.parse(
				toJsonString(DiscoverySchema, enrollment.discovery),
			),
		})}\n`,
		0o644,
	);
}

export async function readEnrollment(
	home: string,
): Promise<Outcome<StoredEnrollment>> {
	const missing: Outcome<StoredEnrollment> = {
		ok: false,
		error: {
			code: "member-unknown",
			message: `this device is not enrolled (no ${join(home, ENROLLMENT_FILE)}); run hobo fleet enroll`,
		},
	};
	let text: string;
	try {
		text = await readFile(join(home, ENROLLMENT_FILE), "utf8");
	} catch {
		return missing;
	}
	try {
		const value = parseJsonObject(text);
		const { memberId, tenant, discovery } = value;
		if (
			!isJsonString(memberId) ||
			!isJsonString(tenant) ||
			!isJsonObject(discovery)
		)
			return missing;
		return {
			ok: true,
			value: {
				memberId,
				tenant,
				discovery: fromJsonString(DiscoverySchema, JSON.stringify(discovery), {
					ignoreUnknownFields: true,
				}),
			},
		};
	} catch {
		return missing;
	}
}

export async function deleteEnrollment(home: string): Promise<void> {
	await rm(join(home, ENROLLMENT_FILE), { force: true });
}
