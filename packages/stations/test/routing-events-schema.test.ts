import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type DescMessage,
	fromBinary,
	fromJsonString,
	toBinary,
	toJsonString,
} from "@bufbuild/protobuf";
import { createSimpleTrafficRouting } from "@hobo/connectivity";
import {
	allowDecision,
	denyDecision,
	parseTenantId,
	type TrafficRoutingPort,
} from "@hobo/core";
import { beforeAll, test } from "vitest";
import {
	RoutingApplyRequestedEventDataSchema,
	RoutingObservedEventDataSchema,
	RoutingReappliedEventDataSchema,
	RoutingReconciliationRequiredEventDataSchema,
	RoutingReplanDeniedEventDataSchema,
	RoutingReplanHeldEventDataSchema,
	RoutingReplanProposedEventDataSchema,
} from "../src/_generated/routing_events_pb.js";
import { RampAdvancedEventDataSchema } from "../src/_generated/traffic_cutover_pb.js";
import { isJsonObject } from "../src/json.js";
import { createRoutingControlLoop } from "../src/traffic-routing/control-loop.js";
import { executeRoutingCutover } from "../src/traffic-routing/cutover.js";
import { synthesizeRoutingPlan } from "../src/traffic-routing/synthesize.js";
import { budgetSignals } from "./fixtures/budget-signals.js";

type Fact = { type: string; data?: unknown };

const contracts = new Map<
	string,
	{ schema: DescMessage; cue: string; file?: string }
>(
	Object.entries({
		"routing.ReplanProposed": {
			schema: RoutingReplanProposedEventDataSchema,
			cue: "#RoutingReplanProposedEventData",
		},
		"routing.ReplanHeld": {
			schema: RoutingReplanHeldEventDataSchema,
			cue: "#RoutingReplanHeldEventData",
		},
		"routing.ReplanDenied": {
			schema: RoutingReplanDeniedEventDataSchema,
			cue: "#RoutingReplanDeniedEventData",
		},
		"routing.Reapplied": {
			schema: RoutingReappliedEventDataSchema,
			cue: "#RoutingReappliedEventData",
		},
		"routing.ReconciliationRequired": {
			schema: RoutingReconciliationRequiredEventDataSchema,
			cue: "#RoutingReconciliationRequiredEventData",
		},
		"routing.ApplyRequested": {
			schema: RoutingApplyRequestedEventDataSchema,
			cue: "#RoutingApplyRequestedEventData",
		},
		"routing.Observed": {
			schema: RoutingObservedEventDataSchema,
			cue: "#RoutingObservedEventData",
		},
		"routing.RampAdvanced": {
			schema: RampAdvancedEventDataSchema,
			cue: "#RampAdvancedEventData",
			file: "traffic_cutover.cue",
		},
	}),
);

const tenantId = parseTenantId("tenant-routing-events");
const request = {
	subject: { identity: "router", tenantId, tags: [] },
	action: "routing.plan",
	resource: { kind: "service", id: "checkout", tenantId },
};
const policyDecision = allowDecision("routing-events", request);
const topology = {
	service: "checkout",
	tenantId,
	stationId: "station:prod",
	costRouting: "stateless" as const,
	backends: [
		{ id: "a", service: "checkout", healthy: true },
		{ id: "b", service: "checkout", healthy: true },
	],
};
const costModel = [
	{ backendId: "a", listUnitCost: 0.05 },
	{ backendId: "b", listUnitCost: 0.01 },
];
const account = (providerId: string, listUnitCost: number) => ({
	providerId,
	dimension: "traffic.requests",
	listUnitCost,
	freeHeadroom: 0,
	rateHeadroom: 1000,
	concurrencyHeadroom: 10,
	credits: [],
});

let facts: Fact[] = [];

