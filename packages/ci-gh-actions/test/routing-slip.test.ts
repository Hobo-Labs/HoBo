import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	judgeRoutingSlip,
	parseRoutingSlip,
	ROUTING_SLIP_LIFETIME_MS,
	ROUTING_SLIP_REF,
	type RoutingSlipContext,
	routingSlipJson,
} from "../src/routing-slip.js";

const fixture = (name: string) =>
	readFileSync(
		new URL(`../data-models/fixtures/${name}`, import.meta.url),
		"utf8",
	);
const fixtures = (kind: "valid" | "invalid") =>
	readdirSync(new URL(`../data-models/fixtures/${kind}`, import.meta.url))
		.filter((name) => name.startsWith("routing-slip"))
		.sort();

const ISSUED = Date.parse("2026-11-13T16:00:00.000Z");
const LABELS = new Set([
	"hobo",
	"hobo-trunk",
	"hobo-local-host",
	"ubuntu-24.04",
]);
const context: RoutingSlipContext = {
	repository: "Hobo-Labs/HoBo",
	nowMs: ISSUED + 60_000,
	labels: LABELS,
};

describe("the routing slip", () => {
	it("lives at one ref per repository", () => {
		expect(ROUTING_SLIP_REF).toBe("refs/hobo/routing-slip");
	});

	it("is read from every valid fixture", () => {
		expect(fixtures("valid")).toHaveLength(3);
		for (const name of fixtures("valid"))
			expect(
				parseRoutingSlip(fixture(`valid/${name}`), context),
				name,
			).toBeDefined();
	});

	it("comes out as a parsed slip the caller uses without checking again", () => {
		expect(
			parseRoutingSlip(fixture("valid/routing-slip.json"), context),
		).toEqual({
			repository: "hobo-labs/hobo",
			issuedAtMs: ISSUED,
			expiresAtMs: ISSUED + ROUTING_SLIP_LIFETIME_MS,
			classes: {
				pr: { runner: "hobo", tier: "fleet", reason: "fleet-open" },
				fork: { runner: "hobo", tier: "fleet", reason: "fleet-open" },
				trunk: { runner: "hobo-trunk", tier: "fleet", reason: "fleet-busy" },
			},
			relay: { nodeId: "oracle-box-1", commit: "c7ec8d449" },
		});
	});

	it("is never taken from an invalid fixture (M4)", () => {
		const why = Object.fromEntries(
			fixtures("invalid").map((name) => {
				const judgement = judgeRoutingSlip(fixture(`invalid/${name}`), context);
				return [name, judgement.ok ? "used" : judgement.why];
			}),
		);
		expect(why).toEqual({
			"routing-slip-expired.json": "expired",
			"routing-slip-figure-in-reason.json": "malformed",
			"routing-slip-free-slots.json": "malformed",
			"routing-slip-label-not-allowed.json": "label-not-allowed",
			"routing-slip-missing-class.json": "malformed",
			"routing-slip-tier-disagrees.json": "malformed",
			"routing-slip-unknown-class.json": "malformed",
			"routing-slip-version.json": "malformed",
			"routing-slip-wrong-repository.json": "wrong-repository",
		});
	});

	it("is not used once it has expired, by the reader's clock", () => {
		const text = fixture("valid/routing-slip.json");
		const at = (nowMs: number) => judgeRoutingSlip(text, { ...context, nowMs });
		expect(at(ISSUED + ROUTING_SLIP_LIFETIME_MS - 1).ok).toBe(true);
		expect(at(ISSUED + ROUTING_SLIP_LIFETIME_MS)).toEqual({
			ok: false,
			why: "expired",
		});
	});

	it("is not used by another repository", () => {
		expect(
			judgeRoutingSlip(fixture("valid/routing-slip.json"), {
				...context,
				repository: "hobo-labs/other",
			}),
		).toEqual({ ok: false, why: "wrong-repository" });
	});

	it("is not used when it names a label the committed policy does not", () => {
		expect(
			judgeRoutingSlip(fixture("valid/routing-slip-refused.json"), {
				...context,
				labels: new Set(["hobo", "hobo-trunk", "ubuntu-24.04"]),
			}),
		).toEqual({ ok: false, why: "label-not-allowed" });
	});

	it("refuses anything but its canonical JSON", () => {
		const slip = JSON.parse(fixture("valid/routing-slip.json"));
		const variants = [
			{ ...slip, version: "1" },
			{ ...slip, relay: null },
			{
				...Object.fromEntries(
					Object.entries(slip).filter(([key]) => key !== "issuedAt"),
				),
				issued_at: slip.issuedAt,
			},
			{ ...slip, issuedAt: "2026-11-13T16:00:00Z" },
			{ ...slip, expiresAt: "2026-11-13T16:10:00.001Z" },
			{ ...slip, relay: { nodeId: "oracle-box-1", commit: "C7EC8D449" } },
		];
		for (const variant of variants)
			expect(judgeRoutingSlip(JSON.stringify(variant), context)).toEqual({
				ok: false,
				why: "malformed",
			});
		for (const text of ["", "null", "[]", "{", "1"])
			expect(judgeRoutingSlip(text, context)).toEqual({
				ok: false,
				why: "malformed",
			});
	});
});

describe("the routing slip writer", () => {
	const input = {
		repository: "Hobo-Labs/HoBo",
		issuedAtMs: ISSUED,
		classes: {
			pr: { runner: "hobo", tier: "fleet", reason: "fleet-open" },
			fork: { runner: "hobo", tier: "fleet", reason: "fleet-open" },
			trunk: { runner: "hobo-trunk", tier: "fleet", reason: "fleet-busy" },
		},
		relay: { nodeId: "oracle-box-1", commit: "c7ec8d449" },
	} as const;

	it("writes the JSON the commit message carries, read back as the same slip", () => {
		const json = routingSlipJson(input, LABELS);
		expect(JSON.parse(json)).toEqual(
			JSON.parse(fixture("valid/routing-slip.json")),
		);
		expect(parseRoutingSlip(json, context)).toEqual(
			parseRoutingSlip(fixture("valid/routing-slip.json"), context),
		);
	});

	it("refuses to write what no reader would use", () => {
		expect(() =>
			routingSlipJson(
				{
					...input,
					classes: {
						...input.classes,
						pr: { runner: "hobo", tier: "fleet", reason: "no-capacity" },
					},
				},
				LABELS,
			),
		).toThrow(/malformed/);
		expect(() => routingSlipJson(input, new Set(["hobo"]))).toThrow(
			/label-not-allowed/,
		);
	});
});
