import type { Lease } from "../_generated/ci_pb.js";
import type { JobFact } from "../_generated/relay_job_pb.js";
import {
	hostedListRate,
	type RunnerBilling,
} from "../runner-routing/models.js";
import type { SpendReader } from "./ports.js";
import {
	HOSTED_RUNNER_PROVIDERS,
	type HostedRunnerProvider,
	runnerProviderOfLabel,
} from "./providers.js";

export type SpendLedger = Readonly<{
	accountLeases(accountId: string): Promise<readonly Lease[]>;
}>;

export type FinishedJobSource = (
	accountId: string,
	sinceMs: number,
) => Promise<readonly JobFact[]>;

export type LedgerSpendReaderDeps = Readonly<{
	ledger: SpendLedger;
	finishedJobs: FinishedJobSource | undefined;
}>;

export function monthStartMs(nowMs: number): number {
	const now = new Date(nowMs);
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

export function billedMinutes(
	elapsedMs: number,
	billing: RunnerBilling,
): number {
	if (!(elapsedMs > 0)) return 0;
	const minutes = elapsedMs / 60_000;
	return billing === "per-minute-ceil" ? Math.ceil(minutes) : minutes;
}

function hostedProvider(text: string): HostedRunnerProvider | undefined {
	const lower = text.trim().toLowerCase();
	return HOSTED_RUNNER_PROVIDERS.find((provider) => provider === lower);
}

function hostedProvidersOfJob(job: JobFact): readonly HostedRunnerProvider[] {
	if (job.startedAtMs === undefined || job.completedAtMs === undefined)
		return [];
	return job.labels.flatMap((label) => {
		const provider = runnerProviderOfLabel(label);
		return provider === undefined || provider === "github" ? [] : [provider];
	});
}

export function listPriceOfJob(
	job: JobFact,
): Readonly<{ provider: HostedRunnerProvider; usd: number }> | undefined {
	if (job.startedAtMs === undefined || job.completedAtMs === undefined)
		return undefined;
	for (const label of job.labels) {
		const provider = runnerProviderOfLabel(label);
		if (provider === undefined || provider === "github") continue;
		const rate = hostedListRate(provider, label);
		if (!rate) return undefined;
		const minutes = billedMinutes(
			job.completedAtMs - job.startedAtMs,
			rate.billing,
		);
		return { provider, usd: minutes * Number(rate.usdPerMinute) };
	}
	return undefined;
}

function settledAtMs(lease: Lease): number | undefined {
	if (lease.settledAt === "") return undefined;
	const at = Date.parse(lease.settledAt);
	return Number.isFinite(at) ? at : undefined;
}

export class LedgerSpendReader implements SpendReader {
	constructor(private readonly deps: LedgerSpendReaderDeps) {}

	async spentUsd(
		accountId: string,
		monthStartMs: number,
	): Promise<ReadonlyMap<HostedRunnerProvider, number>> {
		const spent = new Map<HostedRunnerProvider, number>(
			HOSTED_RUNNER_PROVIDERS.map((provider) => [provider, 0]),
		);
		const add = (provider: HostedRunnerProvider, usd: number): void => {
			if (!(usd >= 0) || !Number.isFinite(usd)) return;
			spent.set(provider, (spent.get(provider) ?? 0) + usd);
		};
		const covered = new Set<number>();
		const leases = await this.deps.ledger
			.accountLeases(accountId)
			.catch(() => undefined);
		if (!leases) return new Map();
		for (const lease of leases) {
			const provider = hostedProvider(lease.provider);
			const at = settledAtMs(lease);
			if (!provider || at === undefined || at < monthStartMs) continue;
			add(provider, lease.paidMicros / 1_000_000);
			const ran = lease.actualJobId > 0 ? lease.actualJobId : lease.jobId;
			if (ran > 0) covered.add(ran);
		}
		const source = this.deps.finishedJobs;
		const jobs = source
			? await source(accountId, monthStartMs).catch(() => undefined)
			: [];
		if (!jobs) return new Map();
		const seen = new Set<number>();
		const unpriced = new Set<HostedRunnerProvider>();
		for (const job of jobs) {
			if (covered.has(job.id) || seen.has(job.id)) continue;
			seen.add(job.id);
			if ((job.completedAtMs ?? 0) < monthStartMs) continue;
			const priced = listPriceOfJob(job);
			if (priced) add(priced.provider, priced.usd);
			else
				for (const provider of hostedProvidersOfJob(job))
					unpriced.add(provider);
		}
		for (const provider of unpriced) spent.delete(provider);
		return spent;
	}
}
