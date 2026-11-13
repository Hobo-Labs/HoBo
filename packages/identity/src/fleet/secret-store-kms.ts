// The authority's token-signing key ring, held in the secret store (design
// §6.6, D32). `KmsLike` is synchronous (R7), so the ring is read once at start
// and held in memory; a rotation is written back to the store in the
// background.
//
// Layout: one secret, named by `prefix`, whose value is JSON
//   { "keys": [ { "kid": "...", "privateKey": "<PKCS#8 PEM>", "retiredAt": <epoch ms>? } ] }
// The first key is created with kid `<prefix>#1`; callers rotate with
// `<prefix>#<n+1>`. The active key (`activeKeyId`) is the lowest-numbered key
// that is not retired, which follows the rotation order add, publish, switch,
// remove: an added and published key waits beside the one that still signs
// until the switch retires that one. `generateRsaKey` adds and switches in
// one step: it retires every older key. A retired key stops signing at once
// and stays in the key set (`keyIds`) until every token it can have signed
// has expired (TOKEN_LIFETIME_MS after its retirement), then it is dropped.
import {
	createPrivateKey,
	createPublicKey,
	createSign,
	generateKeyPairSync,
	type KeyObject,
} from "node:crypto";
import { JWT_ALGORITHM, type KmsLike } from "../issuer.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonValue,
} from "../json.js";
import type { SecretsPort } from "../secrets-port.js";

/** The longest lifetime of any token the authority signs: person tokens and JWT-SVIDs are 15 minutes (§6.6). */
export const TOKEN_LIFETIME_MS = 15 * 60 * 1000;

const NOT_FOUND = "secret-not-found";

type RingEntry = Readonly<{
	kid: string;
	privateKey: string;
	retiredAt?: number;
}>;

type HeldKey = {
	readonly kid: string;
	readonly pem: string;
	readonly privateKey: KeyObject;
	readonly publicKey: KeyObject;
	retiredAt?: number;
};

export async function loadKeyRing(
	secrets: SecretsPort,
	prefix: string,
): Promise<KmsLike> {
	if (prefix.length === 0) throw new Error("a key ring needs a prefix");
	const stored = await readSecret(secrets, prefix);
	if (stored !== undefined) {
		return heldRing(secrets, prefix, parseRing(stored));
	}
	return heldRing(secrets, prefix, await createOnce(secrets, prefix));
}

/**
 * Writes a one-key ring and then adopts whichever ring was written first, so
 * replicas that start together converge on one key; a loser writes the
 * winner back so the latest version is the winner's.
 */
async function createOnce(
	secrets: SecretsPort,
	prefix: string,
): Promise<readonly RingEntry[]> {
	const ours = serialiseRing([freshEntry(`${prefix}#1`)]);
	await secrets.put(prefix, ours);
	const versions = await secrets.listVersions(prefix);
	const first =
		versions.length === 0
			? ours
			: ((await readSecret(secrets, prefix, versions[0])) ?? ours);
	if (first !== ours) await secrets.put(prefix, first);
	return parseRing(first);
}

function heldRing(
	secrets: SecretsPort,
	prefix: string,
	entries: readonly RingEntry[],
): KmsLike {
	const keys = new Map<string, HeldKey>();
	const now = Date.now();
	for (const entry of entries) {
		if (isLive(entry.retiredAt, now)) keys.set(entry.kid, holdEntry(entry));
	}
	if (keys.size === 0) throw new Error(`key ring ${prefix} holds no live key`);

	let writing: Promise<void> = Promise.resolve();
	const persist = (): void => {
		writing = writing.then(() =>
			writeBack(secrets, prefix, keys).catch(() => {
				// The ring is written whole and merged on every write, so the next
				// rotation retries this one. Nothing here may log key material.
			}),
		);
	};

	const live = (kid: string): HeldKey | undefined => {
		const key = keys.get(kid);
		return key !== undefined && isLive(key.retiredAt, Date.now())
			? key
			: undefined;
	};

	const liveKids = (): string[] =>
		[...keys.values()]
			.filter((key) => isLive(key.retiredAt, Date.now()))
			.map((key) => key.kid)
			.sort(byKeyNumber);

	return {
		hasKey(kid) {
			return live(kid) !== undefined;
		},
		keyIds: liveKids,
		activeKeyId() {
			const active = liveKids().find(
				(kid) => keys.get(kid)?.retiredAt === undefined,
			);
			if (active === undefined)
				throw new Error(`key ring ${prefix} has no active key`);
			return active;
		},
		generateRsaKey(kid) {
			if (keys.has(kid)) throw new Error(`KMS key already exists: ${kid}`);
			const retiredAt = Date.now();
			for (const key of keys.values()) {
				if (key.retiredAt === undefined) key.retiredAt = retiredAt;
			}
			keys.set(kid, holdEntry(freshEntry(kid)));
			persist();
		},
		sign(kid, payload) {
			const key = live(kid);
			if (key === undefined) throw new Error(`unknown KMS key: ${kid}`);
			if (key.retiredAt !== undefined) {
				throw new Error(`KMS key ${kid} is retired and no longer signs`);
			}
			return createSign("RSA-SHA256")
				.update(payload)
				.end()
				.sign(key.privateKey);
		},
		publicJwk(kid) {
			const key = live(kid);
			if (key === undefined) throw new Error(`unknown KMS key: ${kid}`);
			return {
				...key.publicKey.export({ format: "jwk" }),
				kid,
				alg: JWT_ALGORITHM,
				use: "sig",
			};
		},
	};
}

