import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { parseManifest } from "@hobo/bindles";
import {
	BudgetLedgerSnapshotSchema,
	createSqliteBudgetAdmissionAuthority,
} from "@hobo/broker";
import {
	createHostingPlanningPass,
	deploy,
	type GatewayDeps,
	type HostingPlanningInput,
} from "@hobo/cloud";
import type { JsonObject } from "@hobo/core";
import { createInMemoryActorHost } from "@hobo/data";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { createHostingBudgetAuthorityBridge } from "../src/hosting-budget-authority.js";

const NOW = Date.parse("2026-10-30T12:00:00Z"),
	END = NOW + 3_600_000;
const cleanup: (() => void)[] = [];
afterEach(() => {
	while (cleanup.length) cleanup.pop()?.();
});
const policy: JsonObject = {
	schemaVersion: "hobo.budget-policy/v1",
	tenantId: "tenant",
	budgetId: "hosting",
	periodId: "period",
	revision: "r1",
	workloads: ["hosting", "ci"],
	currency: "USD",
	limitMicros: 100,
	objective: "maximize-credits",
	enforcement: "strict",
	periodKind: "fixed-window",
	periodStartsAtMs: NOW - 1000,
	periodEndsAtMs: END,
	constraints: [
		{ key: "work.cost", workload: "*", unit: "USD.micros", maximum: 60 },
		{
			key: "provider.cost",
			workload: "hosting",
			unit: "USD.micros",
			maximum: 60,
			target: "account:host",
		},
	],
};
const definition = {
	id: "host",
	providerId: "host",
	port: "compute",
	features: ["http"],
	regions: ["us"],
	specificity: 1,
	priority: 0,
	cost: { sku: "host", unit: "request", marginalPrice: "0.00006" },
	satisfies: () => ({ kind: "full" as const }),
};
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "hosting-shared-policy-"));
	const snapshot = create(BudgetLedgerSnapshotSchema, {
		identity: {
			tenantId: "tenant",
			budgetId: "hosting",
			periodId: "period",
			policyRevision: "r1",
		},
		limitMicros: 100,
		observedAt: new Date(NOW).toISOString(),
		validUntil: new Date(END).toISOString(),
		providerAccounts: [{ providerAccountId: "account:host", limitMicros: 100 }],
	});
	const connections = [0, 1].map(() =>
		createSqliteBudgetAdmissionAuthority({
			path: join(directory, "budget.sqlite"),
			snapshot,
			now: () => new Date(NOW).toISOString(),
		}),
	);
	cleanup.push(() => {
		for (const connection of connections) connection.close();
		rmSync(directory, { recursive: true, force: true });
	});
	const authority = connections[0];
	const other = connections[1];
	if (!authority || !other) throw new Error("missing SQLite connection");
	function evidence(): HostingPlanningInput {
		const current = authority.read(new Date(NOW).toISOString());
		const budget = {
			budgetId: "hosting",
			tenantId: "tenant",
			scopeId: "camp:prod",
			periodId: "period",
			policyRevision: "r1",
			ledgerSeq: current.seq,
			currency: "USD",
			periodStartMs: NOW - 1000,
			periodEndMs: END,
			capMicros: 100,
			settledMicros: current.spentMicros,
			committedMicros: current.externalCommittedMicros + current.reservedMicros,
			unresolvedMicros: current.unresolvedMicros,
			recoveryReserveMicros: current.recoveryReserveMicros,
			observedAtMs: Date.parse(current.observedAt),
			validUntilMs: END,
			providerAccountId: "",
		};
		return {
			budget,
			budgetPolicy: policy,
			nowMs: NOW,
			horizonEndMs: END,
			maxObservationAgeMs: 1000,
			usages: [
				{
					resourceName: "app",
					unit: "request",
					expectedQuantity: 1,
					boundedQuantity: 1,
				},
			],
			entitlements: [],
			providerBudgets: current.providerAccounts.map((account) => ({
				...budget,
				budgetId: "account",
				scopeId: account.providerAccountId,
				providerAccountId: account.providerAccountId,
				capMicros: account.limitMicros,
				settledMicros: account.spentMicros,
				committedMicros:
					account.externalCommittedMicros + account.reservedMicros,
				unresolvedMicros: 0,
				recoveryReserveMicros: 0,
			})),
			quotes: [
				{
					id: "quote:host",
					resourceName: "app",
					definitionId: "host",
					providerId: "host",
					providerAccountId: "account:host",
					currency: "USD",
					rateMicros: 60,
					billingUnit: "request",
					billingPeriodMs: 0,
					source: "trusted:quote-service",
					observedAtMs: NOW,
					validUntilMs: END,
					liabilityEndsAtMs: END,
					entitlementId: "",
					minimumQuantity: 0,
					roundUpQuantity: false,
					fixedCostMicros: 0,
					transitionCostMicros: 0,
				},
			],
		};
	}
	let objective: string | undefined;
	let omitPolicy = false;
	const bridge = createHostingBudgetAuthorityBridge({
		authority,
		scopeId: "camp:prod",
		nowMs: () => NOW,
		resolve: async (request) => {
			objective = request.objective;
			const input = evidence();
			if (!omitPolicy) return input;
			const { budgetPolicy: _policy, ...incomplete } = input;
			return incomplete;
		},
		revalidate: async () => evidence(),
		settlement: async (request) => ({
			actualMicros: request.settledMicros,
			usageEvidenceRef: request.evidenceRef,
			sourceStoppedEvidenceRef: request.sourceStoppedEvidenceRef,
		}),
	});
	const store = createRuntimeLocalEventStore({
		dataDir: join(directory, "events"),
		clock: createManualClock(),
	});
	cleanup.push(() => store.close());
	const deps: GatewayDeps = {
		store,
		actorHost: createInMemoryActorHost(),
		hostingBudgetAuthority: bridge,
		registry: {
			catalogHash: "sha256:test",
			definitions: () => [definition],
			providers: () => ["host"],
		},
	};
	const bindle = parseManifest({
		schema: "hobo.manifest/v1",
		componentHost: { kind: "wasm", version: "1" },
		policy: { budgetPolicy: policy },
		resources: {
			app: {
				type: "component.v1",
				image: "oci://test/app",
				runtime: "wasm",
				exports: ["wasi:http/incoming-handler"],
			},
		},
	});
	return {
		authority,
		other,
		bridge,
		evidence,
		deps,
		bindle,
		objective: () => objective,
		omitPolicy: () => {
			omitPolicy = true;
		},
	};
}
const context = {
	tenant: "tenant",
	actor: { kind: "user", id: "operator" } as const,
};

