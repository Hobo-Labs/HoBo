import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
	type CreditEntry,
	CreditEntrySchema,
	CreditLedgerViewSchema,
	DecisionKind,
	HardBlockSignalSchema,
	RunnerTrackSchema,
} from "../src/_generated/runner_balancing_pb.js";
import { decide, type DecideInput } from "../src/decide.js";

/**
 * Three providers, deliberately listed in non-price order so tests prove
 * ranking comes from the ledger, not from rung order:
 *  - base_c: no free tier, list 0.006 (the "GitHub-hosted" analogue)
 *  - free_a: 100 free units/month, list 0.005 (free tier + mid list price)
 *  - cheap_b: no free tier, list 0.001 (cheapest realtime billing)
 */
const TRACK = create(RunnerTrackSchema, {
	resource: "runner.linux.small",
	variable: "RUNNER",
	rungs: [
		{ value: "base-c", providerId: "base_c", requires: [] },
		{ value: "free-a", providerId: "free_a", requires: [] },
		{ value: "cheap-b", providerId: "cheap_b", requires: [] },
	],
});

interface EntryOverrides extends Partial<CreditEntry> {
	providerId: string;
}

function entry(overrides: EntryOverrides): CreditEntry {
	return create(CreditEntrySchema, {
		effectiveMarginalCostUsd: 0,
		freeHeadroomUnits: 0,
		spendUsd: 0,
		envelopeUsd: 10,
		usageKnown: true,
		hardBlocked: false,
		listPriceUsdPerUnit: 0,
		...overrides,
	});
}

function input(overrides: {
	entries: CreditEntry[];
	current?: Record<string, string | undefined>;
	pins?: string[];
	flipUpPct?: number;
	flipBackPct?: number;
	allowNonFungibleFallback?: boolean;
	resourceBlocks?: DecideInput["resourceBlocks"];
	tracks?: DecideInput["tracks"];
}): DecideInput {
	const result: DecideInput = {
		tracks: overrides.tracks ?? [TRACK],
		current: overrides.current ?? { RUNNER: "base-c" },
		ledger: create(CreditLedgerViewSchema, {
			seq: "seq-1",
			entries: overrides.entries,
		}),
		pins: new Set(overrides.pins ?? []),
		flipUpPct: overrides.flipUpPct,
		flipBackPct: overrides.flipBackPct,
	};
	if (overrides.resourceBlocks !== undefined) {
		result.resourceBlocks = overrides.resourceBlocks;
	}
	if (overrides.allowNonFungibleFallback !== undefined) {
		result.allowNonFungibleFallback = overrides.allowNonFungibleFallback;
	}
	return result;
}

const FREE_HEADROOM = entry({
	providerId: "free_a",
	freeHeadroomUnits: 60,
	effectiveMarginalCostUsd: 0,
	listPriceUsdPerUnit: 0.005,
});
const FREE_EXHAUSTED = entry({
	providerId: "free_a",
	freeHeadroomUnits: 0,
	effectiveMarginalCostUsd: 0.005,
	listPriceUsdPerUnit: 0.005,
});
const CHEAP = entry({
	providerId: "cheap_b",
	effectiveMarginalCostUsd: 0.001,
	listPriceUsdPerUnit: 0.001,
});
const BASE = entry({
	providerId: "base_c",
	effectiveMarginalCostUsd: 0.006,
	listPriceUsdPerUnit: 0.006,
});

