/**
 * Command metering for a Redis-protocol executor.
 *
 * A hosted cache bills by command (a free tier is typically a monthly
 * command allowance). Wrapping the executor counts what is actually sent —
 * including the extra `EVAL` after a `NOSCRIPT` — rather than estimating from
 * the port calls, so the relay can log real usage against its budget. The
 * per-operation figures it should match are `EPHEMERAL_STATE_COMMAND_COST` in
 * `@hobo/core`; the conformance suite asserts the two agree.
 *
 * Only verbs are counted. Arguments (keys, values, script bodies) never reach
 * the meter or the callback.
 */
import type { KvRedisExecutor } from "./protocol.js";

export type CommandUsage = {
	readonly total: number;
	readonly byVerb: Readonly<Record<string, number>>;
};

export type MeteredExecutor = KvRedisExecutor & {
	usage(): CommandUsage;
	reset(): void;
};

export type MeterOptions = {
	/** Called once per command sent, with the upper-case verb only. */
	readonly onCommand?: (verb: string) => void;
};

export function meterExecutor(
	inner: KvRedisExecutor,
	options: MeterOptions = {},
): MeteredExecutor {
	let total = 0;
	let byVerb = new Map<string, number>();
	const metered: MeteredExecutor = {
		async execute(command) {
			const verb = command[0].toUpperCase();
			total += 1;
			byVerb.set(verb, (byVerb.get(verb) ?? 0) + 1);
			options.onCommand?.(verb);
			return inner.execute(command);
		},
		usage() {
			return { total, byVerb: Object.fromEntries(byVerb) };
		},
		reset() {
			total = 0;
			byVerb = new Map();
		},
	};
	if (inner.advanceTime !== undefined) {
		metered.advanceTime = inner.advanceTime.bind(inner);
	}
	return metered;
}

export type CommandBudgetStatus = {
	readonly usedFraction: number;
	readonly projected: number;
	readonly overBudget: boolean;
};

/**
 * Where a period's usage stands against a command allowance: the fraction
 * used, and the projected end-of-period total at the current rate.
 */
export function commandBudgetStatus(input: {
	readonly used: number;
	readonly allowance: number;
	/** 0..1, how far through the billing period we are. */
	readonly elapsedFraction: number;
}): CommandBudgetStatus {
	const elapsed = Math.min(Math.max(input.elapsedFraction, 0), 1);
	const projected = elapsed > 0 ? Math.round(input.used / elapsed) : input.used;
	return {
		usedFraction: input.allowance > 0 ? input.used / input.allowance : 1,
		projected,
		overBudget: projected > input.allowance,
	};
}
