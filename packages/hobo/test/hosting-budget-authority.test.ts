import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromJson } from "@bufbuild/protobuf";
import { parseManifest } from "@hobo/bindles";
import {
	type BudgetAdmissionAuthority,
	BudgetEntitlementSchema,
	BudgetIdentitySchema,
	BudgetLedgerSnapshotSchema,
	BudgetProviderAccountSchema,
	createSqliteBudgetAdmissionAuthority,
	ProviderAccountExposureSchema,
} from "@hobo/broker";
import {
	createHostingPlanningPass,
	createHostingTransitionCoordinator,
	createHostingTransitionPlan,
	deploy,
	type GatewayDeps,
	type HostingPlanCommitment,
	type HostingPlanningInput,
	HostingTransitionAction,
	HostingTransitionPhase,
	HostingTransitionPlanSchema,
	type HostingTransitionProvider,
	hostingAdapterContractDigest,
	hostingTransitionContracts,
} from "@hobo/cloud";
import { createInMemoryActorHost } from "@hobo/data";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { createHostingBudgetAuthorityBridge } from "../src/hosting-budget-authority.js";

const NOW = Date.parse("2026-10-29T12:00:00.000Z"),
	END = NOW + 3_600_000,
	VALID = NOW + 86_400_000;
const PLAN = `sha256:${"a".repeat(64)}`;
const cleanup: (() => void)[] = [];
afterEach(() => {
	while (cleanup.length) cleanup.pop()?.();
});
function snapshot(limitMicros = 100) {
	return create(BudgetLedgerSnapshotSchema, {
		identity: create(BudgetIdentitySchema, {
			tenantId: "tenant",
			budgetId: "hosting",
			periodId: "period",
			policyRevision: "r1",
		}),
		seq: 0,
		limitMicros,
		spentMicros: 0,
		reservedMicros: 0,
		externalCommittedMicros: 0,
		unresolvedMicros: 0,
		recoveryReserveMicros: 0,
		observedAt: new Date(NOW).toISOString(),
		validUntil: new Date(VALID).toISOString(),
		providerAccounts: [
			create(BudgetProviderAccountSchema, {
				providerAccountId: "account:host",
				limitMicros,
				spentMicros: 0,
				reservedMicros: 0,
				externalCommittedMicros: 0,
			}),
		],
	});
}
function input(
	authority: BudgetAdmissionAuthority,
	rateMicros = 60,
	now = NOW,
): HostingPlanningInput {
	const current = authority.read(new Date(now).toISOString()),
		identity = current.identity;
	if (!identity) throw new Error("identity missing");
	const budget = {
		budgetId: identity.budgetId,
		tenantId: identity.tenantId,
		scopeId: "camp:prod",
		periodId: identity.periodId,
		policyRevision: identity.policyRevision,
		ledgerSeq: current.seq,
		currency: "USD",
		periodStartMs: NOW - 1000,
		periodEndMs: VALID,
		capMicros: current.limitMicros,
		settledMicros: current.spentMicros,
		committedMicros: current.externalCommittedMicros + current.reservedMicros,
		unresolvedMicros: current.unresolvedMicros,
		recoveryReserveMicros: current.recoveryReserveMicros,
		observedAtMs: Date.parse(current.observedAt),
		validUntilMs: Date.parse(current.validUntil),
		providerAccountId: "",
	};
	return {
		budget,
		nowMs: now,
		horizonEndMs: END,
		maxObservationAgeMs: 86_400_000,
		quotes: [
			{
				id: "quote:host",
				resourceName: "app",
				definitionId: "host",
				providerId: "host",
				providerAccountId: "account:host",
				currency: "USD",
				rateMicros,
				billingUnit: "request",
				billingPeriodMs: 0,
				source: "https://example.test/terms",
				observedAtMs: NOW,
				validUntilMs: VALID,
				liabilityEndsAtMs: END,
				entitlementId: current.entitlements[0]?.bucketId ?? "",
				minimumQuantity: 0,
				roundUpQuantity: false,
				fixedCostMicros: 0,
				transitionCostMicros: 0,
			},
		],
		usages: [
			{
				resourceName: "app",
				unit: "request",
				expectedQuantity: 1,
				boundedQuantity: 1,
			},
		],
		entitlements: current.entitlements.map((row) => ({
			id: row.bucketId,
			periodId: row.periodId,
			providerAccountId: "account:host",
			currency: "USD",
			unit: row.unit,
			remainingQuantity: row.remainingUnits - row.reservedUnits,
			validUntilMs: Date.parse(row.validUntil),
			definitionIds: ["host"],
		})),
		providerBudgets: current.providerAccounts.map((account) => ({
			...budget,
			budgetId: `account:${account.providerAccountId}`,
			scopeId: account.providerAccountId,
			providerAccountId: account.providerAccountId,
			capMicros: account.limitMicros,
			settledMicros: account.spentMicros,
			committedMicros: account.externalCommittedMicros + account.reservedMicros,
			unresolvedMicros: 0,
			recoveryReserveMicros: 0,
		})),
	};
}
function proposal(evidence: HostingPlanningInput): HostingPlanCommitment {
	const pass = createHostingPlanningPass(evidence);
	pass.commit("app", {
		id: "host",
		providerId: "host",
		port: "compute",
		features: [],
		regions: [],
		specificity: 1,
		priority: 0,
		cost: { sku: "host", unit: "request", marginalPrice: "0" },
		satisfies: () => ({ kind: "full" }),
	});
	return pass.commitment();
}
function fixture(initial = snapshot()) {
	const directory = mkdtempSync(join(tmpdir(), "hosting-authority-")),
		path = join(directory, "budget.sqlite");
	const connections: ReturnType<typeof createSqliteBudgetAdmissionAuthority>[] =
		[];
	cleanup.push(() => {
		for (const connection of connections) connection.close();
		rmSync(directory, { recursive: true, force: true });
	});
	let clock = NOW;
	const open = () => {
		const connection = createSqliteBudgetAdmissionAuthority({
			path,
			snapshot: initial,
			now: () => new Date(clock).toISOString(),
		});
		connections.push(connection);
		return connection;
	};
	const authority = open();
	const bridge = (
		port: BudgetAdmissionAuthority = authority,
		overrides: Partial<
			Parameters<typeof createHostingBudgetAuthorityBridge>[0]
		> = {},
	) =>
		createHostingBudgetAuthorityBridge({
			authority: port,
			scopeId: "camp:prod",
			nowMs: () => clock,
			resolve: async () => input(port, 60, clock),
			revalidate: async () => input(port, 60, clock),
			settlement: async (request) => ({
				actualMicros: request.settledMicros,
				usageEvidenceRef: request.evidenceRef,
				sourceStoppedEvidenceRef: request.sourceStoppedEvidenceRef,
				providerAccounts: [
					create(ProviderAccountExposureSchema, {
						providerAccountId: "account:host",
						liabilityMicros: request.settledMicros,
					}),
				],
				entitlementClaims: [],
			}),
			...overrides,
		});
	return {
		authority,
		open,
		bridge,
		setClock: (value: number) => {
			clock = value;
		},
	};
}
const reserve = (
	bridge: ReturnType<typeof createHostingBudgetAuthorityBridge>,
	reservationId: string,
	commitment: HostingPlanCommitment,
) => bridge.reserve({ reservationId, planHash: PLAN, commitment });
const ref = (reservationId: string, commitment: HostingPlanCommitment) => ({
	reservationId,
	tenantId: commitment.tenantId,
	commitmentHash: commitment.commitmentHash,
});
function deploymentDeps(
	fx: ReturnType<typeof fixture>,
	port: BudgetAdmissionAuthority = fx.authority,
): GatewayDeps & { store: ReturnType<typeof createRuntimeLocalEventStore> } {
	const directory = mkdtempSync(join(tmpdir(), "hosting-deploy-"));
	const store = createRuntimeLocalEventStore({
		dataDir: directory,
		clock: createManualClock(),
	});
	cleanup.push(() => {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});
	const definition = {
		id: "host",
		providerId: "host",
		port: "compute",
		features: ["http"],
		regions: ["us"],
		specificity: 1,
		priority: 0,
		cost: { sku: "host", unit: "request", marginalPrice: "0" },
		satisfies: () => ({ kind: "full" as const }),
	};
	return {
		store,
		actorHost: createInMemoryActorHost(),
		registry: {
			catalogHash: "sha256:test",
			definitions: () => [definition],
			providers: () => ["host"],
		},
		hostingBudgetAuthority: fx.bridge(port),
	};
}
function deployment(deploymentId: string) {
	return {
		deploymentId,
		bindle: parseManifest({
			schema: "hobo.manifest/v1",
			componentHost: { kind: "wasm", version: "1" },
			resources: {
				app: {
					type: "component.v1",
					image: "oci://example/app",
					runtime: "wasm",
					exports: ["wasi:http/incoming-handler"],
				},
			},
		}),
		config: { budgetId: "hosting", objective: "maximize-credits" },
	};
}
const actorContext = {
	tenant: "tenant",
	actor: { kind: "user", id: "operator" } as const,
};

