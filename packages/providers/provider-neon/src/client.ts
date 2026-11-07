/**
 * The REST client: idempotency, adoption, and bounded retry.
 *
 * `POST /api/v1/database` has no server-side idempotency key, so duplicate
 * suppression has to be local. The rule this client enforces is that a create
 * is attempted at most once per idempotency key, ever. A repeat call either
 * adopts the resource the first attempt produced or refuses — it never creates
 * a second database to resolve an ambiguous first one, because an orphaned
 * anonymous Postgres is invisible: there is no account to find it in.
 */

import { type NeonDatabaseResponse, parseNeonDatabaseResponse } from "./api.js";
import {
	NeonProviderError,
	providerErrorForStatus,
	redactProviderText,
} from "./errors.js";
import {
	createGuardedTransport,
	DEFAULT_TRANSPORT_POLICY,
	type NeonTransport,
	type TransportPolicy,
} from "./transport.js";

// public-contract: documented Neon claim API endpoint used by adapters.
export const NEON_CLAIMABLE_API_BASE = "https://neon.new/api/v1";

export type IdempotencyState = "in-flight" | "created" | "failed";

export type IdempotencyRecord = {
	readonly key: string;
	readonly state: IdempotencyState;
	readonly ref: string;
	readonly attemptedAtMs: number;
	readonly databaseId?: string;
};

export interface IdempotencyStore {
	/** Native keys and ids are bearer capabilities: this cache is private custody, never public events. */
	readonly visibility: "private-custody";
	get(key: string): Promise<IdempotencyRecord | undefined>;
	put(record: IdempotencyRecord): Promise<void>;
	/** Atomically claim an absent or definitely failed intent. Durable stores must CAS. */
	claim(record: IdempotencyRecord): Promise<boolean>;
}

export function createInMemoryIdempotencyStore(
	seed: readonly IdempotencyRecord[] = [],
): IdempotencyStore {
	const records = new Map<string, IdempotencyRecord>(
		seed.map((record) => [record.key, record]),
	);
	return {
		visibility: "private-custody",
		async claim(record) {
			const previous = records.get(record.key);
			if (previous !== undefined && previous.state !== "failed") return false;
			records.set(record.key, structuredClone(record));
			return true;
		},
		async get(key) {
			const record = records.get(key);
			return record === undefined ? undefined : structuredClone(record);
		},
		async put(record) {
			records.set(record.key, structuredClone(record));
		},
	};
}

export type CreateDatabaseInput = {
	/** Referrer identifier required by the API. Non-secret, and it is logged. */
	readonly ref: string;
	/** Stable per-intent key. Reusing it adopts; changing it creates. */
	readonly idempotencyKey: string;
	readonly enableLogicalReplication?: boolean;
};

export type CreateDatabaseOutcome = {
	readonly response: NeonDatabaseResponse;
	/** True when a previous attempt created it and this call only observed. */
	readonly adopted: boolean;
};

export type NeonClientOptions = {
	readonly transport: NeonTransport;
	readonly store: IdempotencyStore;
	/** Injected clock. Nothing in this package reads `Date.now()` directly. */
	readonly clock: () => number;
	readonly policy?: TransportPolicy;
	readonly baseUrl?: string;
	readonly sleep?: (ms: number) => Promise<void>;
	/** Read attempts, including the first. Creates are always exactly one. */
	readonly maxReadAttempts?: number;
	readonly retryBaseDelayMs?: number;
	readonly userAgent?: string;
};

export type NeonClient = {
	createDatabase(input: CreateDatabaseInput): Promise<CreateDatabaseOutcome>;
	getDatabase(databaseId: string): Promise<NeonDatabaseResponse>;
};

const REF = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,63}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const DATABASE_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Provider-local validation shared by client and resolver before mutation custody. */
export function validateCreateDatabaseInput(input: CreateDatabaseInput): void {
	if (!REF.test(input.ref))
		throw new NeonProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"referrer must be a short identifier; the provider rejects an empty ref with 400",
		);
	if (!IDEMPOTENCY_KEY.test(input.idempotencyKey))
		throw new NeonProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"idempotency key must be 8-128 identifier characters",
		);
}

function retryAfterMs(
	headers: Readonly<Record<string, string>>,
	now: number,
): number | undefined {
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== "retry-after") continue;
		const seconds = Number(value);
		if (Number.isFinite(seconds) && seconds >= 0)
			return Math.min(seconds, 300) * 1000;
		const at = Date.parse(value);
		if (Number.isFinite(at)) return Math.min(300_000, Math.max(0, at - now));
	}
	return undefined;
}