describe("decide: maximize-credits ordering", () => {
	it("prefers free credit headroom over a cheaper list price (free before billing)", () => {
		const decisions = decide(
			input({ entries: [FREE_HEADROOM, CHEAP, BASE] }),
		);
		expect(decisions[0]?.kind).toBe(DecisionKind.FLIP);
		expect(decisions[0]?.toValue).toBe("free-a");
		expect(decisions[0]?.reason).toBe("free credit headroom available");
	});

	it("rotates to the declared min-cost provider once the free tier is exhausted", () => {
		const decisions = decide(input({ entries: [FREE_EXHAUSTED, CHEAP, BASE] }));
		expect(decisions[0]?.kind).toBe(DecisionKind.FLIP);
		expect(decisions[0]?.toValue).toBe("cheap-b");
		expect(decisions[0]?.providerId).toBe("cheap_b");
	});

	it("keeps an over-cap cheaper provider behind an affordable one", () => {
		const overCapCheap = create(CreditEntrySchema, {
			...CHEAP,
			spendUsd: 9.5,
			envelopeUsd: 10,
		});
		const decisions = decide(input({ entries: [FREE_EXHAUSTED, overCapCheap, BASE] }));
		expect(decisions[0]?.kind).toBe(DecisionKind.FLIP);
		expect(decisions[0]?.toValue).toBe("free-a");
	});

	it("records the pinned ledger seq on every decision", () => {
		const decisions = decide(input({ entries: [FREE_HEADROOM, CHEAP, BASE] }));
		expect(decisions[0]?.ledgerSeq).toBe("seq-1");
	});
});

describe("decide: hysteresis", () => {
	it("holds the incumbent when it is the eligible cheapest (no_change)", () => {
		const decisions = decide(
			input({
				entries: [FREE_HEADROOM, CHEAP, BASE],
				current: { RUNNER: "free-a" },
			}),
		);
		expect(decisions[0]?.kind).toBe(DecisionKind.NO_CHANGE);
	});

	it("flips up when the incumbent reaches 90% of its soft cap", () => {
		const saturatedFree = create(CreditEntrySchema, {
			...FREE_HEADROOM,
			spendUsd: 9,
			envelopeUsd: 10,
		});
		const decisions = decide(
			input({
				entries: [saturatedFree, CHEAP, BASE],
				current: { RUNNER: "free-a" },
			}),
		);
		expect(decisions[0]?.kind).toBe(DecisionKind.FLIP);
		expect(decisions[0]?.direction).toBe("up");
		expect(decisions[0]?.toValue).toBe("cheap-b");
	});

	it("does NOT flip back while the cheaper provider sits in the 80-90% band", () => {
		const bandFree = create(CreditEntrySchema, {
			...FREE_HEADROOM,
			spendUsd: 8.5,
			envelopeUsd: 10,
		});
		const decisions = decide(
			input({
				entries: [bandFree, CHEAP, BASE],
				current: { RUNNER: "cheap-b" },
			}),
		);
		expect(decisions[0]?.kind).toBe(DecisionKind.NO_CHANGE);
		expect(decisions[0]?.reason).toContain("hysteresis hold");
	});

	it("flips back once the cheaper provider drops below 80%", () => {
		const recoveredFree = create(CreditEntrySchema, {
			...FREE_HEADROOM,
			spendUsd: 7.9,
			envelopeUsd: 10,
		});
		const decisions = decide(
			input({
				entries: [recoveredFree, CHEAP, BASE],
				current: { RUNNER: "cheap-b" },
			}),
		);
		expect(decisions[0]?.kind).toBe(DecisionKind.FLIP);
		expect(decisions[0]?.direction).toBe("back");
		expect(decisions[0]?.toValue).toBe("free-a");
	});

	it("adopts the first eligible rung without the flip-back gate when the variable is unset", () => {
		const bandFree = create(CreditEntrySchema, {
			...FREE_HEADROOM,
			spendUsd: 8.5,
			envelopeUsd: 10,
		});
		const decisions = decide(
			input({ entries: [bandFree, CHEAP, BASE], current: {} }),
		);
		expect(decisions[0]?.kind).toBe(DecisionKind.FLIP);
		expect(decisions[0]?.fromValue).toBe("(unset)");
		expect(decisions[0]?.toValue).toBe("free-a");
	});
});

