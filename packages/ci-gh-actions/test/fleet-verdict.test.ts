import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	createMemoryFleetVerdictKv,
	createMemoryFleetVerdicts,
	FLEET_VERDICT_MAX_TTL_SECONDS,
	fleetReporterStateJson,
	fleetVerdictAllowanceJson,
	fleetVerdictJson,
	fleetVerdictReportJson,
	nextFleetReporterState,
	noFleetVerdict,
	parseFleetReporterState,
	parseFleetReporters,
	parseFleetVerdict,
	parseFleetVerdictAllowance,
	parseFleetVerdictPath,
	parseFleetVerdictReport,
	reportedFleetVerdict,
} from "../src/fleet-verdict.js";

const fixture = (name: string) =>
	readFileSync(
		new URL(`../data-models/fixtures/${name}`, import.meta.url),
		"utf8",
	);
const NOW = Date.parse("2026-11-12T16:00:05.000Z");
const repository = parseFleetVerdictPath("/v1/fleet/verdicts/Hobo-Labs/HoBo");

describe("the fleet verdict's repository", () => {
	it("is read from the route's path, in lower case", () => {
		expect(repository).toBe("hobo-labs/hobo");
	});

	it("takes the longest owner and name GitHub allows, and a managed user's underscore", () => {
		expect(
			parseFleetVerdictPath(
				`/v1/fleet/verdicts/${"a".repeat(39)}/${"b".repeat(100)}`,
			),
		).toHaveLength(140);
		expect(parseFleetVerdictPath("/v1/fleet/verdicts/Mona_Corp/App")).toBe(
			"mona_corp/app",
		);
	});

	it("is nothing for any other path", () => {
		for (const path of [
			"/v1/fleet/verdicts/",
			"/v1/fleet/verdicts/hobo-labs",
			"/v1/fleet/verdicts/hobo-labs/hobo/extra",
			"/v1/fleet/verdicts/hobo-labs/",
			"/v1/fleet/verdicts/-labs/hobo",
			// Longer than any owner GitHub allows, and than a cache key.
			`/v1/fleet/verdicts/${"a".repeat(40)}/hobo`,
			"/v1/fleet/verdicts/hobo labs/hobo",
			`/v1/fleet/verdicts/hobo-labs/${"x".repeat(101)}`,
			"/v1/fleet/verdicts/hobo-labs/hobo/",
			"/v1/fleet/verdicts/hobo-labs%2Fhobo",
			"/v1/fleet/hobo-labs/hobo",
		])
			expect(parseFleetVerdictPath(path), path).toBeUndefined();
	});
});

