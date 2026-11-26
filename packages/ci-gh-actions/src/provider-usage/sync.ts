import type { HostedRunnerProvider, SpendReader } from "@hobo/ci";
import { monthStartMs } from "@hobo/ci";
import type { ProviderUsageReader } from "./reader.js";
import type {
	CredentialResolver,
	ProviderUsageSubscription,
	UsageSyncProvider,
} from "./subscription.js";

export const PROVIDER_USAGE_SYNC_INTERVAL_MS = 60 * 60_000;
export const PROVIDER_USAGE_MAX_AGE_MS = 3 * PROVIDER_USAGE_SYNC_INTERVAL_MS;

export type ProviderUsageReading = Readonly<{
	accountId: string;
	provider: UsageSyncProvider;
	monthStartMs: number;
	spentUsd: number;
	readAtMs: number;
	source: string;
}>;

export type ProviderUsageSyncOutcome = Readonly<{
	accountId: string;
	provider: UsageSyncProvider;
	outcome: "synced" | "no-credential" | "no-reader" | "unmeasured";
	spentUsd: number | undefined;
}>;

export type ProviderUsageSyncDeps = Readonly<{
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

	async syncOnce(): Promise<readonly ProviderUsageSyncOutcome[]> {
		const subscriptions = await this.deps
			.subscriptions()
			.catch((): readonly ProviderUsageSubscription[] => []);
		const outcomes: ProviderUsageSyncOutcome[] = [];
		for (const subscription of subscriptions)
			outcomes.push(await this.syncOne(subscription));
		return outcomes;
	}

	reading(
		accountId: string,
		provider: UsageSyncProvider,
	): ProviderUsageReading | undefined {
		return this.kept.get(readingKey(accountId, provider));
	}

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
	fallback: SpendReader;
	now: () => number;
	maxAgeMs: number;
}>;

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