beforeAll(async () => {
	const budget = budgetSignals(tenantId);
	let accounts = [account("a", 0.05), account("b", 0.01)];
	let now = "2026-08-03T00:00:00.000Z";
	const base = {
		topology,
		policyDecision,
		costModel,
		stability: { cooldownSeconds: 60 },
		incumbentBackendId: "a",
		budgetSignalEvidence: budget.evidence,
		ledgerView: () => ({ view: "CreditLedgerView" as const, seq: 1, accounts }),
		persistState: async () => {},
		beforeApply: async () => {},
		healthGate: () => true,
		clock: () => now,
	};
	const loop = createRoutingControlLoop({
		...base,
		port: createSimpleTrafficRouting(),
	});
	const applied = await loop.handleSignal(budget.signal(1));
	assert.equal(applied.action, "reapplied");
	facts.push(...applied.facts);
	accounts = [account("a", 0.01), account("b", 0.05)];
	now = "2026-08-03T00:00:05.000Z";
	const held = await loop.handleSignal(budget.signal(2));
	assert.equal(held.action, "held");
	facts.push(...held.facts);

	accounts = [account("a", 0.05), account("b", 0.01)];
	const denied = createRoutingControlLoop({
		...base,
		policyDecision: denyDecision("routing-events", request, ["denied"]),
		port: createSimpleTrafficRouting(),
	});
	const denial = await denied.handleSignal(budget.signal(1));
	assert.equal(denial.action, "denied");
	facts.push(...denial.facts);

	const source = createSimpleTrafficRouting();
	const uncertainPort: TrafficRoutingPort = {
		provider: source.provider,
		status: source.status.bind(source),
		apply: async () => {
			throw new Error("response lost");
		},
	};
	const uncertain = createRoutingControlLoop({ ...base, port: uncertainPort });
	const unresolved = await uncertain.handleSignal(budget.signal(1));
	assert.equal(unresolved.action, "reconciliation-required");
	facts.push(...unresolved.facts);

	const prior = synthesizeRoutingPlan({
		topology: {
			...topology,
			backends: [
				{ ...topology.backends[0], id: "a", service: "checkout", weight: 100 },
			],
		},
		policyDecision,
		planId: "plan:checkout:incumbent",
		weightStrategy: "static",
	});
	assert.equal(prior.kind, "plan");
	if (prior.kind !== "plan") throw new Error("incumbent plan unavailable");
	const precondition = {
		validation: { status: "validated" },
		mechanism: "weighted" as const,
		incumbentPlanId: prior.plan.planId,
		incumbentPlan: prior.plan,
	};
	const progressivePort = createSimpleTrafficRouting();
	await progressivePort.apply(prior.plan);
	const progressive = createRoutingControlLoop({
		...base,
		port: progressivePort,
		cutover: {
			precondition,
			rampSteps: [100],
			healthGate: () => true,
			restorationHealthGate: () => true,
		},
	});
	const completedCutover = await progressive.handleSignal(budget.signal(1));
	assert.equal(completedCutover.action, "reapplied");
	facts.push(...completedCutover.facts);
	await source.apply(prior.plan);
	const cutover = await executeRoutingCutover({
		topology,
		policyDecision,
		port: uncertainPort,
		fromBackendId: "a",
		toBackendId: "b",
		precondition,
		healthGate: () => true,
		restorationHealthGate: () => true,
		beforeApply: async () => {},
		clock: () => now,
	});
	assert.equal(cutover.recoveryPending, true);
	facts.push(...cutover.facts);
	const rollbackPort = createSimpleTrafficRouting();
	await rollbackPort.apply(prior.plan);
	const rollback = await executeRoutingCutover({
		topology,
		policyDecision,
		port: rollbackPort,
		fromBackendId: "a",
		toBackendId: "b",
		precondition,
		healthGate: () => false,
		restorationHealthGate: () => true,
		beforeApply: async () => {},
		clock: () => now,
	});
	assert.equal(rollback.rolledBack, true);
	facts.push(...rollback.facts);
	facts = facts.filter((fact) => contracts.has(fact.type));
	assert.deepEqual(
		new Set(facts.map((fact) => fact.type)),
		new Set(contracts.keys()),
	);
	assert.equal(
		facts.filter((fact) => fact.type === "routing.ReconciliationRequired")
			.length,
		2,
	);
	const reapplied = facts.filter((fact) => fact.type === "routing.Reapplied");
	assert.equal(reapplied.length, 2);
	assert.ok(
		reapplied.some(
			(fact) =>
				isJsonObject(fact.data) && !Object.hasOwn(fact.data, "realized"),
		),
	);
	const applyRequests = facts.filter(
		(fact) => fact.type === "routing.ApplyRequested",
	);
	assert.ok(
		applyRequests.some(
			(fact) =>
				isJsonObject(fact.data) &&
				"phase" in fact.data &&
				fact.data.phase === "restore",
		),
	);
});