describe("a fleet verdict report", () => {
	it("is parsed into the labels it blocks, how long it stands and its mode", () => {
		const report = parseFleetVerdictReport(
			fixture("valid/fleet-verdict-report.json"),
		);
		expect(report?.ttlMs).toBe(180_000);
		expect(report?.mode).toBe("report");
		expect([...(report?.blocked ?? [])]).toEqual([["hobo", "no-capacity"]]);
		expect(
			parseFleetVerdictReport(fixture("valid/fleet-verdict-report-shadow.json"))
				?.mode,
		).toBe("shadow");
	});

	it("keeps labels in lower case, the spelling routing asks in", () => {
		const report = parseFleetVerdictReport(
			'{"blocked":{"HoBo-Trunk":{"reason":"no-node"}},"ttlSeconds":60,"mode":"report"}',
		);
		expect([...(report?.blocked ?? [])]).toEqual([["hobo-trunk", "no-node"]]);
	});

	it("may block nothing, which clears the verdict", () => {
		expect(
			parseFleetVerdictReport('{"ttlSeconds":60,"mode":"report"}')?.blocked
				.size,
		).toBe(0);
	});

	it("is refused when it is not one, whole", () => {
		const many = Object.fromEntries(
			Array.from({ length: 17 }, (_, index) => [
				`label-${index}`,
				{ reason: "no-node" },
			]),
		);
		for (const text of [
			"",
			"not json",
			"[]",
			fixture("invalid/fleet-verdict-report-long.json"),
			fixture("invalid/fleet-verdict-report-mode.json"),
			fixture("invalid/fleet-verdict-report-no-mode.json"),
			'{"blocked":{"hobo":{"reason":"busy"}},"ttlSeconds":60,"mode":"report"}',
			'{"blocked":{"hobo":{}},"ttlSeconds":60,"mode":"report"}',
			'{"blocked":{"hobo":{"reason":"no-node"}},"mode":"report"}',
			'{"blocked":{"hobo":{"reason":"no-node"}},"ttlSeconds":60}',
			'{"blocked":{"hobo":{"reason":"no-node"}},"ttlSeconds":60,"mode":"off"}',
			'{"blocked":{"hobo":{"reason":"no-node"}},"ttlSeconds":0,"mode":"report"}',
			`{"blocked":{"hobo":{"reason":"no-node"}},"ttlSeconds":${FLEET_VERDICT_MAX_TTL_SECONDS + 1},"mode":"report"}`,
			'{"blocked":{"hobo trunk":{"reason":"no-node"}},"ttlSeconds":60,"mode":"report"}',
			'{"blocked":{"hobo":{"reason":"no-node"},"HOBO":{"reason":"no-capacity"}},"ttlSeconds":60,"mode":"report"}',
			JSON.stringify({ blocked: many, ttlSeconds: 60, mode: "report" }),
			// A key the record would drop, alone or beside a real label: the
			// report is refused whole, not read as blocking less.
			'{"blocked":{"__proto__":{"reason":"no-node"}},"ttlSeconds":60,"mode":"report"}',
			'{"blocked":{"hobo":{"reason":"no-node"},"__proto__":{"reason":"busy"}},"ttlSeconds":60,"mode":"report"}',
			'{"blocked":{"constructor":{"reason":"no-node"},"-hobo":{"reason":"no-node"}},"ttlSeconds":60,"mode":"report"}',
			'{"blocked":["hobo"],"ttlSeconds":60,"mode":"report"}',
			// A capacity figure is not part of a verdict.
			'{"blocked":{"hobo":{"reason":"no-capacity","freeMemoryMb":2400}},"ttlSeconds":60,"mode":"report"}',
			// Nor is a credential: a report is signed, never carries a bearer.
			'{"blocked":{},"ttlSeconds":60,"mode":"report","token":"x"}',
		])
			expect(parseFleetVerdictReport(text), text).toBeUndefined();
	});

	it("is written the way it is parsed", () => {
		const text = fleetVerdictReportJson(
			new Map([
				["hobo-trunk", "no-node"],
				["hobo", "no-capacity"],
			]),
			180,
			"shadow",
		);
		expect(text).toBe(
			'{"blocked":{"hobo":{"reason":"no-capacity"},"hobo-trunk":{"reason":"no-node"}},"ttlSeconds":180,"mode":"shadow"}',
		);
		expect(parseFleetVerdictReport(text)?.blocked.get("hobo-trunk")).toBe(
			"no-node",
		);
	});
});

describe("a fleet verdict", () => {
	it("is the record of the contract fixture, stamped by the relay that keeps it", () => {
		if (!repository) throw new Error("no repository");
		const report = parseFleetVerdictReport(
			'{"blocked":{"hobo-trunk":{"reason":"no-node"},"hobo":{"reason":"no-capacity"}},"ttlSeconds":180,"mode":"report"}',
		);
		if (!report) throw new Error("no report");
		const verdict = reportedFleetVerdict(repository, report, NOW);
		expect(JSON.parse(fleetVerdictJson(verdict))).toEqual(
			JSON.parse(fixture("valid/fleet-verdict.json")),
		);
		expect(parseFleetVerdict(fixture("valid/fleet-verdict.json"))).toEqual(
			verdict,
		);
	});

	it("is kept dated but blocking nothing for a shadow report, which is never served", () => {
		if (!repository) throw new Error("no repository");
		const report = parseFleetVerdictReport(
			'{"blocked":{"hobo":{"reason":"no-capacity"}},"ttlSeconds":180,"mode":"shadow"}',
		);
		if (!report) throw new Error("no report");
		expect(
			JSON.parse(
				fleetVerdictJson(reportedFleetVerdict(repository, report, NOW)),
			),
		).toEqual({
			repository: "hobo-labs/hobo",
			blocked: {},
			observedAt: "2026-11-12T16:00:05.000Z",
			expiresAt: "2026-11-12T16:03:05.000Z",
		});
	});

	it("names the repository and blocks nothing when there is none", () => {
		if (!repository) throw new Error("no repository");
		expect(JSON.parse(fleetVerdictJson(noFleetVerdict(repository)))).toEqual(
			JSON.parse(fixture("valid/fleet-verdict-clear.json")),
		);
	});

	it("is not read from anything else", () => {
		for (const text of [
			"",
			"{",
			fixture("invalid/fleet-verdict-busy.json"),
			fixture("invalid/fleet-verdict-capacity-figure.json"),
			'{"repository":"Hobo-Labs/HoBo","blocked":{}}',
			'{"repository":"hobo-labs/hobo","blocked":{"hobo":{"reason":"no-node"}}}',
			'{"repository":"hobo-labs/hobo","blocked":{"hobo":{"reason":"no-node"}},"observedAt":"2026-11-12T16:00:05.000Z","expiresAt":"soon"}',
		])
			expect(parseFleetVerdict(text), text).toBeUndefined();
	});
});

