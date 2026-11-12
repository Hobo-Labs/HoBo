import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	createMemoryFleetVerdicts,
	FLEET_VERDICT_MAX_TTL_SECONDS,
	fleetVerdictJson,
	fleetVerdictReportJson,
	noFleetVerdict,
	parseFleetVerdict,
	parseFleetVerdictPath,
	parseFleetVerdictReport,
	standingFleetVerdict,
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
	it("is parsed into the labels it blocks and how long it stands", () => {
		const report = parseFleetVerdictReport(
			fixture("valid/fleet-verdict-report.json"),
		);
		expect(report?.ttlMs).toBe(180_000);
		expect([...(report?.blocked ?? [])]).toEqual([["hobo", "no-capacity"]]);
	});

	it("keeps labels in lower case, the spelling routing asks in", () => {
		const report = parseFleetVerdictReport(
			'{"blocked":{"HoBo-Trunk":{"reason":"no-node"}},"ttlSeconds":60}',
		);
		expect([...(report?.blocked ?? [])]).toEqual([["hobo-trunk", "no-node"]]);
	});

	it("may block nothing, which clears the verdict", () => {
		expect(parseFleetVerdictReport('{"ttlSeconds":60}')?.blocked.size).toBe(0);
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
			'{"blocked":{"hobo":{"reason":"busy"}},"ttlSeconds":60}',
			'{"blocked":{"hobo":{}},"ttlSeconds":60}',
			'{"blocked":{"hobo":{"reason":"no-node"}}}',
			'{"blocked":{"hobo":{"reason":"no-node"}},"ttlSeconds":0}',
			`{"blocked":{"hobo":{"reason":"no-node"}},"ttlSeconds":${FLEET_VERDICT_MAX_TTL_SECONDS + 1}}`,
			'{"blocked":{"hobo trunk":{"reason":"no-node"}},"ttlSeconds":60}',
			'{"blocked":{"hobo":{"reason":"no-node"},"HOBO":{"reason":"no-capacity"}},"ttlSeconds":60}',
			JSON.stringify({ blocked: many, ttlSeconds: 60 }),
			// A key the record would drop, alone or beside a real label: the
			// report is refused whole, not read as blocking less.
			'{"blocked":{"__proto__":{"reason":"no-node"}},"ttlSeconds":60}',
			'{"blocked":{"hobo":{"reason":"no-node"},"__proto__":{"reason":"busy"}},"ttlSeconds":60}',
			'{"blocked":{"constructor":{"reason":"no-node"},"-hobo":{"reason":"no-node"}},"ttlSeconds":60}',
			'{"blocked":["hobo"],"ttlSeconds":60}',
			// A capacity figure is not part of a verdict.
			'{"blocked":{"hobo":{"reason":"no-capacity","freeMemoryMb":2400}},"ttlSeconds":60}',
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
		);
		expect(text).toBe(
			'{"blocked":{"hobo":{"reason":"no-capacity"},"hobo-trunk":{"reason":"no-node"}},"ttlSeconds":180}',
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
			'{"blocked":{"hobo-trunk":{"reason":"no-node"},"hobo":{"reason":"no-capacity"}},"ttlSeconds":180}',
		);
		if (!report) throw new Error("no report");
		const verdict = standingFleetVerdict(repository, report, NOW);
		expect(JSON.parse(fleetVerdictJson(verdict))).toEqual(
			JSON.parse(fixture("valid/fleet-verdict.json")),
		);
		expect(parseFleetVerdict(fixture("valid/fleet-verdict.json"))).toEqual(
			verdict,
		);
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
			'{"repository":"Hobo-Labs/HoBo","blocked":{}}',
			'{"repository":"hobo-labs/hobo","blocked":{"hobo":{"reason":"no-node"}}}',
			'{"repository":"hobo-labs/hobo","blocked":{"hobo":{"reason":"no-node"}},"observedAt":"2026-11-12T16:00:05.000Z","expiresAt":"soon"}',
		])
			expect(parseFleetVerdict(text), text).toBeUndefined();
	});
});

describe("the verdicts a relay keeps in memory", () => {
	const standing = (ttlSeconds: number, at: number) => {
		if (!repository) throw new Error("no repository");
		const report = parseFleetVerdictReport(
			`{"blocked":{"hobo":{"reason":"no-capacity"}},"ttlSeconds":${ttlSeconds}}`,
		);
		if (!report) throw new Error("no report");
		return standingFleetVerdict(repository, report, at);
	};

	it("serves a verdict until it expires, and no longer", async () => {
		if (!repository) throw new Error("no repository");
		let clock = NOW;
		const verdicts = createMemoryFleetVerdicts(() => clock);
		expect(await verdicts.read(repository)).toBeUndefined();
		await verdicts.write(standing(60, clock));
		expect((await verdicts.read(repository))?.blocked.hobo?.reason).toBe(
			"no-capacity",
		);
		clock += 59_999;
		expect(await verdicts.read(repository)).toBeDefined();
		clock += 1;
		expect(await verdicts.read(repository)).toBeUndefined();
	});

	it("forgets a verdict that is replaced by one blocking nothing", async () => {
		if (!repository) throw new Error("no repository");
		const verdicts = createMemoryFleetVerdicts(() => NOW);
		await verdicts.write(standing(60, NOW));
		await verdicts.write(noFleetVerdict(repository));
		expect(await verdicts.read(repository)).toBeUndefined();
	});

	it("keeps each repository's verdict apart", async () => {
		const other = parseFleetVerdictPath("/v1/fleet/verdicts/acme/app");
		if (!other || !repository) throw new Error("no repository");
		const verdicts = createMemoryFleetVerdicts(() => NOW);
		await verdicts.write(standing(60, NOW));
		expect(await verdicts.read(other)).toBeUndefined();
	});
});