describe("decide: honesty, pins, blocks, guards", () => {
	it("skips pinned variables entirely", () => {
		const decisions = decide(
			input({ entries: [FREE_HEADROOM, CHEAP, BASE], pins: ["RUNNER"] }),
		);
		expect(decisions[0]?.kind).toBe(DecisionKind.PIN_SKIP);
	});

	it("treats unknown usage as available and flags the flip with usageKnown=false", () => {
		const unknownFree = create(CreditEntrySchema, {
			...FREE_HEADROOM,
			usageKnown: false,
		});
		const decisions = decide(input({ entries: [unknownFree, CHEAP, BASE] }));
		expect(decisions[0]?.kind).toBe(DecisionKind.FLIP);
		expect(decisions[0]?.usageKnown).toBe(false);
	});

	it("marks usageKnown=true on a flip backed by a verified read", () => {
		const decisions = decide(input({ entries: [FREE_HEADROOM, CHEAP, BASE] }));
		expect(decisions[0]?.usageKnown).toBe(true);
	});

	it("routes around a hard-blocked provider regardless of reported numbers", () => {
		const blockedFree = create(CreditEntrySchema, {
			...FREE_HEADROOM,
			hardBlocked: true,
		});
		const decisions = decide(input({ entries: [blockedFree, CHEAP, BASE] }));
		expect(decisions[0]?.kind).toBe(DecisionKind.FLIP);
		expect(decisions[0]?.toValue).toBe("cheap-b");
	});

	it("applies resource-scoped blocks only to the matching track", () => {
		const decisions = decide(
			input({
				entries: [FREE_HEADROOM, CHEAP, BASE],
				resourceBlocks: [
					create(HardBlockSignalSchema, {
						providerId: "free_a",
						resource: "runner.linux.small",
						reason: "no runners available",
					}),
				],
			}),
		);
		expect(decisions[0]?.kind).toBe(DecisionKind.FLIP);
		expect(decisions[0]?.toValue).toBe("cheap-b");
	});

	it("skips rungs whose capability guards are not met", () => {
		const guardedTrack = create(RunnerTrackSchema, {
			resource: "runner.linux.small",
			variable: "RUNNER",
			rungs: [
				{ value: "base-c", providerId: "base_c", requires: [] },
				{
					value: "free-a",
					providerId: "free_a",
					requires: [{ variable: "ENABLE_FREE_A", values: [], exists: true }],
				},
				{ value: "cheap-b", providerId: "cheap_b", requires: [] },
			],
		});
		const decisions = decide(
			input({ entries: [FREE_HEADROOM, CHEAP, BASE], tracks: [guardedTrack] }),
		);
		expect(decisions[0]?.toValue).toBe("cheap-b");
	});

	it("fails closed when every rung is blocked or over budget", () => {
		const allBlocked = [
			create(CreditEntrySchema, { ...FREE_HEADROOM, hardBlocked: true }),
			create(CreditEntrySchema, { ...CHEAP, spendUsd: 10, envelopeUsd: 10 }),
			create(CreditEntrySchema, { ...BASE, spendUsd: 10, envelopeUsd: 10 }),
		];
		const decisions = decide(input({ entries: allBlocked }));
		expect(decisions[0]?.kind).toBe(DecisionKind.FAIL_CLOSED);
		expect(decisions[0]?.toValue).toBe("base-c");
	});

	it("holds a non-fungible rung unless the operator allows the fallback", () => {
		const stickyTrack = create(RunnerTrackSchema, {
			resource: "runner.gpu",
			variable: "RUNNER",
			rungs: [
				{
					value: "base-c",
					providerId: "base_c",
					requires: [],
					stickyReason: "GPU-capable pool",
				},
				{ value: "cheap-b", providerId: "cheap_b", requires: [] },
			],
		});
		const held = decide(input({ entries: [CHEAP, BASE], tracks: [stickyTrack] }));
		expect(held[0]?.kind).toBe(DecisionKind.NON_FUNGIBLE_HOLD);
		expect(held[0]?.reason).toContain("GPU-capable pool");

		const released = decide(
			input({
				entries: [CHEAP, BASE],
				tracks: [stickyTrack],
				allowNonFungibleFallback: true,
			}),
		);
		expect(released[0]?.kind).toBe(DecisionKind.FLIP);
	});
});