describe("what the relay keeps about reporters", () => {
	it("reads the reporter state and allowance fixtures and writes them back the same", () => {
		const state = parseFleetReporterState(
			fixture("valid/fleet-reporter-state.json"),
		);
		if (!state) throw new Error("no state");
		expect(state.lastSequence).toBe(1_794_499_205_000n);
		expect(JSON.parse(fleetReporterStateJson(state))).toEqual(
			JSON.parse(fixture("valid/fleet-reporter-state.json")),
		);
		const allowance = parseFleetVerdictAllowance(
			fixture("valid/fleet-verdict-allowance.json"),
		);
		if (!allowance) throw new Error("no allowance");
		expect(JSON.parse(fleetVerdictAllowanceJson(allowance))).toEqual(
			JSON.parse(fixture("valid/fleet-verdict-allowance.json")),
		);
	});

	it("refuses a state or allowance that is not one", () => {
		for (const text of [
			"",
			fixture("invalid/fleet-reporter-state-mode.json"),
			'{"lastSequence":"0","mode":"report","lastReportAt":"2026-11-12T16:00:05.000Z"}',
			'{"lastSequence":"1","mode":"report","lastReportAt":"yesterday"}',
			'{"lastSequence":"1","mode":"report","lastReportAt":"2026-11-12T16:00:05.000Z","publicKey":"x"}',
		])
			expect(parseFleetReporterState(text), text).toBeUndefined();
		for (const text of [
			"",
			'{"labels":{"hobo":{"windowStart":"soon"}}}',
			'{"labels":{"hobo trunk":{"windowStart":"2026-11-12T16:00:05.000Z"}}}',
		])
			expect(parseFleetVerdictAllowance(text), text).toBeUndefined();
	});

	it("marks when a reporter's reports change a label, not every repeat", () => {
		const reporter = {
			id: "box-1",
			publicKey: "VQLcrFt00Tc-cySxdYNR4cXm5phbpj5QpvkTWtOr5q8",
			accountId: "tenant",
			labels: ["hobo", "hobo-trunk"],
		};
		const report = (text: string) => {
			const parsed = parseFleetVerdictReport(text);
			if (!parsed) throw new Error("no report");
			return parsed;
		};
		const blocking = report(
			'{"blocked":{"hobo":{"reason":"no-capacity"}},"ttlSeconds":180,"mode":"shadow"}',
		);
		const clear = report('{"ttlSeconds":180,"mode":"report"}');
		const first = nextFleetReporterState(undefined, reporter, 1n, clear, NOW);
		expect(first.labels).toEqual({});
		const blocked = nextFleetReporterState(
			first,
			reporter,
			2n,
			blocking,
			NOW + 10_000,
		);
		const again = nextFleetReporterState(
			blocked,
			reporter,
			3n,
			blocking,
			NOW + 70_000,
		);
		expect(again.labels.hobo?.lastBlockedAt).toBe("2026-11-12T16:00:15.000Z");
		expect(again.mode).toBe("shadow");
		const cleared = nextFleetReporterState(
			again,
			reporter,
			4n,
			clear,
			NOW + 130_000,
		);
		expect(cleared.labels.hobo).toMatchObject({
			lastBlockedAt: "2026-11-12T16:00:15.000Z",
			lastClearedAt: "2026-11-12T16:02:15.000Z",
		});
		expect(cleared.lastSequence).toBe(4n);
		expect(cleared.lastReportAt).toBe("2026-11-12T16:02:15.000Z");
	});
});

