/**
 * What the routing slip issuer keeps between samples (ADR-0181): the
 * hysteresis that turns refused samples into a held refusal, and the jobs
 * runners took lately.
 *
 * | Rule           | Value                                 |
 * | -------------- | ------------------------------------- |
 * | Sample         | every 10 s                            |
 * | Enter refused  | every sample in the last 60 s refused |
 * | Leave refused  | every sample in the last 30 s clear   |
 *
 * The reporter's send schedule and report sequence went with the hosted
 * verdict (ADR-0180): the slip is written by the issuer's own budget.
 */
import type { RunnerJobsSeen } from "./github-job-poller.js";
import {
	ROUTING_UNACCOUNTED_WINDOW_MS,
	type RunnerJobOnLabel,
} from "./routing-slip-decision.js";

export const ROUTING_HOLD_ENTER_MS = 60_000;
export const ROUTING_HOLD_EXIT_MS = 30_000;

/**
 * Per label, whether the issuer holds it refused. A label flips only once
 * every sample over the hold disagrees with what is held: one dip or one
 * spike never reaches a slip.
 */
export function createRoutingHolds(options: {
	labels: readonly string[];
	enterMs: number;
	exitMs: number;
}) {
	const held = new Set<string>();
	/** Per label, since when every sample has disagreed with what is held. */
	const disagreeingSince = new Map<string, number>();
	return {
		/** Takes one sample; true when a label flipped. */
		observe(nowMs: number, sampled: ReadonlySet<string>): boolean {
			let changed = false;
			for (const label of options.labels) {
				const blocked = held.has(label);
				if (sampled.has(label) === blocked) {
					disagreeingSince.delete(label);
					continue;
				}
				const since = disagreeingSince.get(label) ?? nowMs;
				disagreeingSince.set(label, since);
				if (nowMs - since < (blocked ? options.exitMs : options.enterMs))
					continue;
				if (blocked) held.delete(label);
				else held.add(label);
				disagreeingSince.delete(label);
				changed = true;
			}
			return changed;
		},
		blocked(): ReadonlySet<string> {
			return new Set(options.labels.filter((label) => held.has(label)));
		},
	};
}

/** Jobs runners took on routed labels, remembered for the unaccounted-runner window. */
export function createRunnerPickupMemory(
	windowMs = ROUTING_UNACCOUNTED_WINDOW_MS,
) {
	const seen = new Map<string, RunnerJobOnLabel>();
	return {
		remember(poll: RunnerJobsSeen): void {
			const pollMs = Date.parse(poll.completedAt);
			for (const job of poll.inProgress) {
				const key = `${job.label}\n${job.runnerName}`;
				const startedMs =
					job.startedAt === undefined ? Number.NaN : Date.parse(job.startedAt);
				const startedAtMs = Number.isFinite(startedMs) ? startedMs : pollMs;
				const known = seen.get(key);
				if (known && known.startedAtMs >= startedAtMs) continue;
				seen.set(key, {
					label: job.label,
					runnerName: job.runnerName,
					startedAtMs,
				});
			}
		},
		list(nowMs: number): readonly RunnerJobOnLabel[] {
			for (const [key, job] of seen)
				if (nowMs - job.startedAtMs > windowMs) seen.delete(key);
			return [...seen.values()];
		},
	};
}