test("emitted routing facts round-trip through their Protobuf contracts", () => {
	for (const fact of facts) {
		const contract = contracts.get(fact.type);
		assert.ok(contract);
		const parsed = fromJsonString(contract.schema, JSON.stringify(fact.data));
		const decoded = fromBinary(
			contract.schema,
			toBinary(contract.schema, parsed),
		);
		assert.deepEqual(
			JSON.parse(
				toJsonString(contract.schema, decoded, { alwaysEmitImplicit: true }),
			),
			fact.data,
		);
	}
	const proposed = facts.find((fact) => fact.type === "routing.ReplanProposed");
	assert.ok(isJsonObject(proposed?.data));
	const invalidRevision = JSON.stringify({ ...proposed.data, revision: -1 });
	assert.throws(() =>
		fromJsonString(RoutingReplanProposedEventDataSchema, invalidRevision),
	);
});

const cue = process.env.HOBO_CUE_BIN ?? "cue";
const cueAvailable =
	spawnSync(cue, ["version"], { stdio: "ignore" }).status === 0;
const cueFile = (file = "routing_events.cue") =>
	fileURLToPath(new URL(`../data-models/${file}`, import.meta.url));

test.skipIf(!cueAvailable)(
	"CUE accepts emitted routing facts and rejects missing service",
	() => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-routing-events-"));
		try {
			for (const [index, fact] of facts.entries()) {
				const contract = contracts.get(fact.type);
				assert.ok(contract);
				const file = join(directory, `${index}.json`);
				writeFileSync(file, JSON.stringify(fact.data));
				const valid = spawnSync(
					cue,
					["vet", "-c", "-d", contract.cue, cueFile(contract.file), file],
					{ encoding: "utf8" },
				);
				assert.equal(valid.status, 0, valid.stderr);
				assert.ok(isJsonObject(fact.data));
				writeFileSync(file, JSON.stringify({ ...fact.data, service: "" }));
				const invalid = spawnSync(
					cue,
					["vet", "-c", "-d", contract.cue, cueFile(contract.file), file],
					{ encoding: "utf8" },
				);
				assert.equal(invalid.status, 1, invalid.stderr);
				let invalidField: Record<string, string | number> | undefined;
				if (fact.type === "routing.ReplanHeld") {
					invalidField = { reason: "unsupported" };
				} else if (
					fact.type === "routing.Reapplied" &&
					Object.hasOwn(fact.data, "realized")
				) {
					invalidField = { realized: "unsupported" };
				} else if (
					fact.type === "routing.ReconciliationRequired" &&
					Object.hasOwn(fact.data, "percent")
				) {
					invalidField = { percent: 101 };
				} else if (
					fact.type === "routing.ApplyRequested" &&
					"phase" in fact.data &&
					fact.data.phase === "restore"
				) {
					invalidField = { restorationPlanHash: "invalid" };
				} else if (fact.type === "routing.Observed") {
					invalidField = { phase: "unsupported" };
				} else if (fact.type === "routing.RampAdvanced") {
					invalidField = { percent: 0 };
				}
				if (invalidField) {
					writeFileSync(
						file,
						JSON.stringify({ ...fact.data, ...invalidField }),
					);
					const rejected = spawnSync(
						cue,
						["vet", "-c", "-d", contract.cue, cueFile(contract.file), file],
						{ encoding: "utf8" },
					);
					assert.equal(rejected.status, 1, rejected.stderr);
				}
			}
			const legacy = join(directory, "legacy-ramp.json");
			writeFileSync(
				legacy,
				JSON.stringify({
					service: "checkout",
					to_backend_id: "b",
					percent: 100,
					plan_id: "plan:legacy",
				}),
			);
			const legacyRamp = spawnSync(
				cue,
				[
					"vet",
					"-c",
					"-d",
					"#RampAdvancedEventData",
					cueFile("traffic_cutover.cue"),
					legacy,
				],
				{ encoding: "utf8" },
			);
			assert.equal(legacyRamp.status, 0, legacyRamp.stderr);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