describe("the verdicts a relay keeps in memory", () => {
	const reporter = {
		id: "box-1",
		publicKey: "VQLcrFt00Tc-cySxdYNR4cXm5phbpj5QpvkTWtOr5q8",
		accountId: "tenant",
		labels: ["hobo"],
	};
	const enrolled = { reporters: [reporter], dailyBlockMinutes: 240 };
	const submit = (ttlSeconds: number, sequence: bigint) => {
		const report = parseFleetVerdictReport(
			`{"blocked":{"hobo":{"reason":"no-capacity"}},"ttlSeconds":${ttlSeconds},"mode":"report"}`,
		);
		if (!report || !repository) throw new Error("no report");
		return { repository, reporter, sequence, report };
	};

	it("serves a verdict until it expires, and no longer", async () => {
		if (!repository) throw new Error("no repository");
		let clock = NOW;
		const verdicts = createMemoryFleetVerdicts(() => clock);
		expect((await verdicts.read(repository, enrolled)).blocked).toEqual({});
		expect((await verdicts.accept(submit(60, 1n), enrolled)).accepted).toBe(
			true,
		);
		expect(
			(await verdicts.read(repository, enrolled)).blocked.hobo?.reason,
		).toBe("no-capacity");
		clock += 59_999;
		expect(
			(await verdicts.read(repository, enrolled)).blocked.hobo,
		).toBeDefined();
		clock += 1;
		expect((await verdicts.read(repository, enrolled)).blocked).toEqual({});
	});

	it("refuses a sequence it has already accepted from the reporter", async () => {
		if (!repository) throw new Error("no repository");
		const verdicts = createMemoryFleetVerdicts(() => NOW);
		expect((await verdicts.accept(submit(60, 5n), enrolled)).accepted).toBe(
			true,
		);
		expect(await verdicts.lastSequence(repository, "box-1")).toBe(5n);
		for (const sequence of [5n, 4n])
			expect(await verdicts.accept(submit(60, sequence), enrolled)).toEqual({
				accepted: false,
				reason: "replayed",
			});
		expect((await verdicts.accept(submit(60, 6n), enrolled)).accepted).toBe(
			true,
		);
	});

	it("keeps each repository's verdict apart", async () => {
		const other = parseFleetVerdictPath("/v1/fleet/verdicts/acme/app");
		if (!other || !repository) throw new Error("no repository");
		const verdicts = createMemoryFleetVerdicts(() => NOW);
		await verdicts.accept(submit(60, 1n), enrolled);
		expect((await verdicts.read(other, enrolled)).blocked).toEqual({});
	});

	it("reads nothing at all for an account with no reporter enrolled", async () => {
		if (!repository) throw new Error("no repository");
		const kv = createMemoryFleetVerdictKv(() => NOW);
		let reads = 0;
		const verdicts = createMemoryFleetVerdicts(() => NOW, {
			...kv,
			getMany: (keys) => {
				reads++;
				return kv.getMany(keys);
			},
		});
		expect(
			await verdicts.read(repository, {
				reporters: [],
				dailyBlockMinutes: 240,
			}),
		).toEqual(noFleetVerdict(repository));
		expect(reads).toBe(0);
	});
});

describe("the reporter enrollment", () => {
	const reporter = (
		overrides: Readonly<Record<string, string | readonly string[]>>,
	) => ({
		id: "box-1",
		publicKey: "VQLcrFt00Tc-cySxdYNR4cXm5phbpj5QpvkTWtOr5q8",
		accountId: "tenant",
		labels: ["hobo", "hobo-trunk"],
		...overrides,
	});
	const enrollment = (...reporters: ReturnType<typeof reporter>[]) =>
		JSON.stringify({ reporters });

	it("is the fixture's reporters, labels in lower case and order", () => {
		expect(
			parseFleetReporters(fixture("valid/fleet-reporter-enrollments.json")),
		).toEqual([
			{
				id: "box-1",
				publicKey: "VQLcrFt00Tc-cySxdYNR4cXm5phbpj5QpvkTWtOr5q8",
				accountId: "tenant",
				labels: ["hobo", "hobo-trunk"],
			},
		]);
		expect(
			parseFleetReporters(
				enrollment(reporter({ labels: ["HoBo-Trunk", "hobo"] })),
			)?.[0]?.labels,
		).toEqual(["hobo", "hobo-trunk"]);
		expect(parseFleetReporters('{"reporters":[]}')).toEqual([]);
	});

	it("takes eight reporters for an account and no more", () => {
		const eight = Array.from({ length: 8 }, (_, index) =>
			reporter({ id: `box-${index}` }),
		);
		expect(parseFleetReporters(enrollment(...eight))).toHaveLength(8);
		expect(
			parseFleetReporters(
				enrollment(...eight, reporter({ id: "box-8", accountId: "neighbor" })),
			),
		).toHaveLength(9);
		expect(
			parseFleetReporters(enrollment(...eight, reporter({ id: "box-8" }))),
		).toBeUndefined();
	});

	it("is refused whole when any reporter is not one", () => {
		for (const text of [
			"",
			"{}x",
			fixture("invalid/fleet-reporter-enrollment-private-key.json"),
			enrollment(reporter({}), reporter({})),
			enrollment(reporter({ id: "box 1" })),
			enrollment(reporter({ id: "b".repeat(65) })),
			enrollment(
				reporter({ publicKey: "VQLcrFt00Tc-cySxdYNR4cXm5phbpj5QpvkTWtOr5q" }),
			),
			// 43 characters whose last carries bits a 32-byte key has not.
			enrollment(
				reporter({ publicKey: "VQLcrFt00Tc-cySxdYNR4cXm5phbpj5QpvkTWtOr5q9" }),
			),
			enrollment(reporter({ accountId: "" })),
			enrollment(reporter({ labels: [] })),
			enrollment(reporter({ labels: ["hobo", "HOBO"] })),
			enrollment(reporter({ labels: ["hobo trunk"] })),
		])
			expect(parseFleetReporters(text), text).toBeUndefined();
	});
});
