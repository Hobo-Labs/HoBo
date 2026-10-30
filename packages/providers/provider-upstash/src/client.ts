/**
 * The control-plane client: idempotency, adoption, and bounded retry.
 *
 * `POST https://upstash.com/start-redis` accepts an `Idempotency-Key`, and the
 * provider derives the database id from it, so a repeat POST with the same key
 * returns the same database rather than making another one. That is a stronger
 * guarantee than most anonymous surfaces offer, and this client is built around
 * it: **adoption is a re-POST with the original key**, never a fresh create.
 *
 * The reason to be strict about that is that an orphaned anonymous Redis is
 * invisible. There is no account to list it in and no delete endpoint, so a
 * duplicate created while resolving an ambiguous timeout is not a tidy-up
 * problem — it is a live, credentialed database nobody will ever find again,
 * sitting there until the provider reaps it.
 *
 * A local store still exists, but it does a different job than Neon's: it
 * remembers which key was used so a caller that lost its response can adopt,
 * and it refuses to let one intent quietly become two keys.
 */
import {
	providerErrorForStatus,
	redactProviderText,
	UpstashProviderError,
} from "./errors.js";
import {
	parseStartRedisMetrics,
	parseStartRedisResponse,
	type StartRedisDatabase,
	type StartRedisMetrics,
} from "./start-redis.js";
import {
	createGuardedTransport,
	type TransportPolicy,
	UPSTASH_CONTROL_PLANE_POLICY,
	type UpstashTransport,
} from "./transport.js";

// public-contract: the provider endpoint this client is written against.
export const UPSTASH_START_REDIS_URL =
	"https://upstash.com/start-redis" as const;

export type IdempotencyState = "in-flight" | "created" | "failed";

export type IdempotencyRecord = {
	readonly key: string;
	readonly state: IdempotencyState;
	readonly attemptedAtMs: number;
	readonly databaseId?: string;
};

export interface IdempotencyStore {
	/** Native keys and ids are bearer capabilities: this cache is private custody, never public events. */
	readonly visibility: "private-custody";
	get(key: string): Promise<IdempotencyRecord | undefined>;
	put(record: IdempotencyRecord): Promise<void>;
}

export function createInMemoryIdempotencyStore(
	seed: readonly IdempotencyRecord[] = [],
): IdempotencyStore {
	const records = new Map<string, IdempotencyRecord>(
		seed.map((r) => [r.key, r]),
	);
	return {
		visibility: "private-custody",
		async get(key) {
			return records.get(key);
		},
		async put(record) {
			records.set(record.key, record);
		},
	};
}

export type CreateDatabaseInput = {
	/**
	 * A UUIDv4. The provider uses it as the database id, so it is both the
	 * dedupe key and the resource identity — which is why this client will not
	 * accept an arbitrary string for it.
	 */
	readonly idempotencyKey: string;
};

export type CreateDatabaseOutcome = {
	readonly database: StartRedisDatabase;
	/** True when the provider returned an existing database for this key. */
	readonly adopted: boolean;
};

export type UpstashClientOptions = {
	readonly transport: UpstashTransport;
	readonly store: IdempotencyStore;
	/** Injected clock. Nothing in this package reads `Date.now()` directly. */
	readonly clock: () => number;
	readonly policy?: TransportPolicy;
	readonly baseUrl?: string;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly maxReadAttempts?: number;
	readonly retryBaseDelayMs?: number;
	readonly userAgent?: string;
};

export type UpstashClient = {
	createDatabase(input: CreateDatabaseInput): Promise<CreateDatabaseOutcome>;
	/**
	 * Re-POST a known key to observe the database it names.
	 *
	 * This is the adoption primitive, and it is exposed because "did my create
	 * actually happen" is a question a caller has to be able to ask without
	 * risking a second database.
	 */
	adoptDatabase(idempotencyKey: string): Promise<StartRedisDatabase>;
	getMetrics(
		metricsUrl: string,
		databaseId: string,
	): Promise<StartRedisMetrics>;
};

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function assertIdempotencyKey(key: string): void {
	if (!UUID_V4.test(key)) {
		throw new UpstashProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"idempotency key must be a lowercase UUIDv4; the provider derives the database id from it",
		);
	}
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

