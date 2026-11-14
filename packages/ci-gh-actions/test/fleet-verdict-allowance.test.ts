import { describe, expect, it } from "vitest";
import {
	countFleetVerdictAllowance,
	createMemoryFleetVerdicts,
	type FleetReporter,
	parseFleetVerdictPath,
	parseFleetVerdictReport,
} from "../src/fleet-verdict.js";

/**
 * The allowance (ADR-0180, F7 and F10): the relay counts the time the
 * agreed verdict blocks a label and, once a 24-hour window holds the daily
 * allowance, serves that label open whatever the reporters say.
 */
const NOW = Date.parse("2026-11-12T16:00:00.000Z");
const MINUTE = 60_000;
const repository = parseFleetVerdictPath("/v1/fleet/verdicts/hobo-labs/hobo");
const reporter = (id: string): FleetReporter => ({
	id,
	publicKey: "VQLcrFt00Tc-cySxdYNR4cXm5phbpj5QpvkTWtOr5q8",
	accountId: "tenant",
	labels: ["hobo"],
});

function setup(
	reporters: readonly FleetReporter[] = [reporter("box-1")],
	dailyBlockMinutes = 240,
) {
	if (!repository) throw new Error("no repository");
	const clock = { now: NOW };
	const store = createMemoryFleetVerdicts(() => clock.now);
	const enrolled = { reporters, dailyBlockMinutes };
	let sequence = 0n;
	const report = async (from: FleetReporter, blocks: boolean) => {
		const parsed = parseFleetVerdictReport(
			JSON.stringify({
				blocked: blocks ? { hobo: { reason: "no-capacity" } } : {},
				ttlSeconds: 180,
				mode: "report",
			}),
		);
		if (!parsed) throw new Error("not a report");
		sequence += 1n;
		await store.accept(
			{ repository, reporter: from, sequence, report: parsed },
			enrolled,
		);
	};
	const served = async () =>
		(await store.read(repository, enrolled)).blocked.hobo !== undefined;
	const allowance = async () =>
		(await store.status(repository, enrolled)).allowance.hobo;
	return { clock, report, served, allowance };
}

describe("the verdict allowance", () => {
	it("stops serving a block once the allowance is spent", async () => {
		const h = setup([reporter("box-1")], 10);
		await h.report(reporter("box-1"), true);
		for (let minute = 1; minute < 10; minute++) {
			h.clock.now += MINUTE;
			await h.report(reporter("box-1"), true);
			expect(await h.served(), `minute ${minute}`).toBe(true);
		}
		h.clock.now += MINUTE;
		await h.report(reporter("box-1"), true);
		expect(await h.allowance()).toMatchObject({
			usedSeconds: 600,
			spent: true,
		});
		expect(await h.served()).toBe(false);
		// The reporter keeps reporting; the label stays open for the window.
		h.clock.now += 6 * 60 * MINUTE;
		await h.report(reporter("box-1"), true);
		expect(await h.served()).toBe(false);
	});

	it("serves blocks again once the window has passed", async () => {
		const h = setup([reporter("box-1")], 2);
		for (let minute = 0; minute <= 2; minute++) {
			await h.report(reporter("box-1"), true);
			h.clock.now += MINUTE;
		}
		expect(await h.served()).toBe(false);
		await h.report(reporter("box-1"), false);
		h.clock.now += 24 * 60 * MINUTE;
		await h.report(reporter("box-1"), true);
		expect(await h.served()).toBe(true);
		expect(await h.allowance()).toMatchObject({ usedSeconds: 0, spent: false });
	});

	it("counts two reporters blocking together once", async () => {
		const box1 = reporter("box-1");
		const box2 = reporter("box-2");
		const h = setup([box1, box2]);
		await h.report(box1, true);
		await h.report(box2, true);
		for (let minute = 0; minute < 5; minute++) {
			h.clock.now += MINUTE;
			await h.report(box1, true);
			await h.report(box2, true);
		}
		expect((await h.allowance())?.usedSeconds).toBe(300);
	});

	it("counts no time while the agreed verdict is open", async () => {
		const box1 = reporter("box-1");
		const box2 = reporter("box-2");
		const h = setup([box1, box2]);
		for (let minute = 0; minute < 5; minute++) {
			await h.report(box1, true);
			await h.report(box2, false);
			h.clock.now += MINUTE;
		}
		expect(await h.allowance()).toBeUndefined();
	});

	it("counts at most one report's lifetime across a silence", async () => {
		const h = setup();
		await h.report(reporter("box-1"), true);
		// The reporter falls silent for an hour, then reports again.
		h.clock.now += 60 * MINUTE;
		await h.report(reporter("box-1"), true);
		expect((await h.allowance())?.usedSeconds).toBe(0);
		h.clock.now += 2 * MINUTE;
		await h.report(reporter("box-1"), true);
		expect((await h.allowance())?.usedSeconds).toBe(120);
	});

	it("counts from the first counted second and caps one interval at 180 s", () => {
		const at = (ms: number) => new Date(NOW + ms).toISOString();
		const hobo = new Set(["hobo"]);
		const none = new Set<string>();
		const started = countFleetVerdictAllowance(undefined, none, hobo, NOW);
		expect(started.labels.hobo).toMatchObject({
			windowStart: at(0),
			lastCountedAt: at(0),
		});
		const later = countFleetVerdictAllowance(
			started,
			hobo,
			hobo,
			NOW + 400_000,
		);
		expect(later.labels.hobo?.blockedSeconds).toBe(180);
		const ended = countFleetVerdictAllowance(later, hobo, none, NOW + 460_000);
		expect(ended.labels.hobo).toMatchObject({ blockedSeconds: 240 });
		expect(ended.labels.hobo?.lastCountedAt).toBeUndefined();
	});
});
