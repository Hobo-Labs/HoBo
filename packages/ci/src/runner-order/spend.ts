/**
 * This month's spend per hosted provider, as the spend limit of a runner
 * order reads it (ADR-0183).
 *
 * Two sources, best first. A settled lease is what the ledger actually
 * charged for a job, so it wins for every job it covers. A job no settled
 * lease covers, but which ran on a hosted provider's label, is priced at the
 * provider's list rate (`HOSTED_LIST_PRICES`) for the minutes it ran. A job
 * whose label has no list rate adds nothing: an unpriced minute is left
 * unmeasured, never guessed.
 */

import type { Lease } from "../_generated/ci_pb.js";
import type { JobFact } from "../_generated/relay_job_pb.js";
import { hostedListRate, type RunnerBilling } from "../fleet/models.js";
import type { SpendReader } from "./ports.js";
import {
	HOSTED_RUNNER_PROVIDERS,
	type HostedRunnerProvider,
	runnerProviderOfLabel,
} from "./providers.js";

/** The ledger's leases of one account; the relay's lease store has this read. */
export type SpendLedger = Readonly<{
	accountLeases(accountId: string): Promise<readonly Lease[]>;
}>;

/** Jobs of the account that finished at or after `sinceMs`, as the relay's facts hold them. */
export type FinishedJobSource = (
	accountId: string,
	sinceMs: number,
) => Promise<readonly JobFact[]>;

export type LedgerSpendReaderDeps = Readonly<{
	ledger: SpendLedger;
	/** Where billed minutes come from; undefined prices only settled leases. */
	finishedJobs: FinishedJobSource | undefined;
}>;

/** Epoch millisecond of the first instant of the UTC month holding `nowMs`. */
export function monthStartMs(nowMs: number): number {
	const now = new Date(nowMs);
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/** Minutes a provider bills for a job that ran `elapsedMs`. */
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

/**
 * A job's provider and its list-rate cost, or undefined when it ran on no
 * hosted provider's label, did not run, or its label has no list rate.
 */
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

/** Spend from the ledger: settled leases first, list rates for the rest. */
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
			// A lease covers the job it ran: the one it was made for only
			// when it records no other.
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
