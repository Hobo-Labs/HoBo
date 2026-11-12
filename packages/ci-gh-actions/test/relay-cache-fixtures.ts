import { create } from "@bufbuild/protobuf";
import {
	AccountSchema,
	type Configuration,
	ConfigurationSchema,
	ConfigurationStateSchema,
	ConnectionSchema,
	type Job,
	JobSchema,
	OfferSchema,
} from "@hobo/ci";
import type { EphemeralStatePort } from "@hobo/core";
import {
	createManualClock,
	createMemoryRedisExecutor,
	createRedisEphemeralState,
	type ManualClock,
	type MeteredExecutor,
	meterExecutor,
} from "@hobo/kv-redis-compatible";
import {
	parseProxyTokenKey,
	type RelayAcceptedDelivery,
	RelayCacheStore,
	type RelayCacheStoreOptions,
	type RelayConfigSnapshot,
} from "../src/relay-cache/index.js";

export const NOW = "2026-11-02T12:00:00.000Z";
export const LATER = "2026-11-02T12:05:00.000Z";
export const PROXY_KEY = parseProxyTokenKey(
	Buffer.from("relay-cache-test-key-0123456789abcdef"),
);

/** The contract fixture: one account, one isolated repository, a zero-price box offer of concurrency two. */
export function configuration(): Configuration {
	return create(ConfigurationSchema, {
		accounts: [
			create(AccountSchema, {
				id: "hobo-labs",
				budgetMicros: 0,
				maxRuntimeMinutes: 30,
				startupMinutes: 5,
				offers: [
					create(OfferSchema, {
						id: "box-isolated",
						provider: "kubernetes",
						providerAccountId: "box",
						enabled: true,
						runsOn: "hobo-isolated-worker",
						backend: "isolated-container",
						freeMinutes: 0,
						priceMicrosPerMinute: 0,
						budgetMicros: 0,
						concurrency: 2,
						observedAt: "2026-11-02T00:00:00Z",
						validUntil: "2026-12-31T23:59:59Z",
						sourceUrl: "https://example.test/box-evidence",
						bridgeAcknowledged: true,
					}),
				],
			}),
		],
		connections: [
			create(ConnectionSchema, {
				accountId: "hobo-labs",
				repository: "Org/Repo",
				repositoryId: 101,
				installationId: 10,
				runnerGroupId: 1,
				isolatedOnly: true,
				acceptAllMatchingRepositoryJobs: true,
				trustedRepositoryAcknowledged: true,
				publicRepositoryAcknowledged: true,
			}),
		],
	});
}

/** The fixture account plus a second one with its own repository and box. */
export function twoAccounts(): Configuration {
	const config = configuration();
	const [account] = config.accounts;
	const [connection] = config.connections;
	if (!account || !connection) throw new Error("fixture account");
	return create(ConfigurationSchema, {
		accounts: [
			account,
			create(AccountSchema, {
				...account,
				id: "other-co",
				offers: account.offers.map((offer) =>
					create(OfferSchema, { ...offer, providerAccountId: "other-box" }),
				),
			}),
		],
		connections: [
			connection,
			create(ConnectionSchema, {
				...connection,
				accountId: "other-co",
				repository: "Other/Repo",
				repositoryId: 202,
				installationId: 20,
			}),
		],
	});
}

export function job(id: number, action = "queued"): Job {
	return create(JobSchema, {
		id,
		runId: 900,
		runAttempt: 1,
		repositoryId: 101,
		installationId: 10,
		repository: "Org/Repo",
		labels: ["hobo"],
		action,
		isolatedRequired: true,
	});
}

export function foreignJob(id: number): Job {
	const other = job(id);
	other.repositoryId = 202;
	other.installationId = 20;
	other.repository = "Other/Repo";
	return other;
}

export function delivery(deliveryId: string, body: string, receivedAt = NOW) {
	return {
		deliveryId,
		event: "workflow_job",
		installationId: 10,
		repositoryId: 101,
		rawBody: Buffer.from(body),
		receivedAt,
	};
}

/** A config source a test can move, as an operator would through `hobo ci`. */
export function mutableConfig(initial: Configuration, revision = 1) {
	let snapshot: RelayConfigSnapshot = {
		state: create(ConfigurationStateSchema, {
			revision,
			configuration: initial,
			updatedAt: NOW,
		}),
		policies: [],
	};
	return {
		source: { read: async () => snapshot },
		set(next: Configuration, policies: RelayConfigSnapshot["policies"] = []) {
			snapshot = {
				state: create(ConfigurationStateSchema, {
					revision: snapshot.state.revision + 1,
					configuration: next,
					updatedAt: NOW,
				}),
				policies,
			};
			return snapshot.state.revision;
		},
		revision: () => snapshot.state.revision,
	};
}

export type RelayCacheHarness = {
	store: RelayCacheStore;
	state: EphemeralStatePort;
	clock: ManualClock;
	meter: MeteredExecutor;
	intake: RelayAcceptedDelivery[];
	config: ReturnType<typeof mutableConfig>;
	/** Empty the cache, as a lost Upstash database or a flushed Valkey would. */
	flush(): void;
	/** Another relay instance over the same cache. */
	peer(overrides?: Partial<RelayCacheStoreOptions>): RelayCacheStore;
};

/** A store over the in-memory Redis engine, metered, on a manual clock. */
export function openRelayCache(
	config: Configuration = configuration(),
	overrides: Partial<RelayCacheStoreOptions> = {},
): RelayCacheHarness {
	const clock = createManualClock(Date.parse(NOW));
	let engine = createMemoryRedisExecutor({ now: clock.now });
	const meter = meterExecutor({
		execute: (command) => engine.execute(command),
	});
	const state = createRedisEphemeralState({ executor: meter });
	const intake: RelayAcceptedDelivery[] = [];
	const mutable = mutableConfig(config);
	const options = (extra: Partial<RelayCacheStoreOptions> = {}) =>
		({
			state,
			config: mutable.source,
			environment: "test",
			intake: {
				enqueue: async (entry: RelayAcceptedDelivery) => {
					intake.push(entry);
				},
			},
			proxyTokenKey: PROXY_KEY,
			nowMs: clock.now,
			...overrides,
			...extra,
		}) satisfies RelayCacheStoreOptions;
	return {
		store: new RelayCacheStore(options()),
		state,
		clock,
		meter,
		intake,
		config: mutable,
		flush() {
			engine = createMemoryRedisExecutor({ now: clock.now });
		},
		peer: (extra) => new RelayCacheStore(options(extra)),
	};
}