describe("decide: last-resort failover", () => {
	const LAST_RESORT_TRACK = create(RunnerTrackSchema, {
		resource: "runner.linux.small",
		variable: "RUNNER",
		rungs: [
			{ value: "base-c", providerId: "base_c", requires: [] },
			{ value: "cheap-b", providerId: "cheap_b", requires: [] },
			{
				value: "hobo-last-resort",
				providerId: "free_a",
				requires: [],
				lastResort: true,
			},
		],
	});

	it("never prefers a last-resort rung while a normal rung is usable, even at declared cost 0", () => {
		const decisions = decide(
			input({
				entries: [FREE_HEADROOM, CHEAP, BASE],
				tracks: [LAST_RESORT_TRACK],
				current: { RUNNER: "base-c" },
			}),
		);
		expect(decisions[0]?.kind).toBe(DecisionKind.FLIP);
		expect(decisions[0]?.toValue).toBe("cheap-b");
	});

	it("fails over to the last-resort rung instead of failing closed when every normal rung is blocked", () => {
		const blocked = [
			create(CreditEntrySchema, { ...CHEAP, hardBlocked: true }),
			create(CreditEntrySchema, { ...BASE, hardBlocked: true }),
			FREE_HEADROOM,
		];
		const decisions = decide(
			input({
				entries: blocked,
				tracks: [LAST_RESORT_TRACK],
				current: { RUNNER: "base-c" },
			}),
		);
		expect(decisions[0]?.kind).toBe(DecisionKind.FLIP);
		expect(decisions[0]?.toValue).toBe("hobo-last-resort");
		expect(decisions[0]?.reason).toContain("last resort");
	});

	it("returns from the last-resort rung as soon as a normal rung recovers", () => {
		const decisions = decide(
			input({
				entries: [FREE_HEADROOM, CHEAP, BASE],
				tracks: [LAST_RESORT_TRACK],
				current: { RUNNER: "hobo-last-resort" },
			}),
		);
		expect(decisions[0]?.kind).toBe(DecisionKind.FLIP);
		expect(decisions[0]?.direction).toBe("back");
		expect(decisions[0]?.toValue).toBe("cheap-b");
	});

	it("still fails closed when the last-resort rung itself is blocked", () => {
		const allBlocked = [
			create(CreditEntrySchema, { ...FREE_HEADROOM, hardBlocked: true }),
			create(CreditEntrySchema, { ...CHEAP, hardBlocked: true }),
			create(CreditEntrySchema, { ...BASE, hardBlocked: true }),
		];
		const decisions = decide(
			input({
				entries: allBlocked,
				tracks: [LAST_RESORT_TRACK],
				current: { RUNNER: "base-c" },
			}),
		);
		expect(decisions[0]?.kind).toBe(DecisionKind.FAIL_CLOSED);
	});
});

describe("decide: determinism and purity", () => {
	it("replays the same decisions for the same pinned ledger input", () => {
		const build = () => input({ entries: [FREE_HEADROOM, CHEAP, BASE] });
		expect(decide(build())).toStrictEqual(decide(build()));
	});

	it("imports only the generated module and its runtime constructor", async () => {
		const source = await readFile(
			path.join(
				path.dirname(fileURLToPath(import.meta.url)),
				"..",
				"src",
				"decide.ts",
			),
			"utf8",
		);
		const specifiers = [...source.matchAll(/from\s+"([^"]+)"/gu)].map(
			(match) => match[1],
		);
		expect(specifiers.length).toBeGreaterThan(0);
		for (const specifier of specifiers) {
			expect([
				"@bufbuild/protobuf",
				"./_generated/runner_balancing_pb.js",
			]).toContain(specifier);
		}
	});
});
