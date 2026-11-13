// Where the operations keep keys: one secret per key behind `SecretsPort`
// (design §6.16), named `<prefix>/<which>`. A slot holds every version of the
// key that verifiers may still need and names the active one; rotation
// progress (no key material) is a second secret, `<prefix>/rotation/<which>`.
// The token-signing key is the exception: it lives in @hobo/identity's key
// ring under `<prefix>/token-signing`, which `loadSecretStoreKms` reads.
// Private to L27.
import { create } from "@bufbuild/protobuf";
import type { JsonObject } from "@hobo/core";
import {
	KeyAlgorithm,
	type KeyPurpose,
	type Outcome,
	type PublicKeyRef,
	PublicKeyRefSchema,
	parseKeyId,
	type Signer,
} from "@hobo/fleet";
import type { RotatableKey } from "./index.js";
import {
	isJsonArray,
	isJsonObject,
	numberField,
	parseJson,
	stringField,
} from "./json.js";
import {
	encodeNkeyPublic,
	encodeNkeySeed,
	freshSeed,
	rawPublicKey,
	signWithSeed,
} from "./nkeys.js";

const NOT_FOUND = "secret-not-found";

export type KeyFamily = "ed25519" | "nkey-operator" | "nkey-account" | "rsa";

// domain-view: the family and key-id stem of each rotatable key (§6.16); not a record.
type KeyKind = Readonly<{ family: KeyFamily; stem: string }>;

export const KEY_KINDS = {
	"operator-signing": { family: "nkey-operator", stem: "operator-signing" },
	"account-signing": { family: "nkey-account", stem: "account-signing" },
	"scoped-observer": { family: "nkey-account", stem: "scoped-observer" },
	"scoped-executor": { family: "nkey-account", stem: "scoped-executor" },
	"scoped-dispatcher": { family: "nkey-account", stem: "scoped-dispatcher" },
	"token-signing": { family: "rsa", stem: "token-signing" },
	"record-signing": { family: "ed25519", stem: "authority" },
	witness: { family: "ed25519", stem: "witness" },
} as const satisfies Readonly<Record<RotatableKey, KeyKind>>;

// domain-view: one held version of a key in its slot secret; private material never leaves the secret store except to sign.
export type HeldKey = Readonly<{
	kid: string;
	seed: string;
	publicKey: string;
}>;
// domain-view: the slot secret's value (one secret per key, §6.16).
export type KeySlot = Readonly<{ active: string; keys: readonly HeldKey[] }>;

export function slotName(prefix: string, which: RotatableKey): string {
	return `${prefix}/${which}`;
}

export function rotationName(prefix: string, which: RotatableKey): string {
	return `${prefix}/rotation/${which}`;
}

export type SecretsLike = Readonly<{
	put(name: string, value: string): Promise<{ versionId: string }>;
	access(
		name: string,
	): Promise<
		Readonly<
			| { status: "ok"; material?: string }
			| { status: "denied"; reason: string; code: string }
		>
	>;
}>;

/** The latest value of a secret; undefined when it does not exist. */
export async function readSecret(
	secrets: SecretsLike,
	name: string,
): Promise<Outcome<string | undefined>> {
	const result = await secrets.access(name);
	if (result.status === "denied")
		return result.code === NOT_FOUND
			? { ok: true, value: undefined }
			: {
					ok: false,
					error: {
						code: "unavailable",
						message: `the secret store refused ${name}: ${result.code}`,
					},
				};
	return { ok: true, value: result.material };
}

function heldOf(value: JsonObject): HeldKey | undefined {
	const kid = stringField(value, "kid");
	const seed = stringField(value, "seed");
	const publicKey = stringField(value, "publicKey");
	return kid === undefined || seed === undefined || publicKey === undefined
		? undefined
		: { kid, seed, publicKey };
}

export function parseSlot(text: string): KeySlot | undefined {
	const value = parseJson(text);
	if (!isJsonObject(value) || numberField(value, "v") !== 1) return undefined;
	const active = stringField(value, "active");
	const list = value.keys;
	if (active === undefined || !isJsonArray(list)) return undefined;
	const keys: HeldKey[] = [];
	for (const item of list) {
		const held = isJsonObject(item) ? heldOf(item) : undefined;
		if (held === undefined) return undefined;
		keys.push(held);
	}
	return keys.some((key) => key.kid === active) ? { active, keys } : undefined;
}

export function slotText(slot: KeySlot): string {
	return JSON.stringify({
		v: 1,
		active: slot.active,
		keys: slot.keys.map((key) => ({
			kid: key.kid,
			seed: key.seed,
			publicKey: key.publicKey,
		})),
	});
}

export async function readSlot(
	secrets: SecretsLike,
	prefix: string,
	which: RotatableKey,
): Promise<Outcome<KeySlot | undefined>> {
	const name = slotName(prefix, which);
	const text = await readSecret(secrets, name);
	if (!text.ok) return text;
	if (text.value === undefined) return { ok: true, value: undefined };
	const slot = parseSlot(text.value);
	return slot === undefined
		? {
				ok: false,
				error: {
					code: "invalid-request",
					message: `the secret ${name} is not a key slot`,
				},
			}
		: { ok: true, value: slot };
}

export async function writeSlot(
	secrets: SecretsLike,
	prefix: string,
	which: RotatableKey,
	slot: KeySlot,
): Promise<void> {
	await secrets.put(slotName(prefix, which), slotText(slot));
}

/** The next key id of a slot: `<stem>#<n+1>` after the highest held. */
export function nextKid(
	which: RotatableKey,
	slot: KeySlot | undefined,
): string {
	const stem = KEY_KINDS[which].stem;
	let highest = 0;
	for (const key of slot?.keys ?? []) {
		const n = Number(key.kid.slice(key.kid.lastIndexOf("#") + 1));
		if (Number.isSafeInteger(n) && n > highest) highest = n;
	}
	return `${stem}#${highest + 1}`;
}

/** A fresh key of the slot's family. The RSA token-signing key is not made here. */
export function freshKey(which: RotatableKey, kid: string): HeldKey {
	const seed = freshSeed();
	const family = KEY_KINDS[which].family;
	if (family === "nkey-operator" || family === "nkey-account") {
		const role = family === "nkey-operator" ? "operator" : "account";
		return {
			kid,
			seed: encodeNkeySeed(role, seed),
			publicKey: encodeNkeyPublic(role, seed),
		};
	}
	return {
		kid,
		seed: Buffer.from(seed).toString("base64url"),
		publicKey: Buffer.from(rawPublicKey(seed)).toString("base64url"),
	};
}

export function activeKey(slot: KeySlot): HeldKey {
	const key = slot.keys.find((candidate) => candidate.kid === slot.active);
	// parseSlot and every writer keep the active kid among the keys.
	if (key === undefined) throw new Error(`slot names no key ${slot.active}`);
	return key;
}

/** An Ed25519 `Signer` over one held key of an ed25519 slot. */
export function signerOf(key: HeldKey): Signer {
	const seed = new Uint8Array(Buffer.from(key.seed, "base64url"));
	return {
		keyId: parseKeyId(key.kid),
		algorithm: KeyAlgorithm.EDDSA,
		sign: async (bytes) => signWithSeed(seed, bytes),
	};
}

/** The trust record's `PublicKeyRef` of an ed25519 key. */
export function keyRefOf(key: HeldKey, purpose: KeyPurpose): PublicKeyRef {
	return create(PublicKeyRefSchema, {
		purpose,
		keyId: key.kid,
		algorithm: KeyAlgorithm.EDDSA,
		value: key.publicKey,
	});
}
