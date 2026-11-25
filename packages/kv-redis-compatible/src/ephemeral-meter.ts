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

export function commandBudgetStatus(input: {
	readonly used: number;
	readonly allowance: number;
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
