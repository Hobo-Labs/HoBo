import { describe, expect, it } from "vitest";
import {
	createMemoryFleetVerdicts,
	type FleetReporter,
	type FleetVerdictMode,
	parseFleetVerdictPath,
	parseFleetVerdictReport,
} from "../src/fleet-verdict.js";

/**
 * Agreement (ADR-0180, F5 and F31): the hosted relay serves a label blocked
 * only while every reporter enrolled for the label, under the account the
 * repository is connected under, is live, in `report` mode, and blocks it.
 */
const NOW = Date.parse("2026-11-12T16:00:00.000Z");
const repository = parseFleetVerdictPath("/v1/fleet/verdicts/hobo-labs/hobo");
const reporter = (id: string, labels: readonly string[]): FleetReporter => ({
	id,
	publicKey: "VQLcrFt00Tc-cySxdYNR4cXm5phbpj5QpvkTWtOr5q8",
	accountId: "tenant",
	labels,
});
const box1 = reporter("box-1", ["hobo", "hobo-trunk"]);
const box2 = reporter("box-2", ["hobo"]);

function setup(reporters: readonly FleetReporter[] = [box1, box2]) {
	if (!repository) throw new Error("no repository");
	const clock = { now: NOW };
	const store = createMemoryFleetVerdicts(() => clock.now);
	const enrolled = { reporters, dailyBlockMinutes: 240 };
	let sequence = 0n;
	const report = async (
		from: FleetReporter,
		blocked: readonly string[],
		mode: FleetVerdictMode = "report",
	) => {
		const parsed = parseFleetVerdictReport(
			JSON.stringify({
				blocked: Object.fromEntries(
					blocked.map((label) => [label, { reason: "no-capacity" }]),
				),
				ttlSeconds: 180,
				mode,
			}),
		);
		if (!parsed) throw new Error("not a report");
		sequence += 1n;
		const accepted = await store.accept(
			{ repository, reporter: from, sequence, report: parsed },
			enrolled,
		);
		expect(accepted.accepted).toBe(true);
	};
	const read = () => store.read(repository, enrolled);
	const blocked = async () => Object.keys((await read()).blocked).sort();
	return { clock, report, blocked, read };
}

describe("agreement among enrolled reporters", () => {
	it("blocks a label only when every enrolled reporter serving it blocks it", async () => {
		const h = setup();
		await h.report(box1, ["hobo"]);
		expect(await h.blocked()).toEqual([]);
		await h.report(box2, ["hobo"]);
		expect(await h.blocked()).toEqual(["hobo"]);
	});

	it("reporters that disagree keep the label open", async () => {
		const h = setup();
		await h.report(box1, ["hobo"]);
		await h.report(box2, []);
		expect(await h.blocked()).toEqual([]);
	});

	it("a silent enrolled reporter keeps the label open", async () => {
		const h = setup();
		await h.report(box1, ["hobo"]);
		expect(await h.blocked()).toEqual([]);
		// box-2 agreed once, then went quiet: its report lapses, and so does the block.
		await h.report(box2, ["hobo"]);
		h.clock.now += 120_000;
		await h.report(box1, ["hobo"]);
		expect(await h.blocked()).toEqual(["hobo"]);
		h.clock.now += 60_000;
		expect(await h.blocked()).toEqual([]);
	});

	it("a reporter in shadow keeps the label open", async () => {
		const h = setup();
		await h.report(box1, ["hobo"]);
		await h.report(box2, ["hobo"], "shadow");
		expect(await h.blocked()).toEqual([]);
	});

	it("a reporter stuck open keeps the label open", async () => {
		const h = setup();
		await h.report(box2, []);
		for (let minute = 0; minute < 10; minute++) {
			await h.report(box1, ["hobo"]);
			if (minute % 2 === 0) await h.report(box2, []);
			h.clock.now += 60_000;
		}
		expect(await h.blocked()).toEqual([]);
	});

	it("a reporter that does not serve the label has no say", async () => {
		const h = setup();
		// box-2 does not serve hobo-trunk, so box-1 alone decides it.
		await h.report(box1, ["hobo-trunk"]);
		expect(await h.blocked()).toEqual(["hobo-trunk"]);
	});

	it("a label no live reporter serves is never blocked", async () => {
		const h = setup([box2]);
		await h.report(box2, ["hobo"]);
		h.clock.now += 180_000;
		expect(await h.blocked()).toEqual([]);
	});

	it("serves the block from when the last reporter saw it until the first lapses", async () => {
		const h = setup();
		await h.report(box1, ["hobo"]);
		h.clock.now += 30_000;
		await h.report(box2, ["hobo"]);
		expect(await h.read()).toMatchObject({
			blocked: { hobo: { reason: "no-capacity" } },
			observedAt: "2026-11-12T16:00:30.000Z",
			expiresAt: "2026-11-12T16:03:00.000Z",
		});
	});
});
