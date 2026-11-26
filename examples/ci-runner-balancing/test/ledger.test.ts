import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
	type BudgetEnvelope,
	BudgetEnvelopeSchema,
	CostTrust,
	HardBlockSignalSchema,
	ProviderKind,
	type RunnerProviderProfile,
	RunnerProviderProfileSchema,
	UsageSnapshotSchema,
} from "../src/_generated/runner_balancing_pb.js";
import { buildCreditLedgerView } from "../src/ledger.js";

function provider(
	id: string,
	cost: {
		freeUnitsPerMonth?: number;
		listPriceUsdPerUnit?: number;
		includedMultiplier?: number;
	},
): RunnerProviderProfile {
	return create(RunnerProviderProfileSchema, {
		id,
		displayName: id,
		kind: ProviderKind.MANAGED_THIRD_PARTY,
		runsOnLabels: [`${id}-label`],
		cost: {
			freeUnitsPerMonth: cost.freeUnitsPerMonth ?? 0,
			freeTierResetDay: 1,
			listPriceUsdPerUnit: cost.listPriceUsdPerUnit ?? 0,
			unit: "minute",
			includedMultiplier: cost.includedMultiplier ?? 1,
			trust: CostTrust.DECLARED_UNVERIFIED,
		},
	});
}

function envelopes(
	...entries: Array<[string, number, number]>
): ReadonlyMap<string, BudgetEnvelope> {
	return new Map(
		entries.map(([providerId, softCapUsd, hardCapUsd]) => [
			providerId,
			create(BudgetEnvelopeSchema, { providerId, softCapUsd, hardCapUsd }),
		]),
	);
}

function snapshot(
	providerId: string,
	overrides: { spendUsd?: number; unitsUsed?: number; known?: boolean } = {},
) {
	return create(UsageSnapshotSchema, {
		providerId,
		spendUsd: overrides.spendUsd ?? 0,
		unitsUsed: overrides.unitsUsed ?? 0,
		known: overrides.known ?? true,
		source: "test",
	});
}

describe("buildCreditLedgerView", () => {
	it("computes free headroom with the included-minute multiplier (macOS 10x)", () => {
		const view = buildCreditLedgerView({
			providers: [
				provider("gh", {
					freeUnitsPerMonth: 2000,
					listPriceUsdPerUnit: 0.062,
					includedMultiplier: 10,
				}),
			],
			envelopes: envelopes(["gh", 25, 50]),
			snapshots: [snapshot("gh", { unitsUsed: 150 })],
			seq: "s",
		});
		expect(view.entries[0]?.freeHeadroomUnits).toBe(500);
		expect(view.entries[0]?.effectiveMarginalCostUsd).toBe(0);
	});

	it("charges the list price once free headroom is exhausted", () => {
		const view = buildCreditLedgerView({
			providers: [
				provider("gh", { freeUnitsPerMonth: 2000, listPriceUsdPerUnit: 0.006 }),
			],
			envelopes: envelopes(["gh", 25, 50]),
			snapshots: [snapshot("gh", { unitsUsed: 2200, spendUsd: 1.2 })],
			seq: "s",
		});
		expect(view.entries[0]?.freeHeadroomUnits).toBe(0);
		expect(view.entries[0]?.effectiveMarginalCostUsd).toBe(0.006);
	});

	it("hard-blocks a provider whose verified spend reached the hard cap", () => {
		const view = buildCreditLedgerView({
			providers: [provider("p", { listPriceUsdPerUnit: 0.004 })],
			envelopes: envelopes(["p", 10, 20]),
			snapshots: [snapshot("p", { spendUsd: 20 })],
			seq: "s",
		});
		expect(view.entries[0]?.hardBlocked).toBe(true);
	});

	it("never hard-caps on unverified spend", () => {
		const view = buildCreditLedgerView({
			providers: [provider("p", { listPriceUsdPerUnit: 0.004 })],
			envelopes: envelopes(["p", 10, 20]),
			snapshots: [snapshot("p", { spendUsd: 25, known: false })],
			seq: "s",
		});
		expect(view.entries[0]?.hardBlocked).toBe(false);
		expect(view.entries[0]?.usageKnown).toBe(false);
	});

	it("saturates a provider named by a provider-wide hard-block signal", () => {
		const view = buildCreditLedgerView({
			providers: [provider("p", { listPriceUsdPerUnit: 0.004 })],
			envelopes: envelopes(["p", 10, 20]),
			snapshots: [],
			hardBlocks: [
				create(HardBlockSignalSchema, {
					providerId: "p",
					resource: "",
					reason: "spending limit",
				}),
			],
			seq: "s",
		});
		expect(view.entries[0]?.hardBlocked).toBe(true);
	});

	it("degrades misdeclared cost facts to min-cost ranking instead of throwing", () => {
		const broken = provider("p", {
			freeUnitsPerMonth: -5,
			listPriceUsdPerUnit: -1,
		});
		const view = buildCreditLedgerView({
			providers: [broken],
			envelopes: envelopes(["p", 10, 20]),
			snapshots: [],
			seq: "s",
		});
		expect(view.entries[0]?.freeHeadroomUnits).toBe(0);
		expect(view.entries[0]?.listPriceUsdPerUnit).toBe(0);
		expect(view.entries[0]?.effectiveMarginalCostUsd).toBe(0);
	});

	it("pins the caller-provided sequence token", () => {
		const view = buildCreditLedgerView({
			providers: [],
			envelopes: new Map(),
			snapshots: [],
			seq: "seq-42",
		});
		expect(view.seq).toBe("seq-42");
	});
});
