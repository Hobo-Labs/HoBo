import type { MeteringSink, UsageEvent } from "@hobo/core";

export function createInMemoryMeteringSink(sinkId = "memory"): MeteringSink & {
	readonly events: readonly UsageEvent[];
	clear(): void;
} {
	const events: UsageEvent[] = [];
	return {
		sinkId,
		emit(event) {
			events.push(event);
		},
		get events() {
			return events;
		},
		clear() {
			events.length = 0;
		},
	};
}

export function createLogMeteringSink(
	sinkId = "log",
	write: (line: string) => void = (line) => {
		console.info(line);
	},
): MeteringSink {
	return {
		sinkId,
		emit(event) {
			write(JSON.stringify({ kind: "hobo.usage", ...event }));
		},
	};
}