export function createUpstashClient(
	options: UpstashClientOptions,
): UpstashClient {
	if (options.store.visibility !== "private-custody")
		throw new UpstashProviderError(
			"SECRET_CUSTODY_UNAVAILABLE",
			"native idempotency state requires private custody; public event stores are forbidden",
		);
	const policy = options.policy ?? UPSTASH_CONTROL_PLANE_POLICY;
	const transport = createGuardedTransport(options.transport, policy);
	const baseUrl = options.baseUrl ?? UPSTASH_START_REDIS_URL;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const maxReadAttempts = Math.max(
		1,
		Math.min(options.maxReadAttempts ?? 3, 6),
	);
	const retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
	const userAgent = options.userAgent ?? "hobo-provider-upstash/0.0.1";

	function postHeaders(idempotencyKey: string) {
		return {
			accept: "text/markdown, text/plain;q=0.9, */*;q=0.1",
			"idempotency-key": idempotencyKey,
			"user-agent": userAgent,
		};
	}

	async function post(idempotencyKey: string): Promise<StartRedisDatabase> {
		let response: Awaited<ReturnType<UpstashTransport["request"]>>;
		try {
			response = await transport.request({
				method: "POST",
				url: baseUrl,
				headers: postHeaders(idempotencyKey),
				timeoutMs: policy.timeoutMs,
				maxResponseBytes: policy.maxResponseBytes,
			});
		} catch (cause) {
			if (cause instanceof UpstashProviderError) throw cause;
			throw new UpstashProviderError(
				"PROVIDER_OPERATION_AMBIGUOUS",
				"the create request did not complete; re-POST the same idempotency key to find out whether the database exists",
				{
					cause: cause instanceof Error ? cause : new Error(String(cause)),
					detail: { idempotencyKey },
				},
			);
		}

		if (response.status === 200 || response.status === 201) {
			const parsed = parseStartRedisResponse(response.body);
			if (parsed.databaseId !== idempotencyKey) {
				// The provider documents the key as becoming the id. If that
				// stops being true, adoption silently stops working, and a
				// caller resolving an ambiguity would create a second database
				// while believing it adopted the first.
				throw new UpstashProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					"provider returned a database whose id is not the idempotency key, so re-POST is no longer a safe adoption",
					{ detail: { idempotencyKey, returnedId: parsed.databaseId } },
				);
			}
			return parsed;
		}

		const retryAfter = retryAfterMs(response.headers, options.clock());
		throw providerErrorForStatus(response.status, {
			method: "POST",
			body: response.body,
			...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : undefined),
		});
	}

	async function adoptDatabase(
		idempotencyKey: string,
	): Promise<StartRedisDatabase> {
		assertIdempotencyKey(idempotencyKey);
		let lastError: UpstashProviderError | undefined;
		for (let attempt = 0; attempt < maxReadAttempts; attempt += 1) {
			if (attempt > 0)
				await sleep(
					Math.max(
						retryBaseDelayMs * 2 ** (attempt - 1),
						lastError?.retryAfterMs ?? 0,
					),
				);
			try {
				const database = await post(idempotencyKey);
				await options.store.put({
					key: idempotencyKey,
					state: "created",
					attemptedAtMs: options.clock(),
					databaseId: database.databaseId,
				});
				return database;
			} catch (cause) {
				if (!(cause instanceof UpstashProviderError)) throw cause;
				// Ambiguity is retryable *here specifically*, because a repeat
				// POST on the same key cannot create a second database.
				const canRetry =
					cause.retryable || cause.code === "PROVIDER_OPERATION_AMBIGUOUS";
				if (!canRetry) throw cause;
				lastError = cause;
			}
		}
		throw (
			lastError ??
			new UpstashProviderError(
				"PROVIDER_OPERATION_AMBIGUOUS",
				"could not determine whether the database for this idempotency key exists",
				{ detail: { idempotencyKey } },
			)
		);
	}

	async function createDatabase(
		input: CreateDatabaseInput,
	): Promise<CreateDatabaseOutcome> {
		assertIdempotencyKey(input.idempotencyKey);

		const existing = await options.store.get(input.idempotencyKey);
		if (existing !== undefined && existing.state !== "failed") {
			// Both "created" and "in-flight" resolve the same way: ask the
			// provider, with the same key, and take what it says.
			return {
				database: await adoptDatabase(input.idempotencyKey),
				adopted: true,
			};
		}

		await options.store.put({
			key: input.idempotencyKey,
			state: "in-flight",
			attemptedAtMs: options.clock(),
		});

		let database: StartRedisDatabase;
		try {
			database = await post(input.idempotencyKey);
		} catch (cause) {
			if (
				cause instanceof UpstashProviderError &&
				cause.code === "PROVIDER_OPERATION_AMBIGUOUS"
			) {
				// Left in-flight on purpose: the next call must adopt.
				throw cause;
			}
			// A definite refusal releases the key.
			await options.store.put({
				key: input.idempotencyKey,
				state: "failed",
				attemptedAtMs: options.clock(),
			});
			throw cause;
		}

		await options.store.put({
			key: input.idempotencyKey,
			state: "created",
			attemptedAtMs: options.clock(),
			databaseId: database.databaseId,
		});
		return { database, adopted: false };
	}

	async function getMetrics(
		metricsUrl: string,
		databaseId: string,
	): Promise<StartRedisMetrics> {
		const response = await transport.request({
			method: "GET",
			url: metricsUrl,
			headers: { accept: "application/json", "user-agent": userAgent },
			timeoutMs: policy.timeoutMs,
			maxResponseBytes: policy.maxResponseBytes,
		});
		if (response.status === 200)
			return parseStartRedisMetrics(response.body, databaseId);
		if (response.status === 404) {
			// The one signal the anonymous surface gives that a database is
			// gone. It cannot distinguish reaped-on-expiry from never-existed.
			throw new UpstashProviderError(
				"LEASE_EXPIRED",
				`the provider no longer knows about database ${databaseId}; an unclaimed temporary database is reaped at expiry`,
				{ detail: { databaseId, status: 404 } },
			);
		}
		const retryAfter = retryAfterMs(response.headers, options.clock());
		throw providerErrorForStatus(response.status, {
			method: "GET",
			body: redactProviderText(response.body, 120),
			...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : undefined),
		});
	}

	return { createDatabase, adoptDatabase, getMetrics };
}
