/**
 * What the fleet verdict reporter keeps between samples (ADR-0180; plan
 * 0025, 6.2): the hysteresis that turns samples into a held verdict, when a
 * report is due, the report sequence a restart cannot reuse, and the jobs
 * runners took lately.
 *
 * | Rule           | Value                                                    |
 * | -------------- | -------------------------------------------------------- |
 * | Sample         | every 10 s                                               |
 * | Enter blocked  | every sample in the last 60 s blocked                     |
 * | Leave blocked  | every sample in the last 30 s clear                       |
 * | Send           | at once on a change; otherwise every 60 s                 |
 * | Failed send    | next sample while a change is unsent, else next 60 s mark |
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
	FLEET_VERDICT_UNACCOUNTED_WINDOW_MS,
	type FleetJobOnRunner,
} from "./fleet-verdict-evaluator.js";
import type { FleetJobsSeen } from "./github-job-poller.js";

export const FLEET_VERDICT_SAMPLE_MS = 10_000;
export const FLEET_VERDICT_ENTER_MS = 60_000;
export const FLEET_VERDICT_EXIT_MS = 30_000;
export const FLEET_VERDICT_RESEND_MS = 60_000;
export const FLEET_VERDICT_TTL_SECONDS = 180;

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

/** When a report is due: a change at once, otherwise every `resendMs`. */
export function createFleetVerdictSchedule(options: { resendMs: number }) {
	let unsentChange = false;
	let lastAttemptMs: number | undefined;
	return {
		due(nowMs: number, changed: boolean): boolean {
			if (changed) unsentChange = true;
			return (
				unsentChange ||
				lastAttemptMs === undefined ||
				nowMs - lastAttemptMs >= options.resendMs
			);
		},
		attempted(nowMs: number, sent: boolean): void {
			lastAttemptMs = nowMs;
			if (sent) unsentChange = false;
		},
	};
}

const SequenceState = z
	.object({ lastSequence: z.string().regex(/^[1-9][0-9]{0,19}$/u) })
	.strict();

/**
 * The report sequence, kept in `fleet-verdict-state.json` beside the
 * journal. The next value is `max(last + 1, now in ms)`, written before it
 * is returned, so neither a restart nor a clock that steps back reuses one.
 * A file that is there but is not a state refuses to start, as other daemon
 * settings do; a missing file is a first start.
 */
export function createFleetVerdictSequence(path: string) {
	let last = 0n;
	if (existsSync(path)) {
		const text = readFileSync(path, "utf8");
		const parsed = SequenceState.safeParse(
			(() => {
				try {
					return JSON.parse(text);
				} catch {
					return undefined;
				}
			})(),
		);
		if (!parsed.success)
			throw new Error(`invalid fleet-verdict-state at ${path}`);
		last = BigInt(parsed.data.lastSequence);
	}
	return {
		next(nowMs: number): bigint {
			const clock = BigInt(Math.max(0, Math.floor(nowMs)));
			const next = clock > last ? clock : last + 1n;
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			const temporary = `${path}.tmp`;
			writeFileSync(
				temporary,
				JSON.stringify({ lastSequence: next.toString() }),
				{ mode: 0o600 },
			);
			chmodSync(temporary, 0o600);
			renameSync(temporary, path);
			last = next;
			return next;
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
