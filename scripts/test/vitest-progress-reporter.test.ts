import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProgressReporter, {
	formatHeartbeat,
	formatSlowest,
} from "../lib/vitest-progress-reporter.ts";

const root = "/repo";

function reporterWithLog(intervalMs: number) {
	const lines: string[] = [];
	const reporter = new ProgressReporter({ intervalMs });
	reporter.onInit({
		config: { root },
		logger: { log: (message) => lines.push(message) },
	});
	return { reporter, lines };
}

describe("formatters", () => {
	it("lists running files oldest first, and says none when idle", () => {
		expect(
			formatHeartbeat(3, 10, [
				{ file: "a.test.ts", ageMs: 1_200 },
				{ file: "slow.test.ts", ageMs: 95_000 },
			]),
		).toBe(
			"vitest progress: 3/10 files done; running: slow.test.ts (95s), a.test.ts (1s)",
		);
		expect(formatHeartbeat(10, 10, [])).toBe(
			"vitest progress: 10/10 files done; running: none",
		);
	});

	it("prints the slowest files first, capped", () => {
		const text = formatSlowest(
			[
				{ file: "fast.test.ts", durationMs: 100 },
				{ file: "slow.test.ts", durationMs: 57_400 },
				{ file: "mid.test.ts", durationMs: 4_500 },
			],
			2,
		);
		expect(text.split("\n")).toEqual([
			"vitest slowest files (of 3):",
			"    57.4s  slow.test.ts",
			"     4.5s  mid.test.ts",
		]);
	});
});

describe("ProgressReporter", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("names the file still running at each heartbeat", () => {
		const { reporter, lines } = reporterWithLog(1_000);
		reporter.onTestRunStart({ length: 2 });
		reporter.onTestModuleStart({ moduleId: `${root}/test/done.test.ts` });
		reporter.onTestModuleEnd({ moduleId: `${root}/test/done.test.ts` });
		reporter.onTestModuleStart({ moduleId: `${root}/test/stuck.test.ts` });
		vi.advanceTimersByTime(1_000);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(
			/^vitest progress: 1\/2 files done; running: test\/stuck\.test\.ts \(\d+s\)$/,
		);
	});

	it("marks a heartbeat that the wall clock reached long before the monotonic clock", () => {
		const { reporter, lines } = reporterWithLog(1_000);
		reporter.onTestRunStart({ length: 1 });
		vi.advanceTimersByTime(1_000);
		expect(lines.some((line) => line.includes("paused"))).toBe(false);
		vi.setSystemTime(Date.now() + 60_000);
		vi.advanceTimersByTime(1_000);
		expect(lines.find((line) => line.includes("paused"))).toMatch(
			/host was paused for about 6\ds/,
		);
	});

	it("ends with the slowest files and stops the heartbeat", () => {
		const { reporter, lines } = reporterWithLog(1_000);
		reporter.onTestRunStart({ length: 2 });
		reporter.onTestRunEnd([
			{
				moduleId: `${root}/a.test.ts`,
				diagnostic: () => ({ duration: 300 }),
			},
			{
				moduleId: `${root}/b.test.ts`,
				diagnostic: () => ({ duration: 16_100 }),
			},
		]);
		expect(lines).toEqual([
			"vitest slowest files (of 2):\n    16.1s  b.test.ts\n     0.3s  a.test.ts",
		]);
		vi.advanceTimersByTime(5_000);
		expect(lines).toHaveLength(1);
	});
});