describe("shared policy through real SQLite hosting admission", () => {
	it("pins policy, inherits its objective and admits one 60-unit deployment from a 100-unit shared scope", async () => {
		const fx = fixture();
		const command = {
			deploymentId: "first",
			bindle: fx.bindle,
			config: { budgetId: "hosting" },
		};
		const result = await deploy(fx.deps, command, context);
		expect(result.status).toBe("planned");
		expect(fx.objective()).toBe("maximize-credits");
		expect(fx.other.read(new Date(NOW).toISOString()).reservedMicros).toBe(60);
		expect(await deploy(fx.deps, command, context)).toEqual(result);
		expect(
			(await deploy(fx.deps, { ...command, deploymentId: "second" }, context))
				.status,
		).toBe("rejected");
		expect(fx.other.read(new Date(NOW).toISOString()).reservedMicros).toBe(60);
	});

	it("refuses a resolver that omits the shared policy and retains no financial hold", async () => {
		const fx = fixture();
		fx.omitPolicy();
		const result = await deploy(
			fx.deps,
			{
				deploymentId: "missing",
				bindle: fx.bindle,
				config: { budgetId: "hosting" },
			},
			context,
		);
		expect(result.status).toBe("rejected");
		expect(fx.authority.read(new Date(NOW).toISOString()).reservedMicros).toBe(
			0,
		);
	});

	it("revalidates the pinned policy independently instead of trusting a freshly rehashed weaker policy", async () => {
		const fx = fixture();
		const evidence = {
			...fx.evidence(),
			budgetPolicy: { ...policy, enforcement: "conservative" },
		};
		const pass = createHostingPlanningPass(evidence);
		pass.commit("app", definition);
		const result = await fx.bridge.reserve({
			reservationId: "tampered-policy",
			planHash: `sha256:${"a".repeat(64)}`,
			commitment: pass.commitment(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.reason).toContain("trusted planning evidence changed");
		expect(fx.other.read(new Date(NOW).toISOString()).reservedMicros).toBe(0);
	});
});