/** Merges this process's keys into the stored ring (ours win on retirement), drops expired keys, writes it whole. */
async function writeBack(
	secrets: SecretsPort,
	prefix: string,
	keys: ReadonlyMap<string, HeldKey>,
): Promise<void> {
	const stored = await readSecret(secrets, prefix);
	const merged = new Map<string, RingEntry>();
	for (const entry of stored === undefined ? [] : parseRing(stored)) {
		merged.set(entry.kid, entry);
	}
	for (const key of keys.values()) {
		merged.set(key.kid, toEntry(key));
	}
	const now = Date.now();
	await secrets.put(
		prefix,
		serialiseRing(
			[...merged.values()].filter((entry) => isLive(entry.retiredAt, now)),
		),
	);
}

async function readSecret(
	secrets: SecretsPort,
	name: string,
	versionId?: string,
): Promise<string | undefined> {
	const result =
		versionId === undefined
			? await secrets.access(name)
			: await secrets.accessVersion(name, versionId);
	if (result.status === "denied") {
		if (result.code === NOT_FOUND) return undefined;
		throw new Error(`secret store refused ${name}: ${result.code}`);
	}
	if (result.material === undefined) {
		throw new Error(`secret store returned no material for ${name}`);
	}
	return result.material;
}

/** The `n` of a `<prefix>#<n>` key id; ids without one sort after every numbered id. */
function keyNumber(kid: string): number {
	const n = Number(kid.slice(kid.lastIndexOf("#") + 1));
	return kid.includes("#") && Number.isSafeInteger(n) && n >= 0
		? n
		: Number.POSITIVE_INFINITY;
}

function byKeyNumber(a: string, b: string): number {
	const difference = keyNumber(a) - keyNumber(b);
	return Number.isNaN(difference) || difference === 0
		? a.localeCompare(b)
		: difference;
}

function isLive(retiredAt: number | undefined, now: number): boolean {
	return retiredAt === undefined || now < retiredAt + TOKEN_LIFETIME_MS;
}

function freshEntry(kid: string): RingEntry {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	return {
		kid,
		privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
	};
}

function holdEntry(entry: RingEntry): HeldKey {
	const privateKey = createPrivateKey(entry.privateKey);
	if (privateKey.asymmetricKeyType !== "rsa") {
		throw new Error(`key ring entry ${entry.kid} is not an RSA key`);
	}
	const held: HeldKey = {
		kid: entry.kid,
		pem: entry.privateKey,
		privateKey,
		publicKey: createPublicKey(privateKey),
	};
	if (entry.retiredAt !== undefined) held.retiredAt = entry.retiredAt;
	return held;
}

function toEntry(key: HeldKey): RingEntry {
	return key.retiredAt === undefined
		? { kid: key.kid, privateKey: key.pem }
		: { kid: key.kid, privateKey: key.pem, retiredAt: key.retiredAt };
}

function serialiseRing(entries: readonly RingEntry[]): string {
	return JSON.stringify({ keys: entries });
}

function parseRing(text: string): readonly RingEntry[] {
	const notRing = new Error("secret store value is not a key ring");
	const value = parseJsonValue(text);
	if (!isJsonObject(value) || !isJsonArray(value.keys)) throw notRing;
	return value.keys.map((item) => {
		if (!isJsonObject(item)) throw notRing;
		return parseEntry(item, notRing);
	});
}

function parseEntry(item: JsonObject, notRing: Error): RingEntry {
	const { kid, privateKey, retiredAt } = item;
	if (!isJsonString(kid) || kid.length === 0) throw notRing;
	if (!isJsonString(privateKey) || privateKey.length === 0) throw notRing;
	if (retiredAt === undefined) return { kid, privateKey };
	if (!isJsonNumber(retiredAt)) throw notRing;
	return { kid, privateKey, retiredAt };
}
