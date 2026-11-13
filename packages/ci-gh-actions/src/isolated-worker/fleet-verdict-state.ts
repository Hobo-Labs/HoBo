/**
 * What the box relay keeps between samples when it decides a routing slip
 * (ADR-0181; the hysteresis of ADR-0180 and plan 0025, 6.2): the holds that
 * turn samples into a held refusal, and the jobs runners took lately. The
 * hosted relay's report schedule and sequence went with its verdict routes
 * (plan 0026, 3.9).
 *
 * | Rule           | Value                                 |
 * | -------------- | ------------------------------------- |
 * | Sample         | every 10 s                            |
 * | Enter blocked  | every sample in the last 60 s blocked |
 * | Leave blocked  | every sample in the last 30 s clear   |
 */
import {
	FLEET_VERDICT_UNACCOUNTED_WINDOW_MS,
	type FleetJobOnRunner,
} from "./fleet-verdict-evaluator.js";
import type { FleetJobsSeen } from "./github-job-poller.js";

export const FLEET_VERDICT_SAMPLE_MS = 10_000;
export const FLEET_VERDICT_ENTER_MS = 60_000;
export const FLEET_VERDICT_EXIT_MS = 30_000;

/**
 * Per label, whether the reporter holds it blocked. A label flips only once
 * every sample over the hold disagrees with what is held: one dip or one
 * spike never reaches a report.
 */
export function createFleetVerdictHolds(options: {
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

/** Jobs runners took on fleet labels, remembered for the unaccounted-runner window. */
export function createFleetPickupMemory(
	windowMs = FLEET_VERDICT_UNACCOUNTED_WINDOW_MS,
) {
	const seen = new Map<string, FleetJobOnRunner>();
	return {
		remember(poll: FleetJobsSeen): void {
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
		list(nowMs: number): readonly FleetJobOnRunner[] {
			for (const [key, job] of seen)
				if (nowMs - job.startedAtMs > windowMs) seen.delete(key);
			return [...seen.values()];
		},
	};
}
