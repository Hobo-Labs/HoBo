import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	CATEGORY_SKUS,
	createExecutionHostRegistry,
	emptyLedgerView,
	executionHostManifest,
	projectBuildCosts,
	selectExecutionHost,
} from "../src/index.js";

const provider = {
	id: "builder",
	category: "build-machine" as const,
	capabilityManifest() {
		return executionHostManifest("build-machine", { providerId: "builder" });
	},
};
const registry = createExecutionHostRegistry([provider]);
const observation = {
	type: "build.CacheHitObserved",
	seq: 1,
	providerId: "builder",
	buildId: "checkout",
	estimatedUnits: 10,
	meteredUnits: 1,
};

describe("build cost projections", () => {
	it("replays observations deterministically and preserves prior balances", () => {
		const initial = {
			...emptyLedgerView(),
			balances: {
				builder: { [CATEGORY_SKUS["build-machine"]]: { freeHeadroom: 1 } },
			},
		};
		const events = [
			observation,
			{ ...observation, seq: 2, buildId: "other", meteredUnits: 9 },
		];
		const snapshot = projectBuildCosts(initial, registry, "checkout", events);
		assert.deepEqual(
			snapshot,
			projectBuildCosts(initial, registry, "checkout", events),
		);
		assert.equal(snapshot.seq, 2);
		assert.notEqual(snapshot.balanceHash, initial.balanceHash);
		assert.deepEqual(initial.balances.builder[CATEGORY_SKUS["build-machine"]], {
			freeHeadroom: 1,
		});
		const decision = selectExecutionHost(
			{
				category: "build-machine",
				dispatchId: "d-1",
				buildId: "checkout",
				units: 20,
				ledgerView: snapshot,
			},
			registry,
		);
		assert.equal(decision.candidates[0]?.totalCost, 0.006);
		assert.equal(
			decision.dispatchDecided.data.ledgerInput.balanceHash,
			snapshot.balanceHash,
		);
	});

	it("uses the newest observation and rejects another build or stale data", () => {
		const snapshot = projectBuildCosts(
			emptyLedgerView(),
			registry,
			"checkout",
			[observation, { ...observation, seq: 2, meteredUnits: 2 }],
		);
		assert.equal(
			snapshot.balances.builder?.[CATEGORY_SKUS["build-machine"]]
				?.meteredUnitFactor,
			0.2,
		);
		assert.throws(
			() => projectBuildCosts(snapshot, registry, "checkout", [observation]),
			/out-of-order/,
		);
		assert.throws(
			() => projectBuildCosts(snapshot, registry, "other", []),
			/another build/,
		);
		assert.throws(
			() =>
				selectExecutionHost(
					{
						category: "build-machine",
						dispatchId: "d-2",
						buildId: "other",
						ledgerView: snapshot,
					},
					registry,
				),
			/another build/,
		);
	});

	it("rejects invalid measurements and unknown providers", () => {
		for (const bad of [
			{ ...observation, estimatedUnits: 0 },
			{ ...observation, meteredUnits: -1 },
			{ ...observation, meteredUnits: Number.NaN },
			{ ...observation, seq: 0 },
		])
			assert.throws(() =>
				projectBuildCosts(emptyLedgerView(), registry, "checkout", [bad]),
			);
		assert.throws(
			() =>
				projectBuildCosts(emptyLedgerView(), registry, "checkout", [
					{ ...observation, providerId: "missing" },
				]),
			/unregistered/,
		);
	});

	it("does not treat a missing declared price as a free build", () => {
		const invalid = {
			...provider,
			capabilityManifest() {
				const manifest = provider.capabilityManifest();
				return {
					...manifest,
					cost: {
						...manifest.cost,
						facts: manifest.cost.facts.map((fact) => ({
							...fact,
							marginalPrice: "",
						})),
					},
				};
			},
		};
		const invalidRegistry = createExecutionHostRegistry([invalid]);
		assert.throws(
			() =>
				selectExecutionHost(
					{ category: "build-machine", dispatchId: "d-invalid" },
					invalidRegistry,
				),
			/invalid declared cost/,
		);
		assert.throws(
			() =>
				projectBuildCosts(emptyLedgerView(), invalidRegistry, "checkout", [
					observation,
				]),
			/invalid declared cost/,
		);
	});
});
