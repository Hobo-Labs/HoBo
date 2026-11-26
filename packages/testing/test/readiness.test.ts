import { describe, expect, it } from "vitest";
import {
	classifyReadinessStatus,
	READINESS_MAX_DELAY_MS,
	type ReadinessProbe,
	TestHarnessError,
	untilReadyWith,
} from "../src/index.js";

function scriptedProbe(statuses: readonly (number | Error)[]): {
	readonly probe: ReadinessProbe;
	readonly calls: () => number;
} {
	let index = 0;
	return {
		probe: async () => {
			const next = statuses[Math.min(index, statuses.length - 1)];
			index += 1;
			if (next instanceof Error) throw next;
			return { status: next ?? 200 };
		},
		calls: () => index,
	};
}

function noSleep(): {
	readonly sleep: (ms: number) => Promise<void>;
	readonly delays: number[];
} {
	const delays: number[] = [];
	return {
		sleep: async (ms: number) => {
			delays.push(ms);
		},
		delays,
	};
}

describe("classifyReadinessStatus", () => {
	it.each([
		[200, "ready"],
		[204, "ready"],
		[302, "ready"],
		[400, "reject"],
		[401, "reject"],
		[403, "reject"],
		[409, "reject"],
		[404, "retry"],
		[429, "retry"],
		[500, "retry"],
		[503, "retry"],
	])("classifies %i as %s", (status, expected) => {
		expect(classifyReadinessStatus(status as number)).toBe(expected);
	});
});

describe("untilReadyWith", () => {
	it.each([
		[400],
		[401],
		[403],
	])("fails fast on %i — an answer is not a propagation delay", async (status) => {
		const { probe, calls } = scriptedProbe([status]);
		await expect(
			untilReadyWith(probe, "http://127.0.0.1:1/", {
				attempts: 10,
				initialDelayMs: 0,
			}),
		).rejects.toMatchObject({ code: "HARNESS_READINESS_REJECTED" });
		expect(calls()).toBe(1);
	});

	it.each([
		[404],
		[503],
	])("retries %i and resolves once the endpoint answers", async (status) => {
		const { probe, calls } = scriptedProbe([status, status, 200]);
		const result = await untilReadyWith(probe, "http://127.0.0.1:1/", {
			attempts: 5,
			initialDelayMs: 1,
		});
		expect(result.status).toBe(200);
		expect(calls()).toBe(3);
	});

	it("retries network failures and stops at the attempt budget", async () => {
		const { probe, calls } = scriptedProbe([new Error("ECONNREFUSED")]);
		const { sleep, delays } = noSleep();
		await expect(
			untilReadyWith(probe, "http://127.0.0.1:1/", {
				attempts: 4,
				initialDelayMs: 10,
				sleep,
			}),
		).rejects.toMatchObject({ code: "HARNESS_READINESS_EXHAUSTED" });
		expect(calls()).toBe(4);
		expect(delays).toEqual([10, 20, 40]);
	});

	it("caps exponential backoff so a long budget stays bounded", async () => {
		const { probe } = scriptedProbe([503]);
		const { sleep, delays } = noSleep();
		await expect(
			untilReadyWith(probe, "http://127.0.0.1:1/", {
				attempts: 20,
				initialDelayMs: 500,
				sleep,
			}),
		).rejects.toMatchObject({ code: "HARNESS_READINESS_EXHAUSTED" });
		expect(Math.max(...delays)).toBe(READINESS_MAX_DELAY_MS);
	});

	it.each([
		[{ attempts: 0 }, "zero attempts"],
		[{ attempts: 1.5 }, "a fractional attempt budget"],
		[{ initialDelayMs: -1 }, "a negative delay"],
	])("refuses %o (%s)", async (options) => {
		const { probe } = scriptedProbe([200]);
		await expect(
			untilReadyWith(probe, "http://127.0.0.1:1/", options),
		).rejects.toBeInstanceOf(TestHarnessError);
	});
});
