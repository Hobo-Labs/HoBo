// The CD fan-out load lane (plan 0024 WP20): 10,000 Camps, one fan-out, p99
// controller tick under one second. The runner measures; the harness binds
// the controller and store (Postgres in the real lane, any store otherwise).
// Measurement uses an injected monotonic clock and is never a decision input.
import {
	type CdConformanceReport,
	type CdSuiteOptions,
	check,
	runCdAssertions,
} from "./cd-kit.js";

// public-contract: versioned conformance suite id stamped on CD conformance reports.
export const CD_LOAD_SUITE = "hobo.cd.fanout-load/v1";

// public-contract: the load lane's default shape (plan 0024 WP20 Load).
export const CD_FANOUT_LOAD_DEFAULTS = Object.freeze({
	camps: 10_000,
	p99TickBudgetMs: 1_000,
	maxTicks: 2_000,
} as const);

export type CdLoadAssertion = "fanoutCompletes" | "p99TickUnderBudget";

export interface FanoutLoadWorld {
	/** One controller tick (the measured unit). */
	tick(): Promise<void>;
	/** Settle in-flight per-Camp promotions outside the measured tick. */
	settle(): Promise<void>;
	completed(): Promise<boolean>;
}

export interface FanoutLoadHarness {
	readonly subject: string;
	create(camps: number): Promise<FanoutLoadWorld>;
	/** Monotonic clock for measurement (e.g. performance.now). */
	clock(): number;
}

export type FanoutLoadOptions = CdSuiteOptions &
	Readonly<{ camps?: number; p99TickBudgetMs?: number; maxTicks?: number }>;

export type FanoutLoadStats = Readonly<{
	ticks: number;
	p50Ms: number;
	p99Ms: number;
	maxMs: number;
}>;

export function percentile(samples: readonly number[], p: number): number {
	if (samples.length === 0) return 0;
	const sorted = [...samples].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	);
	return sorted[index] ?? 0;
}

export async function runFanoutLoad(
	harness: FanoutLoadHarness,
	options: FanoutLoadOptions = {},
): Promise<
	CdConformanceReport<CdLoadAssertion> & Readonly<{ stats: FanoutLoadStats }>
> {
	const camps = options.camps ?? CD_FANOUT_LOAD_DEFAULTS.camps;
	const budget =
		options.p99TickBudgetMs ?? CD_FANOUT_LOAD_DEFAULTS.p99TickBudgetMs;
	const maxTicks = options.maxTicks ?? CD_FANOUT_LOAD_DEFAULTS.maxTicks;
	const samples: number[] = [];
	let done = false;
	let ran: Promise<void> | undefined;
	const run = () => {
		ran ??= (async () => {
			const world = await harness.create(camps);
			for (let i = 0; i < maxTicks && !done; i += 1) {
				const start = harness.clock();
				await world.tick();
				samples.push(harness.clock() - start);
				await world.settle();
				done = await world.completed();
			}
		})();
		return ran;
	};
	const report = await runCdAssertions<CdLoadAssertion>(
		CD_LOAD_SUITE,
		harness.subject,
		{
			fanoutCompletes: async () => {
				await run();
				check(
					done,
					`${camps}-Camp fan-out not complete after ${maxTicks} ticks`,
					"the controller makes progress every tick",
				);
			},
			p99TickUnderBudget: async () => {
				await run();
				const p99 = percentile(samples, 99);
				check(
					p99 < budget,
					`p99 tick ${p99.toFixed(1)} ms is not under ${budget} ms`,
					"keep the controller tick O(changes), not O(fleet), per tick",
				);
			},
		},
		{ ...options, assertionTimeoutMs: options.assertionTimeoutMs ?? 600_000 },
	);
	return Object.freeze({
		...report,
		stats: Object.freeze({
			ticks: samples.length,
			p50Ms: percentile(samples, 50),
			p99Ms: percentile(samples, 99),
			maxMs: Math.max(0, ...samples),
		}),
	});
}
