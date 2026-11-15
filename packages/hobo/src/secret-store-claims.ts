import type { OpenedSecretStore } from "@hobo/hobo-ci";
import type { IdempotencyRecord, IdempotencyStore } from "@hobo/provider-neon";
import { z } from "zod";

// A durable, owner-scoped idempotency store for creates that have no
// server-side idempotency (Neon Claimable Postgres), kept in the owner's
// secret store so every machine signed in to it sees the same claims.
//
// Each attempt at an intent is its own entry, `<prefix><intent>.<n>`, made
// with the store's atomic create-if-absent (`SecretsPort.createOnly`): of two
// machines claiming attempt n, exactly one creates it, and the other sees the
// winner's record. A definitely failed attempt is followed by attempt n + 1;
// an in-flight one is never taken over, so a crash mid-create is adopted or
// refused, never repeated. Records (and the database ids in them) stay in
// private custody: the secret store.
//
// A store that cannot create atomically has no `createOnly`, and this refuses
// it rather than emulating a claim with read-then-write.

const Attempt = z
	.object({
		key: z.string().min(1),
		state: z.enum(["in-flight", "created", "failed"]),
		ref: z.string().min(1),
		attemptedAtMs: z.number().int().nonnegative(),
		databaseId: z.string().min(1).optional(),
	})
	.strict();

/** The longest run of failed attempts read before giving up on an intent. */
const MAX_ATTEMPTS = 64;

export class ClaimStoreUnavailableError extends Error {
	constructor(store: string) {
		super(
			`${store} offers no verified atomic create, so it cannot hold a provisioning claim; provision the database yourself and keep its connection string in the store, or use a store that does.`,
		);
		this.name = "ClaimStoreUnavailableError";
	}
}

/** The idempotency store, marked durable for callers that require one. */
export type DurableClaimStore = IdempotencyStore & {
	readonly durability: "durable";
};

function entryName(prefix: string, key: string, attempt: number): string {
	// Store names are identifiers: the intent key's other characters go.
	const safe = key.replace(/[^A-Za-z0-9_]/gu, "_").toUpperCase();
	return `${prefix}${safe}_${attempt}`;
}

export function secretStoreClaims(
	store: OpenedSecretStore,
	options: { readonly prefix: string; readonly allowFixture?: boolean },
): DurableClaimStore {
	const createOnly = store.port.createOnly?.bind(store.port);
	if (
		createOnly === undefined ||
		(store.port.kind === "memory-fixture" && options.allowFixture !== true)
	)
		throw new ClaimStoreUnavailableError(store.id);

	const read = async (
		key: string,
		attempt: number,
	): Promise<IdempotencyRecord | undefined> => {
		const result = await store.port.access(
			entryName(options.prefix, key, attempt),
		);
		if (result.status !== "ok") {
			if (result.code === "secret-not-found") return undefined;
			throw new Error(`Cannot read the provisioning claim from ${store.id}.`);
		}
		const parsed = Attempt.safeParse(JSON.parse(result.material ?? "null"));
		if (!parsed.success)
			throw new Error(`The provisioning claim in ${store.id} is not valid.`);
		const { databaseId, ...rest } = parsed.data;
		return databaseId === undefined ? rest : { ...rest, databaseId };
	};

	/** The newest attempt and its number, or none. */
	const latest = async (key: string) => {
		let found: { record: IdempotencyRecord; attempt: number } | undefined;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
			const record = await read(key, attempt);
			if (record === undefined) return found;
			found = { record, attempt };
		}
		throw new Error(
			`The provisioning intent ${key} has failed ${MAX_ATTEMPTS} times; resolve it before trying again.`,
		);
	};

	return {
		visibility: "private-custody",
		durability: "durable",
		async get(key) {
			return (await latest(key))?.record;
		},
		async claim(record) {
			const newest = await latest(record.key);
			if (newest !== undefined && newest.record.state !== "failed")
				return false;
			const attempt = (newest?.attempt ?? 0) + 1;
			const outcome = await createOnly(
				entryName(options.prefix, record.key, attempt),
				JSON.stringify(record),
			);
			return outcome.created;
		},
		async put(record) {
			// Only the claim's owner writes after claiming: it updates its own attempt.
			const newest = await latest(record.key);
			if (newest === undefined)
				throw new Error(
					`No claim is held for ${record.key}; claim before recording an outcome.`,
				);
			await store.port.put(
				entryName(options.prefix, record.key, newest.attempt),
				JSON.stringify(record),
			);
		},
	};
}
