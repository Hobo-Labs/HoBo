/**
 * Reading the authority's keys from the secret store (§6.16): one secret per
 * key, `<secretPrefix>/<which>`, in the slot layout the operations write
 * (`{ "v": 1, "active": "<kid>", "keys": [{ "kid", "seed", "publicKey" }] }`,
 * Ed25519 seeds as raw base64url, NATS keys as nkey text). The record-signing
 * and witness signers are re-read from their slots after a rotation switches
 * the active key (carry-forward rule 2 of L27). Nothing here logs a seed.
 */
import { createPrivateKey, sign } from "node:crypto";
import {
	KeyAlgorithm,
	type Outcome,
	parseKeyId,
	type Signer,
} from "@hobo/fleet";
import type { SecretsPort } from "@hobo/identity";

const NOT_FOUND = "secret-not-found";
const ED25519_PKCS8_PREFIX = Buffer.from(
	"302e020100300506032b657004220420",
	"hex",
);
const tagOf = Object.prototype.toString;

function unavailable<T>(message: string): Outcome<T> {
	return { ok: false, error: { code: "unavailable", message } };
}

/** The latest value of a secret; undefined when there is none. */
export async function readSecretText(
	secrets: SecretsPort,
	name: string,
): Promise<Outcome<string | undefined>> {
	const result = await secrets.access(name);
	if (result.status === "denied")
		return result.code === NOT_FOUND
			? { ok: true, value: undefined }
			: unavailable(`the secret store refused ${name}: ${result.code}`);
	return { ok: true, value: result.material };
}

export async function requireSecret(
	secrets: SecretsPort,
	name: string,
): Promise<Outcome<string>> {
	const text = await readSecretText(secrets, name);
	if (!text.ok) return text;
	return text.value === undefined || text.value.length === 0
		? {
				ok: false,
				error: {
					code: "invalid-request",
					message: `the secret ${name} is missing`,
				},
			}
		: { ok: true, value: text.value };
}

// domain-view: the active key of a slot secret.
export type ActiveKey = Readonly<{
	kid: string;
	seed: string;
	publicKey: string;
}>;

/** The active key of the slot `<prefix>/<which>`. */
export async function readActiveKey(
	secrets: SecretsPort,
	prefix: string,
	which: string,
): Promise<Outcome<ActiveKey>> {
	const name = `${prefix}/${which}`;
	const text = await requireSecret(secrets, name);
	if (!text.ok) return text;
	let parsed: Readonly<
		Record<
			string,
			string | number | readonly Readonly<Record<string, string>>[]
		>
	>;
	try {
		parsed = JSON.parse(text.value);
	} catch {
		return {
			ok: false,
			error: {
				code: "invalid-request",
				message: `the secret ${name} is not a key slot`,
			},
		};
	}
	const keys = parsed.keys;
	const active = parsed.active;
	const found = Array.isArray(keys)
		? keys.find((key) => key.kid === active)
		: undefined;
	if (
		parsed.v !== 1 ||
		found === undefined ||
		tagOf.call(found.seed) !== "[object String]" ||
		tagOf.call(found.kid) !== "[object String]"
	)
		return {
			ok: false,
			error: {
				code: "invalid-request",
				message: `the secret ${name} is not a key slot`,
			},
		};
	return {
		ok: true,
		value: {
			kid: found.kid ?? "",
			seed: found.seed ?? "",
			publicKey: found.publicKey ?? "",
		},
	};
}

/** An Ed25519 signer from a raw 32-byte seed (base64url). */
export function ed25519Signer(kid: string, seed: string): Signer {
	const raw = Buffer.from(seed, "base64url");
	if (raw.length !== 32)
		throw new Error(`key ${kid} is not a 32-byte Ed25519 seed`);
	const privateKey = createPrivateKey({
		key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]),
		format: "der",
		type: "pkcs8",
	});
	return {
		keyId: parseKeyId(kid),
		algorithm: KeyAlgorithm.EDDSA,
		sign: async (bytes) => new Uint8Array(sign(null, bytes, privateKey)),
	};
}

/**
 * A signer that always signs with the slot's active key: it re-reads the slot
 * at most once per `refreshMs`, so a rotation's switch takes effect without a
 * restart. Its `keyId` is the key id at the time of each read.
 */
export async function slotSigner(
	secrets: SecretsPort,
	prefix: string,
	which: "record-signing" | "witness",
	now: () => number,
	refreshMs = 60_000,
): Promise<Outcome<Readonly<{ current(): Signer; refresh(): Promise<void> }>>> {
	const first = await readActiveKey(secrets, prefix, which);
	if (!first.ok) return first;
	let signer = ed25519Signer(first.value.kid, first.value.seed);
	let readAt = now();
	const refresh = async () => {
		const next = await readActiveKey(secrets, prefix, which);
		readAt = now();
		if (next.ok && next.value.kid !== signer.keyId)
			signer = ed25519Signer(next.value.kid, next.value.seed);
	};
	return {
		ok: true,
		value: {
			current() {
				if (now() - readAt >= refreshMs) void refresh().catch(() => {});
				return signer;
			},
			refresh,
		},
	};
}

/** A `Signer` whose key follows `current()` at every signature. */
export function followingSigner(
	source: Readonly<{ current(): Signer }>,
): Signer {
	return {
		get keyId() {
			return source.current().keyId;
		},
		get algorithm() {
			return source.current().algorithm;
		},
		sign: (bytes) => source.current().sign(bytes),
	};
}
