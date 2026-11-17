/**
 * The hourly provider usage sync, and the spend reader that reads it first
 * (ADR-0183).
 *
 * `ProviderUsageSync` asks each subscribed provider's usage API what an
 * account spent this month and keeps the answer in memory with the time it
 * was read. `SyncedSpendReader` is the `SpendReader` a runner order's spend
 * limit reads: a provider with a fresh reading for the asked month gets the
 * vendor's figure, and every other provider gets what the fallback reader
 * (the ledger) says. A routing step therefore never waits on a vendor: the
 * vendor is asked by the sync, on its own clock, and the step reads memory.
 *
 * A missing token, a refusal or a failed read drops that provider's reading
 * at once, so the ledger answers for it until a sync reads it again. A sync
 * that stops running leaves readings that go stale after `maxAgeMs` and are
 * then passed over the same way. Tokens are resolved per call and never kept:
 * a reading holds an account, a provider, a month, dollars and a time.
 */
import type { HostedRunnerProvider, SpendReader } from "@hobo/ci";
import { monthStartMs } from "@hobo/ci";
import type { ProviderUsageReader } from "./reader.js";
import type {
	CredentialResolver,
	ProviderUsageSubscription,
	UsageSyncProvider,
} from "./subscription.js";

// public-contract: how often provider usage is synced.
export const PROVIDER_USAGE_SYNC_INTERVAL_MS = 60 * 60_000;
// public-contract: how old a synced reading may be before the ledger answers instead.
export const PROVIDER_USAGE_MAX_AGE_MS = 3 * PROVIDER_USAGE_SYNC_INTERVAL_MS;

export type ProviderUsageReading = Readonly<{
	accountId: string;
	provider: UsageSyncProvider;
	/** The UTC month the dollars are for. */
	monthStartMs: number;
	spentUsd: number;
	readAtMs: number;
	/** The vendor page the reading's API was read from. */
	source: string;
}>;

/** What one subscription's sync did; never carries a token. */
export type ProviderUsageSyncOutcome = Readonly<{
	accountId: string;
	provider: UsageSyncProvider;
	outcome: "synced" | "no-credential" | "no-reader" | "unmeasured";
	spentUsd: number | undefined;
}>;

export type ProviderUsageSyncDeps = Readonly<{
	/** The subscriptions to sync, read afresh on every sync. */
	subscriptions: () => Promise<readonly ProviderUsageSubscription[]>;
	readers: ReadonlyMap<UsageSyncProvider, ProviderUsageReader>;
	credentials: CredentialResolver;
	now: () => number;
}>;

function readingKey(accountId: string, provider: UsageSyncProvider): string {
	return `${accountId}\u0000${provider}`;
}

export class ProviderUsageSync {
	private readonly kept = new Map<string, ProviderUsageReading>();

	constructor(private readonly deps: ProviderUsageSyncDeps) {}

	/** Read every subscription once. Never throws. */
	async syncOnce(): Promise<readonly ProviderUsageSyncOutcome[]> {
		const subscriptions = await this.deps
			.subscriptions()
			.catch((): readonly ProviderUsageSubscription[] => []);
		const outcomes: ProviderUsageSyncOutcome[] = [];
		for (const subscription of subscriptions)
			outcomes.push(await this.syncOne(subscription));
		return outcomes;
	}

	/** The kept reading of one provider for an account, fresh or not. */
	reading(
		accountId: string,
		provider: UsageSyncProvider,
	): ProviderUsageReading | undefined {
		return this.kept.get(readingKey(accountId, provider));
	}

	/** Every kept reading of an account. */
	readings(accountId: string): readonly ProviderUsageReading[] {
		return [...this.kept.values()].filter(
			(reading) => reading.accountId === accountId,
		);
	}

	private async syncOne(
		subscription: ProviderUsageSubscription,
	): Promise<ProviderUsageSyncOutcome> {
		const { accountId, provider } = subscription;
		const key = readingKey(accountId, provider);
		const done = (
			outcome: ProviderUsageSyncOutcome["outcome"],
			spentUsd: number | undefined,
		): ProviderUsageSyncOutcome => {
			if (spentUsd === undefined) this.kept.delete(key);
			return { accountId, provider, outcome, spentUsd };
		};
		const reader = this.deps.readers.get(provider);
		if (!reader) return done("no-reader", undefined);
		const token = await this.deps
			.credentials(subscription.credential)
			.catch(() => undefined);
		if (token === undefined) return done("no-credential", undefined);
		const nowMs = this.deps.now();
		const startMs = monthStartMs(nowMs);
		const spentUsd = await reader
			.spentUsd({
				window: { startMs, endMs: nowMs },
				token,
				region: subscription.region,
			})
			.catch(() => undefined);
		if (spentUsd === undefined) return done("unmeasured", undefined);
		this.kept.set(key, {
			accountId,
			provider,
			monthStartMs: startMs,
			spentUsd,
			readAtMs: nowMs,
			source: reader.source,
		});
		return done("synced", spentUsd);
	}
}

export type SyncedSpendReaderDeps = Readonly<{
	sync: ProviderUsageSync;
	/** What answers for a provider with no fresh reading: the ledger. */
	fallback: SpendReader;
	now: () => number;
	/** How old a reading may be; `PROVIDER_USAGE_MAX_AGE_MS` by default. */
	maxAgeMs: number;
}>;

/** Spend from the providers' own usage APIs first, the fallback for the rest. */
export class SyncedSpendReader implements SpendReader {
	constructor(private readonly deps: SyncedSpendReaderDeps) {}

	async spentUsd(
		accountId: string,
		monthStartMs: number,
	): Promise<ReadonlyMap<HostedRunnerProvider, number>> {
		const fallback = await this.deps.fallback
			.spentUsd(accountId, monthStartMs)
			.catch((): ReadonlyMap<HostedRunnerProvider, number> => new Map());
		const spent = new Map(fallback);
		const nowMs = this.deps.now();
		for (const reading of this.deps.sync.readings(accountId)) {
			if (reading.monthStartMs !== monthStartMs) continue;
			if (nowMs - reading.readAtMs > this.deps.maxAgeMs) continue;
			spent.set(reading.provider, reading.spentUsd);
		}
		return spent;
	}
}

export type SyncTimers = Readonly<{
	setInterval: (run: () => void, ms: number) => ReturnType<typeof setInterval>;
	clearInterval: (handle: ReturnType<typeof setInterval>) => void;
}>;

/**
 * Sync now and then every `intervalMs`, one sync at a time. Returns the stop
 * function.
 */
export function scheduleProviderUsageSync(
	sync: ProviderUsageSync,
	timers: SyncTimers,
	intervalMs: number = PROVIDER_USAGE_SYNC_INTERVAL_MS,
): () => void {
	let running = false;
	const tick = (): void => {
		if (running) return;
		running = true;
		void sync.syncOnce().finally(() => {
			running = false;
		});
	};
	tick();
	const handle = timers.setInterval(tick, intervalMs);
	return () => timers.clearInterval(handle);
}