export function createNeonClient(options: NeonClientOptions): NeonClient {
	if (options.store.visibility !== "private-custody")
		throw new NeonProviderError(
			"SECRET_CUSTODY_UNAVAILABLE",
			"native idempotency state requires private custody; public event stores are forbidden",
		);
	if (!(options.store.claim instanceof Function))
		throw new NeonProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"anonymous database creation requires an atomic idempotency claim store",
		);
	const policy = options.policy ?? DEFAULT_TRANSPORT_POLICY;
	const transport = createGuardedTransport(options.transport, policy);
	const baseUrl = options.baseUrl ?? NEON_CLAIMABLE_API_BASE;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const maxReadAttempts = Math.max(
		1,
		Math.min(options.maxReadAttempts ?? 3, 6),
	);
	const retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
	const headers = {
		"content-type": "application/json",
		accept: "application/json",
		"user-agent": options.userAgent ?? "hobo-provider-neon/0.0.1",
	};

	async function getDatabase(
		databaseId: string,
	): Promise<NeonDatabaseResponse> {
		if (!DATABASE_ID.test(databaseId)) {
			throw new NeonProviderError(
				"PROVIDER_CONTRACT_CHANGED",
				"database id must be a UUID before it is placed in a request path",
			);
		}
		let lastError: NeonProviderError | undefined;
		for (let attempt = 0; attempt < maxReadAttempts; attempt += 1) {
			if (attempt > 0)
				await sleep(
					Math.max(
						retryBaseDelayMs * 2 ** (attempt - 1),
						lastError?.retryAfterMs ?? 0,
					),
				);
			const response = await transport.request({
				method: "GET",
				url: `${baseUrl}/database/${databaseId}`,
				headers,
				timeoutMs: policy.timeoutMs,
				maxResponseBytes: policy.maxResponseBytes,
			});
			if (response.status === 200) {
				const observed = parseNeonDatabaseResponse(response.body);
				if (observed.databaseId.toLowerCase() !== databaseId.toLowerCase())
					throw new NeonProviderError(
						"PROVISIONING_CONFLICT",
						"provider observation returned a foreign database identity",
					);
				return observed;
			}
			if (response.status === 404 || response.status === 400) {
				throw new NeonProviderError(
					"PROVISIONING_CONFLICT",
					`claimable database ${databaseId} is not present at the provider`,
					{ detail: { status: response.status, databaseId } },
				);
			}
			const retryAfter = retryAfterMs(response.headers, options.clock());
			const error = providerErrorForStatus(response.status, {
				method: "GET",
				body: response.body,
				...(retryAfter !== undefined
					? { retryAfterMs: retryAfter }
					: undefined),
			});
			if (!error.retryable) throw error;
			lastError = error;
		}
		throw (
			lastError ??
			new NeonProviderError(
				"PROVIDER_CONTRACT_CHANGED",
				"read of the claimable database failed",
			)
		);
	}

	async function createDatabase(
		input: CreateDatabaseInput,
	): Promise<CreateDatabaseOutcome> {
		validateCreateDatabaseInput(input);

		const existing = await options.store.get(input.idempotencyKey);
		if (existing?.databaseId !== undefined) {
			// Adopt: a previous attempt got as far as an id, so the resource
			// exists and observing it is the only correct move.
			return {
				response: await getDatabase(existing.databaseId),
				adopted: true,
			};
		}
		if (existing?.state === "in-flight") {
			throw new NeonProviderError(
				"PROVIDER_OPERATION_AMBIGUOUS",
				"a previous create with this idempotency key did not resolve; observe or adopt it before creating, because a second create would orphan an anonymous database",
				{
					detail: {
						idempotencyKey: input.idempotencyKey,
						attemptedAtMs: existing.attemptedAtMs,
					},
				},
			);
		}

		const claimed = await options.store.claim({
			key: input.idempotencyKey,
			state: "in-flight",
			ref: input.ref,
			attemptedAtMs: options.clock(),
		});
		if (!claimed)
			throw new NeonProviderError(
				"PROVIDER_OPERATION_AMBIGUOUS",
				"another worker owns this create intent; observe it before any further mutation",
			);

		let response: Awaited<ReturnType<NeonTransport["request"]>>;
		try {
			response = await transport.request({
				method: "POST",
				url: `${baseUrl}/database`,
				headers,
				body: JSON.stringify({
					ref: input.ref,
					...(input.enableLogicalReplication !== undefined
						? { enable_logical_replication: input.enableLogicalReplication }
						: undefined),
				}),
				timeoutMs: policy.timeoutMs,
				maxResponseBytes: policy.maxResponseBytes,
			});
		} catch (cause) {
			// Left in-flight on purpose: the next call must adopt or refuse.
			if (cause instanceof NeonProviderError) throw cause;
			throw new NeonProviderError(
				"PROVIDER_OPERATION_AMBIGUOUS",
				"the create request did not complete; the database may or may not exist",
				{
					cause: cause instanceof Error ? cause : new Error(String(cause)),
					detail: { idempotencyKey: input.idempotencyKey },
				},
			);
		}

		if (response.status === 200 || response.status === 201) {
			const parsed = parseNeonDatabaseResponse(response.body);
			await options.store.put({
				key: input.idempotencyKey,
				state: "created",
				ref: input.ref,
				attemptedAtMs: options.clock(),
				databaseId: parsed.databaseId,
			});
			return { response: parsed, adopted: false };
		}

		const retryAfter = retryAfterMs(response.headers, options.clock());
		const error = providerErrorForStatus(response.status, {
			method: "POST",
			body: response.body,
			...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : undefined),
		});
		if (error.code === "PROVIDER_OPERATION_AMBIGUOUS") {
			// Deliberately left in-flight.
			throw error;
		}
		if (response.status === 400) {
			await options.store.put({
				key: input.idempotencyKey,
				state: "failed",
				ref: input.ref,
				attemptedAtMs: options.clock(),
			});
			throw new NeonProviderError(
				"PROVIDER_CONTRACT_CHANGED",
				`claimable-database rejected the create request: ${redactProviderText(response.body, 120)}`,
				{ detail: { status: 400 } },
			);
		}
		// 429 and other definite non-creating failures release the key.
		await options.store.put({
			key: input.idempotencyKey,
			state: "failed",
			ref: input.ref,
			attemptedAtMs: options.clock(),
		});
		throw error;
	}

	return { createDatabase, getDatabase };
}
