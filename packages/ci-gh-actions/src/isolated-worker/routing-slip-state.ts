import type { RunnerJobsSeen } from "./github-job-poller.js";
import {
	ROUTING_UNACCOUNTED_WINDOW_MS,
	type RunnerJobOnLabel,
} from "./routing-slip-decision.js";

export const ROUTING_HOLD_ENTER_MS = 60_000;
export const ROUTING_HOLD_EXIT_MS = 30_000;

export function createRoutingHolds(options: {
	labels: readonly string[];
	enterMs: number;
	exitMs: number;
}) {
	const held = new Set<string>();
	const disagreeingSince = new Map<string, number>();
	return {
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