describe("durable core hosting financial authority composition", () => {
	it("adopts the gateway's hold once and forbids another transition from spending that authorization", async () => {
		const fx = fixture(),
			deps = deploymentDeps(fx),
			commitment = proposal(input(fx.authority));
		const admitted = await deploy(deps, deployment("adopt"), actorContext);
		expect(admitted.status).toBe("planned");
		if (admitted.status !== "planned" || !admitted.hostingReservationId)
			throw new Error("admission failed");
		let effects = 0;
		const provider: HostingTransitionProvider = {
			contractId: "test-hosting/v1",
			executionGuarantee: "idempotent-operation",
			effects: hostingTransitionContracts.mutate.effects,
			resilience: hostingTransitionContracts.mutate.resilience,
			execute: async () => {
				effects++;
			},
			observe: async (request) => ({
				tenantId: request.plan.tenantId,
				transitionId: request.plan.transitionId,
				operationId: request.operation.operationId,
				operationDigest: request.operation.operationDigest,
				observedAtMs: NOW,
				outcome: "applied",
				healthyBackends: 2,
				jurisdiction: "US",
				latencyMs: 20,
				capabilityDigest: "capabilities:v1",
				ready: true,
				evidenceRef: `observation:${request.operation.operationId}`,
				sourceRetired:
					request.operation.action === HostingTransitionAction.RETIRE,
				usageFinal: request.operation.action === HostingTransitionAction.SETTLE,
				settledMicros: 40,
				sourcePlanId: request.plan.sourcePlanId,
				targetPlanId: request.plan.targetPlanId,
			}),
		};
		const blueprint = fromJson(
			HostingTransitionPlanSchema,
			JSON.parse(
				readFileSync(
					new URL(
						"../../cloud/contracts/hosting-transition-fixtures/valid-plan.json",
						import.meta.url,
					),
					"utf8",
				),
			),
		);
		const move = createHostingTransitionPlan({
			...blueprint,
			transitionId: "move-one",
			deploymentId: "adopt",
			planDigest: "",
			commitment,
			existingReservationId: admitted.hostingReservationId,
			financialPlanHash: admitted.planHash,
			targetPlanId: admitted.planHash,
			horizonEndMs: END,
			adapterContractDigest: hostingAdapterContractDigest(provider),
			constraints: { ...blueprint.constraints, rollbackHoldUntilMs: 0 },
		});
		const coordinator = createHostingTransitionCoordinator({
			store: deps.store,
			budget: fx.bridge(),
			provider,
			context: {
				tenantId: "tenant",
				actor: { kind: "service", id: "controller" },
				fenceToken: 1n,
			},
			nowMs: () => NOW,
			authorize: async () => ({ allowed: true }),
		});
		await coordinator.propose(move);
		expect((await coordinator.reserve("move-one")).phase).toBe(
			HostingTransitionPhase.PREPARING,
		);
		expect(effects).toBe(0);
		expect(fx.authority.read(new Date(NOW).toISOString()).reservedMicros).toBe(
			60,
		);
		const reused = createHostingTransitionPlan({
			...move,
			transitionId: "move-two",
			planDigest: "",
		});
		await coordinator.propose(reused);
		expect((await coordinator.reserve("move-two")).phase).toBe(
			HostingTransitionPhase.BLOCKED,
		);
		expect(effects).toBe(0);
		expect(fx.authority.read(new Date(NOW).toISOString()).reservedMicros).toBe(
			60,
		);
		await coordinator.dispatch("move-one");
		await coordinator.observe("move-one");
		await coordinator.dispatch("move-one");
		await coordinator.observe("move-one");
		await coordinator.observe("move-one");
		await coordinator.dispatch("move-one");
		await coordinator.observe("move-one");
		const completed = await coordinator.observe("move-one");
		expect(completed.phase).toBe(HostingTransitionPhase.SETTLED);
		expect(completed.sourceRetirementConfirmed).toBe(true);
		expect(effects).toBe(3);
		expect(fx.authority.read(new Date(NOW).toISOString())).toMatchObject({
			reservedMicros: 0,
			spentMicros: 40,
		});
	});
	it("enforces the shared ceiling through the actual cloud gateway and replays its planned result", async () => {
		const fx = fixture(),
			first = deploymentDeps(fx),
			second = deploymentDeps(fx, fx.open());
		const results = await Promise.all([
			deploy(first, deployment("one"), actorContext),
			deploy(second, deployment("two"), actorContext),
		]);
		expect(results.map((result) => result.status).sort()).toEqual([
			"planned",
			"rejected",
		]);
		const index = results.findIndex((result) => result.status === "planned"),
			winner = index === 0 ? first : second;
		const repeated = await deploy(
			winner,
			deployment(index === 0 ? "one" : "two"),
			actorContext,
		);
		expect(repeated).toEqual(results[index]);
		expect(fx.authority.read(new Date(NOW).toISOString()).reservedMicros).toBe(
			60,
		);
	});
	it("keeps the durable hold when the process fails between reservation and gateway facts", async () => {
		const fx = fixture(),
			deps = deploymentDeps(fx),
			append = deps.store.append.bind(deps.store);
		const interruptedAppend: typeof deps.store.append = async (
			streamId,
			events,
			options,
		) => {
			if (events.some((event) => event.type === "hosting.BudgetReserved"))
				throw new Error("process stopped before activation facts");
			return append(streamId, events, options);
		};
		await expect(
			deploy(
				{ ...deps, store: { ...deps.store, append: interruptedAppend } },
				deployment("crash"),
				actorContext,
			),
		).rejects.toThrow("process stopped");
		const restarted = fx.open();
		expect(restarted.read(new Date(NOW).toISOString()).reservedMicros).toBe(60);
		expect(restarted.lookup("hosting:tenant:crash")?.status).toBe("held");
		await expect(
			deploy(deps, deployment("crash"), actorContext),
		).rejects.toThrow("pending");
		expect(restarted.read(new Date(NOW).toISOString()).reservedMicros).toBe(60);
	});
	it("admits one of two 60-micro commitments against a 100-micro budget across SQLite connections", async () => {
		const fx = fixture(),
			other = fx.open(),
			first = fx.bridge(),
			second = fx.bridge(other);
		const a = proposal(input(fx.authority)),
			b = proposal(input(other));
		const results = await Promise.all([
			reserve(first, "one", a),
			reserve(second, "two", b),
		]);
		expect(
			results.filter((result) => result.ok),
			JSON.stringify(results),
		).toHaveLength(1);
		expect(fx.authority.read(new Date(NOW).toISOString()).reservedMicros).toBe(
			60,
		);
	});
	it("holds shared free allocation exactly once even when both proposals have zero paid cost", async () => {
		const initial = snapshot();
		initial.entitlements = [
			create(BudgetEntitlementSchema, {
				bucketId: "shared",
				unit: "request",
				periodId: "period",
				remainingUnits: 1,
				reservedUnits: 0,
				observedAt: new Date(NOW).toISOString(),
				validUntil: new Date(VALID).toISOString(),
			}),
		];
		const fx = fixture(initial),
			other = fx.open(),
			a = proposal(input(fx.authority)),
			b = proposal(input(other));
		expect(a.reservedMicros).toBe(0);
		const results = await Promise.all([
			reserve(fx.bridge(), "one", a),
			reserve(fx.bridge(other), "two", b),
		]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(
			fx.authority.read(new Date(NOW).toISOString()).entitlements[0]
				?.reservedUnits,
		).toBe(1);
	});
	it("rejects cross-tenant evidence and understated financial allocations", async () => {
		const fx = fixture(),
			valid = proposal(input(fx.authority));
		expect(
			(await reserve(fx.bridge(), "foreign", { ...valid, tenantId: "foreign" }))
				.ok,
		).toBe(false);
		expect(
			(
				await reserve(fx.bridge(), "understated", {
					...valid,
					reservedMicros: 1,
				})
			).ok,
		).toBe(false);
		const forged = structuredClone(valid);
		forged.evidence.quotes[0].rateMicros = 1;
		const recomputed = proposal(forged.evidence);
		expect((await reserve(fx.bridge(), "forged-trusted", recomputed)).ok).toBe(
			false,
		);
		expect(fx.authority.read(new Date(NOW).toISOString()).reservedMicros).toBe(
			0,
		);
	});
	it("rejects a genuine partial commitment that omits a resource from trusted usage evidence", async () => {
		const fx = fixture(),
			original = input(fx.authority);
		const evidence: HostingPlanningInput = {
			...original,
			usages: [
				...original.usages,
				{ ...original.usages[0], resourceName: "worker" },
			],
			quotes: [
				...original.quotes,
				{ ...original.quotes[0], id: "quote:worker", resourceName: "worker" },
			],
		};
		const partial = proposal(evidence);
		expect(
			partial.allocations.map((allocation) => allocation.resourceName),
		).toEqual(["app"]);
		const bridge = fx.bridge(fx.authority, {
			revalidate: async () => evidence,
		});
		expect(await reserve(bridge, "partial", partial)).toMatchObject({
			ok: false,
			reason: expect.stringContaining("every resource"),
		});
		expect(fx.authority.lookup("partial")).toBeUndefined();
	});
	it("reserves a fractional time allowance exactly in integer base units", async () => {
		const initial = snapshot();
		initial.entitlements = [
			create(BudgetEntitlementSchema, {
				bucketId: "half-hour",
				unit: "time-ms",
				periodId: "period",
				remainingUnits: 1_800_000,
				observedAt: new Date(NOW).toISOString(),
				validUntil: new Date(VALID).toISOString(),
			}),
		];
		const fx = fixture(initial),
			ordinary = input(fx.authority);
		const evidence: HostingPlanningInput = {
			...ordinary,
			quotes: ordinary.quotes.map((quote) => ({
				...quote,
				billingUnit: "hour",
			})),
			usages: [
				{
					resourceName: "app",
					unit: "time-ms",
					expectedQuantity: 1_800_000,
					boundedQuantity: 1_800_000,
				},
			],
			entitlements: ordinary.entitlements.map((entitlement) => ({
				...entitlement,
				unit: "hour",
				remainingQuantity: 0.5,
			})),
		};
		const commitment = proposal(evidence),
			bridge = fx.bridge(fx.authority, { revalidate: async () => evidence });
		expect(commitment.reservedMicros).toBe(0);
		expect(await reserve(bridge, "time", commitment)).toMatchObject({
			ok: true,
		});
		expect(
			fx.authority.read(new Date(NOW).toISOString()).entitlements[0]
				?.reservedUnits,
		).toBe(1_800_000);
	});
	it("rechecks the trusted clock after asynchronous financial revalidation", async () => {
		const fx = fixture(),
			commitment = proposal(input(fx.authority));
		const bridge = fx.bridge(fx.authority, {
			revalidate: async () => {
				const evidence = input(fx.authority);
				fx.setClock(VALID);
				return evidence;
			},
		});
		expect((await reserve(bridge, "late", commitment)).ok).toBe(false);
		expect(fx.authority.lookup("late")).toBeUndefined();
	});
	it("reopens a crash-persisted reservation and replays only its identical authorization", async () => {
		const fx = fixture(),
			commitment = proposal(input(fx.authority));
		expect((await reserve(fx.bridge(), "one", commitment)).ok).toBe(true);
		const restarted = fx.bridge(fx.open());
		expect(await restarted.lookup(ref("one", commitment))).toMatchObject({
			status: "held",
			reservedMicros: 60,
		});
		expect((await reserve(restarted, "one", commitment)).ok).toBe(true);
		expect(fx.authority.read(new Date(NOW).toISOString()).reservedMicros).toBe(
			60,
		);
		expect(
			(
				await restarted.reserve({
					reservationId: "one",
					planHash: `sha256:${"b".repeat(64)}`,
					commitment,
				})
			).ok,
		).toBe(false);
	});
	it("retains unknown charges and requires authoritative retirement/usage evidence to settle", async () => {
		const fx = fixture(),
			bridge = fx.bridge(),
			commitment = proposal(input(fx.authority));
		await reserve(bridge, "one", commitment);
		await bridge.uncertain({
			...ref("one", commitment),
			reason: "provider response lost",
		});
		expect(await bridge.lookup(ref("one", commitment))).toMatchObject({
			status: "uncertain",
			reservedMicros: 60,
		});
		expect((await reserve(bridge, "one", commitment)).ok).toBe(false);
		const bad = fx.bridge(fx.authority, {
			settlement: async () => {
				throw new Error("source retirement remains unconfirmed");
			},
		});
		expect(
			(
				await bad.settle({
					...ref("one", commitment),
					settledMicros: 40,
					evidenceRef: "usage",
					sourceStoppedEvidenceRef: "unconfirmed",
				})
			).ok,
		).toBe(false);
		expect(fx.authority.read(new Date(NOW).toISOString()).reservedMicros).toBe(
			60,
		);
		expect(
			(
				await bridge.settle({
					...ref("one", commitment),
					settledMicros: 40,
					evidenceRef: "usage:verified",
					sourceStoppedEvidenceRef: "retirement:verified",
				})
			).ok,
		).toBe(true);
		expect(await bridge.lookup(ref("one", commitment))).toMatchObject({
			status: "settled",
			settledMicros: 40,
		});
		expect(
			(
				await bridge.settle({
					...ref("one", commitment),
					settledMicros: 40,
					evidenceRef: "usage:verified",
					sourceStoppedEvidenceRef: "retirement:verified",
				})
			).ok,
		).toBe(true);
		expect(fx.authority.read(new Date(NOW).toISOString()).spentMicros).toBe(40);
	});
	it("records an actual overrun even when the caller understates the settlement", async () => {
		const fx = fixture(),
			commitment = proposal(input(fx.authority)),
			bridge = fx.bridge(fx.authority, {
				settlement: async (request) => ({
					actualMicros: 120,
					usageEvidenceRef: request.evidenceRef,
					sourceStoppedEvidenceRef: request.sourceStoppedEvidenceRef,
					providerAccounts: [
						create(ProviderAccountExposureSchema, {
							providerAccountId: "account:host",
							liabilityMicros: 120,
						}),
					],
					entitlementClaims: [],
				}),
			});
		await reserve(bridge, "one", commitment);
		expect(
			(
				await bridge.settle({
					...ref("one", commitment),
					settledMicros: 60,
					evidenceRef: "actual-usage",
					sourceStoppedEvidenceRef: "retired",
				})
			).ok,
		).toBe(false);
		expect(fx.authority.read(new Date(NOW).toISOString())).toMatchObject({
			spentMicros: 120,
			reservedMicros: 0,
		});
		expect(() => proposal(input(fx.authority))).toThrow("aggregate budget");
	});
	it("rejects stale policy/period proposals and respects external commitments plus protected recovery", async () => {
		const initial = snapshot();
		initial.externalCommittedMicros = 20;
		initial.unresolvedMicros = 10;
		initial.recoveryReserveMicros = 15;
		const fx = fixture(initial);
		expect(() => proposal(input(fx.authority))).toThrow("aggregate budget");
		const second = fixture(),
			prior = proposal(input(second.authority)),
			current = second.authority.read(new Date(NOW).toISOString());
		second.authority.configure(
			create(BudgetLedgerSnapshotSchema, {
				...current,
				identity: { ...current.identity, policyRevision: "r2" },
				limitMicros: 50,
			}),
			current.seq,
			new Date(NOW).toISOString(),
		);
		expect((await reserve(second.bridge(), "stale", prior)).ok).toBe(false);
	});
});
