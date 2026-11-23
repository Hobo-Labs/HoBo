import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { inMemoryState, Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BudgetFenceSettlementGuardSchema,
	BudgetReservationSchema,
	BudgetSettlementEvidenceSchema,
	EntitlementClaimSchema,
	IacTargetAdmissionDecisionSchema,
} from "../../../broker/src/_generated/yard_placement_pb.js";
import { hostingQuoteDigest } from "../../../broker/src/index.js";
import {
	alchemyTarget,
	captureAlchemyProgram,
	createAlchemyIacProvider,
} from "../src/index.js";
import type {
	FinancialDecision,
	FinancialPlan,
	FinancialPort,
	IacProgram,
	IacRouteOperation,
	IacRoutePort,
	IacRouteResolver,
	UnpricedScopeProof,
} from "../src/port.js";
import {
	routeFixture,
	testOperation,
	testStateOwnership,
} from "./route-fixture.js";

type Widget = Resource<"Spec.Widget", object, { id: string }>;
const Widget = Resource<Widget>("Spec.Widget");
interface FixtureReservation {
	reservationId: string;
	executionDigest?: string;
	unboundedExposure?: boolean;
	unpricedScopeProof?: UnpricedScopeProof;
}
const dirs: string[] = [];
const priorHome = process.env.ALCHEMY_HOME;

afterEach(() => {
	vi.useRealTimers();
	if (priorHome === undefined) delete process.env.ALCHEMY_HOME;
	else process.env.ALCHEMY_HOME = priorHome;
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture(
	decision: (requestId: string) => object,
	revalidate: (
		admission: FinancialDecision,
		plan: FinancialPlan,
	) => boolean | Promise<boolean> = () => true,
	targetId = "target",
	defaultRequestId: string | null = "logical-attempt",
	route: IacRoutePort | undefined = routeFixture().port,
	routeOperation: IacRouteOperation | null = testOperation,
	resolver?: IacRouteResolver,
	timeout = 5_000,
	configureFinancial?: (
		financial: FinancialPort<{ plan: FinancialPlan }>,
	) => void,
) {
	const dir = mkdtempSync(join(tmpdir(), "hobo-alchemy-financial-"));
	dirs.push(dir);
	process.env.ALCHEMY_HOME = join(dir, "auth");
	let applies = 0;
	let deletions = 0;
	let declarations = 0;
	let admissions = 0;
	let environmentAllowed = true;
	const uncertain: string[] = [];
	const stack = Stack(
		"App",
		{
			providers: Provider.succeed(Widget, {
				reconcile: () =>
					Effect.sync(() => {
						applies++;
						return { id: "widget" };
					}),
				delete: () =>
					Effect.sync(() => {
						deletions++;
					}),
			}),
			state: inMemoryState(),
		},
		Effect.gen(function* () {
			declarations++;
			yield* Widget("widget", {});
			return { output: "ok" };
		}),
	);
	const financial: FinancialPort<{ plan: FinancialPlan }> = {
		assess: (plan) => ({ plan }),
		admit: async (requestId) => {
			admissions++;
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this boundary intentionally tests malformed provider receipts.
			return decision(requestId) as never;
		},
		revalidate,
		uncertain: (id) => {
			uncertain.push(id);
		},
	};
	configureFinancial?.(financial);
	const provider = createAlchemyIacProvider({
		stack,
		operationTimeoutMs: timeout,
		stateOwnership: testStateOwnership,
		composite: {
			proofRef: "test:no-source",
			environmentDigest: `sha256:${"e".repeat(64)}`,
			sourceRequirements: [],
			verifyEnvironment: () => environmentAllowed,
			verifyPlan: ({ scope, sourceClaims }) =>
				sourceClaims.length === 0 &&
				scope.every((entry) => entry.resourceType === "Spec.Widget"),
		},
		runtimeLayer: Alchemist.layer(),
		runtimeDirectory: join(dir, "runtime"),
		route,
		resolveRoute:
			routeOperation === null
				? undefined
				: (resolver ??
					(({ requestId }) => ({
						requestId: requestId ?? defaultRequestId ?? "",
						operation: routeOperation,
					}))),
		target: alchemyTarget({
			targetId,
			tenantId: "tenant",
			stackName: "App",
			stage: "test",
			programResourceId: "app",
			sourceDigest: `sha256:${"a".repeat(64)}`,
			inventoryEvidenceRef: "inventory:1",
			resources: [
				{
					resourceId: "widget",
					resourceType: "Spec.Widget",
					providerId: "test",
					providerAccountRef: "account",
					productId: "widget",
				},
			],
		}),
		financial,
	});
	return {
		provider,
		financial,
		applies: () => applies,
		deletions: () => deletions,
		declarations: () => declarations,
		revokeEnvironment: () => {
			environmentAllowed = false;
		},
		admissions: () => admissions,
		uncertain,
		program: {
			programId: "p",
			deploymentId: "d",
			resourceId: "app",
			provider: "test",
			driver: "external",
			action: "apply" as const,
			stackName: "App",
			operationGeneration: "generation-1",
		},
	};
}

function admitted(
	requestId: string,
	evaluation: string,
	unboundedExposure?: boolean,
) {
	const reservation: FixtureReservation = {
		reservationId: `iac:${requestId}`,
		executionDigest: `sha256:${"4".repeat(64)}`,
	};
	if (unboundedExposure !== undefined)
		reservation.unboundedExposure = unboundedExposure;
	if (unboundedExposure === true)
		reservation.unpricedScopeProof = {
			identity: {
				tenantId: "tenant",
				budgetId: "hosting",
				periodId: "period",
				policyRevision: "r1",
			},
			providerAccountIds: ["account"],
			authorityRef: "host:finance",
			evidenceRef: "scope:proof",
			ownershipEpoch: "1",
			observedAt: "2026-01-01T00:00:00Z",
			exclusiveUntilSettled: true,
			noSharedEntitlements: true,
			signature: "signature",
		};
	return {
		requestId,
		targetId: "target",
		status: "admitted",
		code: "",
		message: "",
		requestDigest: `sha256:${"b".repeat(64)}`,
		inventoryHash: `sha256:${"c".repeat(64)}`,
		modelHash: evaluation === "allowed" ? `sha256:${"d".repeat(64)}` : "",
		quoteHash: evaluation === "allowed" ? `sha256:${"e".repeat(64)}` : "",
		unpricedPolicyProof:
			evaluation === "bypassed"
				? {
						requestDigest: `sha256:${"b".repeat(64)}`,
						inventoryHash: `sha256:${"c".repeat(64)}`,
						identity: {
							tenantId: "tenant",
							budgetId: "hosting",
							periodId: "period",
							policyRevision: "r1",
						},
						policyHash: "sha256:policy",
						effect: "allow",
						evidenceRef: "host:policy",
						obligationsSatisfied: true,
						observedAt: "2026-01-01T00:00:00Z",
						validUntil: "2027-01-01T00:00:00Z",
					}
				: undefined,
		budget: { evaluation, reservation: "held" },
		reservation,
	};
}

function hostileProxy<T extends object>(
	value: T,
	observed: { traps: number },
	revoked: boolean,
): T {
	const proxy = Proxy.revocable(value, {
		ownKeys() {
			observed.traps++;
			throw new Error("ownKeys trap");
		},
		getOwnPropertyDescriptor() {
			observed.traps++;
			throw new Error("descriptor trap");
		},
		get(_target, key) {
			if (key === "then") return undefined;
			observed.traps++;
			throw new Error("get trap");
		},
		getPrototypeOf() {
			observed.traps++;
			throw new Error("prototype trap");
		},
	});
	if (revoked) proxy.revoke();
	return proxy.proxy;
}

function generatedAdmission(id: string, mode: "priced" | "unpriced") {
	const base = admitted(
		id,
		mode === "priced" ? "allowed" : "bypassed",
		mode === "unpriced",
	);
	const identity = {
		tenantId: "tenant",
		budgetId: "hosting",
		periodId: "period",
		policyRevision: "r1",
	};
	if (mode === "unpriced") {
		const scope = base.reservation.unpricedScopeProof;
		const policy = base.unpricedPolicyProof;
		if (scope === undefined || policy === undefined)
			throw new Error("fixture proof missing");
		return create(IacTargetAdmissionDecisionSchema, {
			...base,
			reservation: {
				...base.reservation,
				identity,
				requestDigest: base.requestDigest,
				status: "held",
				unpricedPolicyProof: policy,
				unpricedScopeProof: {
					...scope,
					providerAccountIds: [...scope.providerAccountIds],
				},
				providerAccounts: [
					{ providerAccountId: "account", liabilityMicros: 0 },
				],
			},
		});
	}
	const quoteId = `sha256:${"a".repeat(64)}`;
	const observedAt = "2026-01-01T00:00:00Z";
	const validUntil = "2027-01-01T00:00:00Z";
	const entitlementClaims = [
		{ bucketId: "shared", kind: "allowance", unit: "request", units: 1 },
		{ bucketId: "shared", kind: "allowance", unit: "runner-ms", units: 2 },
	];
	const decision = create(IacTargetAdmissionDecisionSchema, {
		...base,
		quote: {
			quoteId,
			yardId: "target",
			providerId: "test",
			ownerTenantId: "tenant",
			currency: "USD",
			totalMicros: 10,
			liabilityBoundMicros: 10,
			observedAt,
			validUntil,
			components: [{ name: "joint", costMicros: 10 }],
			requestDigest: base.requestDigest,
			providerAccounts: [{ providerAccountId: "account", liabilityMicros: 10 }],
			entitlementClaims,
			financialPlanHash: quoteId,
		},
		policyProof: {
			requestDigest: base.requestDigest,
			quoteId,
			identity,
			policyHash: "policy",
			effect: "allow",
			evidenceRef: "evidence",
			obligationsSatisfied: true,
		},
		reservation: {
			reservationId: base.reservation.reservationId,
			executionDigest: base.reservation.executionDigest,
			unboundedExposure: false,
			identity,
			requestDigest: base.requestDigest,
			quoteId,
			financialPlanHash: quoteId,
			reservedMicros: 10,
			status: "held",
			providerAccounts: [{ providerAccountId: "account", liabilityMicros: 10 }],
			entitlementClaims,
			iacPricingPin: {
				planDigest: `sha256:${"1".repeat(64)}`,
				inventoryHash: base.inventoryHash,
				modelHash: base.modelHash,
				quoteHash: base.quoteHash,
				evidenceHash: `sha256:${"2".repeat(64)}`,
				validUntil,
			},
		},
	});
	if (decision.quote && decision.policyProof)
		decision.policyProof.quoteDigest = hostingQuoteDigest(decision.quote);
	return decision;
}

describe("financial admission modes", () => {
	it("preserves the host receiver across a suspended admission callback", async () => {
		let release = () => {};
		let entered = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const route = routeFixture();
		let receiver:
			| (FinancialPort<{ plan: FinancialPlan }> & { authorized: boolean })
			| undefined;
		const f = fixture(
			() => ({}),
			() => true,
			"target",
			"attempt",
			route.port,
			testOperation,
			undefined,
			5_000,
			(financial) => {
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the test adds explicit mutable host-owned receiver state.
				receiver = Object.assign(financial, {
					authorized: true,
				}) as FinancialPort<{ plan: FinancialPlan }> & { authorized: boolean };
				financial.admit = async function (requestId) {
					entered();
					await gate;
					// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this is the exact test receiver assigned above.
					const current = this as FinancialPort<{ plan: FinancialPlan }> & {
						authorized: boolean;
					};
					return current.authorized
						? admitted(requestId, "allowed", false)
						: {
								requestId,
								targetId: "target",
								status: "denied",
								code: "BUDGET_DENIED",
								message: "",
								budget: { evaluation: "denied", reservation: "not-created" },
							};
				};
			},
		);
		await f.provider.preview(f.program);
		const pending = f.provider.applyWithAdmission(f.program, "attempt");
		await started;
		if (receiver === undefined) throw new Error("missing host receiver");
		receiver.authorized = false;
		release();
		await expect(pending).rejects.toMatchObject({ code: "BUDGET_DENIED" });
		expect(route.calls.denied).toBe(1);
		expect(f.applies()).toBe(0);
	});
	it("does not accept a foreign route permit through substituted reflection", async () => {
		const route = routeFixture();
		const original = Object.getOwnPropertyDescriptor;
		let substitutions = 0;
		const foreignRoute: IacRoutePort = {
			...route.port,
			runDirect: (input, run) =>
				route.port.runDirect(input, (attempt) => {
					const permit = { ...attempt.permit, tenantId: "foreign" };
					Object.getOwnPropertyDescriptor = (value, key) => {
						if (value === permit && key === "tenantId") {
							substitutions++;
							return { value: "tenant", enumerable: true, configurable: true };
						}
						return original(value, key);
					};
					return run({ ...attempt, permit });
				}),
		};
		const f = fixture(
			(id) => ({
				requestId: id,
				targetId: "target",
				status: "denied",
				code: "BUDGET_DENIED",
				message: "",
				budget: { evaluation: "denied", reservation: "not-created" },
			}),
			() => true,
			"target",
			"attempt",
			foreignRoute,
		);
		await f.provider.preview(f.program);
		let result: unknown;
		try {
			await f.provider.applyWithAdmission(f.program, "attempt");
		} catch (error) {
			result = error;
		} finally {
			Object.getOwnPropertyDescriptor = original;
		}
		expect(result).toMatchObject({ requiresReconciliation: true });
		expect(substitutions).toBe(0);
		expect(route.calls.denied).toBe(0);
		expect(f.admissions()).toBe(0);
		expect(f.applies()).toBe(0);
	});

	it("does not treat an inherited descriptor-map budget as a definitive denial", async () => {
		const route = routeFixture();
		const previous = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"budget",
		);
		const f = fixture(
			(id) => {
				Object.defineProperty(Object.prototype, "budget", {
					configurable: true,
					value: {
						value: { evaluation: "denied", reservation: "not-created" },
					},
				});
				return {
					requestId: id,
					targetId: "target",
					status: "denied",
					code: "BUDGET_DENIED",
					message: "",
				};
			},
			() => true,
			"target",
			"attempt",
			route.port,
		);
		await f.provider.preview(f.program);
		let result: unknown;
		try {
			await f.provider.applyWithAdmission(f.program, "attempt");
		} catch (error) {
			result = error;
		} finally {
			if (previous === undefined)
				Reflect.deleteProperty(Object.prototype, "budget");
			else Object.defineProperty(Object.prototype, "budget", previous);
		}
		expect(result).toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(route.calls.denied).toBe(0);
		expect(f.admissions()).toBe(1);
		expect(f.applies()).toBe(0);
	});
	it("keeps an accessor-backed denial uncertain even when its descriptor inherits a forged value", async () => {
		const route = routeFixture();
		const oldValue = Object.getOwnPropertyDescriptor(Object.prototype, "value");
		let traps = 0;
		const f = fixture(
			(id) => {
				const budget = { evaluation: "denied", reservation: "not-created" };
				const decision = Object.defineProperty(
					{
						requestId: id,
						targetId: "target",
						status: "denied",
						code: "BUDGET_DENIED",
						message: "",
					},
					"budget",
					{
						enumerable: true,
						get() {
							traps++;
							return budget;
						},
					},
				);
				Object.defineProperty(Object.prototype, "value", {
					configurable: true,
					get() {
						traps++;
						return budget;
					},
				});
				return decision;
			},
			() => true,
			"target",
			"attempt",
			route.port,
		);
		await f.provider.preview(f.program);
		let result: unknown;
		try {
			await f.provider.applyWithAdmission(f.program, "attempt");
		} catch (error) {
			result = error;
		} finally {
			if (oldValue === undefined)
				Reflect.deleteProperty(Object.prototype, "value");
			else Object.defineProperty(Object.prototype, "value", oldValue);
		}
		expect(traps).toBe(0);
		expect(result).toMatchObject({
			code: "ADMISSION_OUTCOME_UNKNOWN",
			requiresReconciliation: true,
		});
		expect(route.calls.denied).toBe(0);
		expect(f.admissions()).toBe(1);
		expect(f.applies()).toBe(0);
		expect(traps).toBe(0);
	});
	it("does not inspect or report a foreign reservation with unsupported evidence", async () => {
		const route = routeFixture();
		const f = fixture(
			(id) => {
				const decision = generatedAdmission(id, "priced");
				if (decision.reservation === undefined)
					throw new Error("fixture reservation missing");
				decision.reservation.reservationId = "iac:foreign";
				Object.defineProperty(decision.reservation, "fenceSettlementGuard", {
					value: {},
					enumerable: true,
				});
				return decision;
			},
			() => true,
			"target",
			"attempt",
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
			reservationId: undefined,
			admission: undefined,
		});
		expect(f.uncertain).toEqual([]);
		expect(route.calls.denied).toBe(0);
		expect(f.applies()).toBe(0);
	});

	it("rejects proxied or accessor-backed fence evidence without invoking it", async () => {
		for (const mode of ["proxy", "revoked", "accessor"] as const) {
			const observed = { traps: 0 };
			const route = routeFixture();
			const f = fixture(
				(id) => {
					const decision = generatedAdmission(id, "priced");
					if (decision.reservation === undefined)
						throw new Error("fixture reservation missing");
					if (mode === "accessor")
						Object.defineProperty(
							decision.reservation,
							"fenceSettlementGuard",
							{
								enumerable: true,
								get() {
									observed.traps++;
									throw new Error("fence getter");
								},
							},
						);
					else
						Object.defineProperty(
							decision.reservation,
							"fenceSettlementGuard",
							{
								enumerable: true,
								value: hostileProxy({}, observed, mode === "revoked"),
							},
						);
					return decision;
				},
				() => true,
				"target",
				"attempt",
				route.port,
			);
			await f.provider.preview(f.program);
			await expect(
				f.provider.applyWithAdmission(f.program, "attempt"),
			).rejects.toMatchObject({
				code:
					mode === "accessor"
						? "ADMISSION_RECEIPT_INVALID"
						: "ADMISSION_UNSUPPORTED_EVIDENCE",
				requiresReconciliation: true,
				reservationId: "iac:attempt",
			});
			expect(observed.traps).toBe(0);
			expect(route.calls.denied).toBe(0);
			expect(f.applies()).toBe(0);
		}
	});
	it.each([
		["fenceSettlementGuard", "empty", "admitted"],
		["fenceSettlementGuard", "complete", "admitted"],
		["fenceSettlementGuard", "partial-placement", "replay"],
		["settlementEvidence", "empty", "replay"],
		["settlementEvidence", "complete", "uncertain"],
	] as const)("treats %s %s on %s as unsupported and uncertain", async (field, content, status) => {
		const route = routeFixture();
		const f = fixture(
			(id) => {
				const decision = generatedAdmission(id, "priced");
				const reservation = decision.reservation;
				if (reservation === undefined)
					throw new Error("fixture reservation missing");
				decision.status = status;
				decision.code = status === "admitted" ? "" : "ALREADY_CLAIMED";
				const placement = {
					yardId: "yard",
					campId: "camp",
					providerId: "provider",
					providerAccountId: "account",
					resourceId: "resource",
					deploymentId: "deployment",
					incarnationId: "incarnation",
					manifestHash: `sha256:${"1".repeat(64)}`,
					planHash: `sha256:${"2".repeat(64)}`,
				};
				const fullFence = create(BudgetFenceSettlementGuardSchema, {
					contract: "hobo.budget-fence-guard/v1",
					dataset: "dataset",
					scopeTenant: "",
					operationId: "operation",
					fenceTokenDigest: `sha256:${"3".repeat(64)}`,
					receiverKeyId: "receiver",
					receiverPublicKey: "receiver-key",
					financeKeyId: "finance",
					financePublicKey: "finance-key",
					logicalCampId: "camp",
					source: placement,
					destination: placement,
					decision: "to-target",
					executionDigest: `sha256:${"4".repeat(64)}`,
					routeDigest: `sha256:${"5".repeat(64)}`,
					expectedRouteGeneration: "1",
					currentSetId: "current",
					desiredSetId: "desired",
					migrationId: "migration",
					decisionHead: "1",
				});
				const fullSettlement = create(BudgetSettlementEvidenceSchema, {
					usageEvidenceRef: "usage",
					sourceStoppedEvidenceRef: "stopped",
					providerAccounts: [
						{ providerAccountId: "account", liabilityMicros: 10 },
					],
					entitlementClaims: [],
					fenceOperationReceiptJson: "receipt",
					financeSignature: "signature",
				});
				const value =
					content === "empty"
						? {}
						: content === "partial-placement"
							? { ...fullFence, source: {} }
							: field === "fenceSettlementGuard"
								? fullFence
								: fullSettlement;
				Object.defineProperty(reservation, field, { value, enumerable: true });
				return decision;
			},
			() => true,
			"target",
			"attempt",
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_UNSUPPORTED_EVIDENCE",
			executionOutcome: "not-started",
			requiresReconciliation: true,
			reservationId: "iac:attempt",
		});
		expect(f.uncertain).toContain("iac:attempt");
		expect(route.calls.denied).toBe(0);
		expect(f.applies()).toBe(0);
	});

	it.each([
		"priced",
		"unpriced",
	] as const)("accepts generated %s receipts with explicitly absent fence and settlement metadata", async (mode) => {
		const f = fixture((id) => {
			const decision = generatedAdmission(id, mode);
			if (decision.reservation === undefined)
				throw new Error("fixture reservation missing");
			decision.reservation.fenceSettlementGuard = undefined;
			decision.reservation.settlementEvidence = undefined;
			return decision;
		});
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).resolves.toBeDefined();
		expect(f.applies()).toBe(1);
	});
	it("retains a generated unpriced uncertain hold whose nested digest is omitted", async () => {
		const route = routeFixture();
		const f = fixture(
			(id) =>
				create(IacTargetAdmissionDecisionSchema, {
					requestId: id,
					targetId: "target",
					status: "uncertain",
					code: "EXECUTION_CLAIM_UNCERTAIN",
					requestDigest: `sha256:${"b".repeat(64)}`,
					budget: { evaluation: "unavailable", reservation: "held" },
					reservation: { reservationId: `iac:${id}`, unboundedExposure: true },
				}),
			() => true,
			"target",
			"attempt",
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "EXECUTION_CLAIM_UNCERTAIN",
			requiresReconciliation: true,
			reservationId: "iac:attempt",
		});
		expect(route.calls.denied).toBe(0);
		expect(f.applies()).toBe(0);
	});
	it("reads only fixed route fields even with many unrelated own properties", async () => {
		const protectedInputs = new Set<unknown>();
		const decorate = <T extends object>(value: T): T => {
			for (let index = 0; index < 10_000; index++)
				Object.defineProperty(value, `extra-${index}`, { value: index });
			protectedInputs.add(value);
			return value;
		};
		const expected = decorate({
			targetId: "target",
			inventoryHash: `sha256:${"c".repeat(64)}`,
			modelHash: `sha256:${"d".repeat(64)}`,
			quoteHash: `sha256:${"e".repeat(64)}`,
		});
		const permit = decorate({
			tenantId: "tenant",
			requestId: "attempt",
			operationId: testOperation.operationId,
			targetId: "target",
			inventoryHash: expected.inventoryHash,
			attemptId: "A".repeat(43),
		});
		const operation = decorate({ ...testOperation });
		const resolution = decorate({ requestId: "attempt", operation });
		const base = routeFixture();
		const route: IacRoutePort = {
			...base.port,
			async runDirect(input, run) {
				return decorate(await base.port.runDirect(input, run));
			},
		};
		const direct = fixture(
			(id) => admitted(id, "allowed", false),
			() => true,
			"target",
			"attempt",
			route,
			testOperation,
			() => resolution,
		);
		const supplied = fixture(
			(id) => admitted(id, "allowed", false),
			() => true,
			"target",
			"attempt",
			route,
			testOperation,
			() => resolution,
		);
		await direct.provider.preview(direct.program);
		await supplied.provider.preview(supplied.program);
		const original = Object.getOwnPropertyDescriptors;
		let enumerations = 0;
		Object.getOwnPropertyDescriptors = (value) => {
			if (protectedInputs.has(value)) {
				enumerations++;
				throw new Error("unexpected whole-object enumeration");
			}
			return original(value);
		};
		try {
			await expect(
				direct.provider.applyWithAdmission(direct.program, "attempt"),
			).resolves.toBeDefined();
			await expect(
				supplied.provider.applyWithAdmission(
					supplied.program,
					"attempt",
					expected,
					permit,
				),
			).resolves.toBeDefined();
			expect(enumerations).toBe(0);
		} finally {
			Object.getOwnPropertyDescriptors = original;
		}
	});
	it.each([
		"priced",
		"unpriced",
	] as const)("accepts a generated broker %s admission", async (mode) => {
		const f = fixture((id) => generatedAdmission(id, mode));
		await f.provider.preview(f.program);
		const result = await f.provider.applyWithAdmission(f.program, "attempt");
		expect(result.admission.budget.evaluation).toBe(
			mode === "priced" ? "allowed" : "bypassed",
		);
		expect(f.applies()).toBe(1);
	});

	it.each([
		"denied",
		"replay",
		"uncertain",
	] as const)("accepts the generated broker %s failure shape without starting the provider", async (status) => {
		const route = routeFixture();
		const f = fixture(
			(id) => {
				const decision = create(IacTargetAdmissionDecisionSchema, {
					requestId: id,
					targetId: "target",
					status,
					code:
						status === "denied"
							? "BUDGET_DENIED"
							: status === "replay"
								? "EXECUTION_ALREADY_CLAIMED"
								: "ADMISSION_OUTCOME_UNKNOWN",
					message: "",
					budget: {
						evaluation: status === "replay" ? "allowed" : "unavailable",
						reservation:
							status === "denied"
								? "not-created"
								: status === "replay"
									? "held"
									: "unknown",
					},
				});
				if (status === "replay")
					decision.reservation = create(BudgetReservationSchema, {
						reservationId: `iac:${id}`,
						status: "held",
					});
				return decision;
			},
			() => true,
			"target",
			"attempt",
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code:
				status === "denied"
					? "BUDGET_DENIED"
					: status === "replay"
						? "EXECUTION_ALREADY_CLAIMED"
						: "ADMISSION_OUTCOME_UNKNOWN",
			requiresReconciliation: status !== "denied",
		});
		expect(f.applies()).toBe(0);
		expect(route.calls.denied).toBe(status === "denied" ? 1 : 0);
	});

	it("normalizes explicit undefined optional proof fields to absence", async () => {
		const f = fixture((id) => {
			const decision = admitted(id, "allowed", false);
			Object.defineProperty(decision.reservation, "unpricedScopeProof", {
				value: undefined,
				enumerable: true,
			});
			Object.defineProperty(decision.reservation, "unpricedPolicyProof", {
				value: undefined,
				enumerable: true,
			});
			return decision;
		});
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).resolves.toBeDefined();
		expect(f.applies()).toBe(1);
	});

	it("treats explicitly undefined optional denial evidence as absent", async () => {
		const route = routeFixture();
		const f = fixture(
			(id) => ({
				requestId: id,
				targetId: "target",
				status: "denied",
				code: "BUDGET_DENIED",
				message: "",
				budget: { evaluation: "denied", reservation: "not-created" },
				reservation: undefined,
				unpricedPolicyProof: undefined,
				policyProof: undefined,
				quote: undefined,
			}),
			() => true,
			"target",
			"attempt",
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "BUDGET_DENIED",
			requiresReconciliation: false,
		});
		expect(route.calls.denied).toBe(1);
		expect(f.applies()).toBe(0);
	});

	it("rejects an accessor-backed nested scope without calling it", async () => {
		let calls = 0;
		const f = fixture((id) => {
			const decision = generatedAdmission(id, "unpriced");
			if (decision.reservation === undefined)
				throw new Error("fixture reservation missing");
			Object.defineProperty(decision.reservation, "unpricedScopeProof", {
				enumerable: true,
				get() {
					calls++;
					return undefined;
				},
			});
			return decision;
		});
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(calls).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
		expect(f.applies()).toBe(0);
	});

	it.each([
		"policy-null",
		"policy-empty",
		"policy-unknown",
		"policy-wire-unknown",
		"nested-policy",
		"nested-policy-mismatch",
		"scope-unknown",
		"scope-accounts-undefined",
		"priced-policy-number",
		"priced-policy-empty",
		"quote-empty",
		"reservation-number",
		"reservation-status",
		"reservation-liability",
		"reservation-accounts",
		"reservation-entitlements",
		"duplicate-entitlement-kind-alias",
		"quote-liability",
		"quote-components",
		"quote-currency",
		"pin-expiry",
		"missing-quote",
		"missing-priced-policy",
		"unknown-receipt",
		"unknown-reservation",
		"fractional-reservation",
		"foreign-priced-policy",
		"empty-policy-quote-digest",
		"quote-work-digest",
		"kindless-claims",
	] as const)("rejects malformed or conflicting %s evidence instead of discarding it", async (kind) => {
		const route = routeFixture();
		const f = fixture(
			(id) => {
				const decision =
					kind.startsWith("policy-") ||
					kind.startsWith("nested-") ||
					kind.startsWith("scope-")
						? generatedAdmission(id, "unpriced")
						: generatedAdmission(id, "priced");
				const reservation = decision.reservation;
				if (reservation === undefined)
					throw new Error("fixture reservation missing");
				const policy = decision.unpricedPolicyProof;
				const scope = reservation.unpricedScopeProof;
				if (kind === "policy-null")
					Object.defineProperty(decision, "unpricedPolicyProof", {
						value: null,
						enumerable: true,
					});
				if (kind === "policy-empty")
					Object.defineProperty(decision, "unpricedPolicyProof", {
						value: {},
						enumerable: true,
					});
				if (kind === "policy-unknown" && policy)
					Object.defineProperty(policy, "future", {
						value: undefined,
						enumerable: true,
					});
				if (kind === "policy-wire-unknown" && policy)
					Object.defineProperty(policy, "$unknown", {
						value: [],
						enumerable: true,
					});
				if (kind === "nested-policy")
					Object.defineProperty(reservation, "unpricedPolicyProof", {
						value: {},
						enumerable: true,
					});
				if (kind === "nested-policy-mismatch" && policy)
					Object.defineProperty(reservation, "unpricedPolicyProof", {
						value: { ...policy, evidenceRef: "different" },
						enumerable: true,
					});
				if (kind === "scope-unknown" && scope)
					Object.defineProperty(scope, "future", {
						value: true,
						enumerable: true,
					});
				if (kind === "scope-accounts-undefined" && scope)
					Object.defineProperty(scope, "providerAccountIds", {
						value: undefined,
						enumerable: true,
					});
				if (kind === "priced-policy-number")
					Object.defineProperty(decision, "policyProof", {
						value: 42,
						enumerable: true,
					});
				if (kind === "priced-policy-empty")
					Object.defineProperty(decision, "policyProof", {
						value: {},
						enumerable: true,
					});
				if (kind === "quote-empty")
					Object.defineProperty(decision, "quote", {
						value: {},
						enumerable: true,
					});
				if (kind === "reservation-number")
					Object.defineProperty(reservation, "reservedMicros", {
						value: "bad",
						enumerable: true,
					});
				if (kind === "reservation-status") reservation.status = "released";
				if (kind === "reservation-liability") reservation.reservedMicros = 5;
				if (kind === "reservation-accounts") {
					const account = reservation.providerAccounts[0];
					if (account === undefined) throw new Error("fixture account missing");
					account.liabilityMicros = 5;
				}
				if (kind === "reservation-entitlements")
					reservation.entitlementClaims.push(
						create(EntitlementClaimSchema, {
							bucketId: "quota",
							unit: "item",
							units: 1,
						}),
					);
				if (kind === "duplicate-entitlement-kind-alias" && decision.quote) {
					const claim = decision.quote.entitlementClaims[0];
					if (claim === undefined) throw new Error("fixture claim missing");
					const kindlessClaim = {
						bucketId: claim.bucketId,
						unit: claim.unit,
						units: claim.units,
					};
					decision.quote.entitlementClaims.push(
						create(EntitlementClaimSchema, kindlessClaim),
					);
					reservation.entitlementClaims.push(
						create(EntitlementClaimSchema, kindlessClaim),
					);
				}
				if (kind === "quote-liability" && decision.quote)
					decision.quote.liabilityBoundMicros = 5;
				if (kind === "quote-components" && decision.quote) {
					const component = decision.quote.components[0];
					if (component === undefined)
						throw new Error("fixture component missing");
					component.costMicros = 5;
				}
				if (kind === "quote-currency" && decision.quote)
					decision.quote.currency = "EUR";
				if (kind === "pin-expiry" && reservation.iacPricingPin)
					reservation.iacPricingPin.validUntil = "2028-01-01T00:00:00Z";
				if (kind === "missing-quote") decision.quote = undefined;
				if (kind === "missing-priced-policy") decision.policyProof = undefined;
				if (kind === "unknown-receipt")
					Object.defineProperty(decision, "future", {
						value: undefined,
						enumerable: true,
					});
				if (kind === "unknown-reservation")
					Object.defineProperty(reservation, "future", {
						value: true,
						enumerable: true,
					});
				if (kind === "fractional-reservation") reservation.reservedMicros = 5.5;
				if (kind === "foreign-priced-policy" && decision.policyProof?.identity)
					decision.policyProof.identity.tenantId = "other";
				if (kind === "empty-policy-quote-digest" && decision.policyProof)
					decision.policyProof.quoteDigest = "";
				if (kind === "kindless-claims" && decision.quote) {
					for (const claim of decision.quote.entitlementClaims) claim.kind = "";
					for (const claim of reservation.entitlementClaims) claim.kind = "";
				}
				if (kind === "quote-work-digest" && decision.quote)
					decision.quote.workDigest = `sha256:${"9".repeat(64)}`;
				return decision;
			},
			() => true,
			"target",
			"attempt",
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(route.calls.denied).toBe(0);
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toContain("iac:attempt");
	});

	it.each([
		"reservation",
		"unknown-field",
		"unknown-wire",
		"invalid-policy",
		"positive-policy",
		"quote",
	] as const)("does not treat a denial carrying %s as a definitive no-effect denial", async (kind) => {
		const route = routeFixture();
		const f = fixture(
			(id) => {
				const decision = create(IacTargetAdmissionDecisionSchema, {
					requestId: id,
					targetId: "target",
					status: "denied",
					code: "BUDGET_DENIED",
					budget: { evaluation: "denied", reservation: "not-created" },
				});
				if (kind === "reservation")
					decision.reservation = create(IacTargetAdmissionDecisionSchema, {
						reservation: { reservationId: `iac:${id}`, status: "held" },
					}).reservation;
				if (kind === "unknown-field")
					Object.defineProperty(decision, "future", {
						value: undefined,
						enumerable: true,
					});
				if (kind === "unknown-wire")
					Object.defineProperty(decision, "$unknown", {
						value: [],
						enumerable: true,
					});
				if (kind === "invalid-policy")
					Object.defineProperty(decision, "unpricedPolicyProof", {
						value: {},
						enumerable: true,
					});
				if (kind === "positive-policy")
					decision.unpricedPolicyProof = generatedAdmission(
						id,
						"unpriced",
					).unpricedPolicyProof;
				if (kind === "quote")
					decision.quote = generatedAdmission(id, "priced").quote;
				return decision;
			},
			() => true,
			"target",
			"attempt",
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(route.calls.denied).toBe(0);
		expect(f.applies()).toBe(0);
		if (kind === "reservation") expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("does not mark a foreign-target reservation uncertain", async () => {
		const f = fixture((id) => ({
			...admitted(id, "allowed", false),
			targetId: "other",
		}));
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(f.uncertain).toEqual([]);
		expect(f.applies()).toBe(0);
	});

	it.each([
		"admitted",
		"replay",
		"uncertain",
		"denied",
	] as const)("never exposes or marks a foreign reservation on a %s receipt", async (status) => {
		const route = routeFixture();
		const f = fixture(
			(id) => {
				const decision = admitted(id, "allowed", false);
				decision.status = status;
				decision.code = status === "admitted" ? "" : "RECEIPT_FAILED";
				if (status === "denied")
					decision.budget = {
						evaluation: "denied",
						reservation: "not-created",
					};
				if (status === "uncertain")
					decision.budget = {
						evaluation: "unavailable",
						reservation: "uncertain",
					};
				decision.reservation.reservationId = "iac:foreign";
				return decision;
			},
			() => true,
			"target",
			"attempt",
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
			reservationId: undefined,
			admission: undefined,
		});
		expect(f.uncertain).toEqual([]);
		expect(route.calls.denied).toBe(0);
		expect(f.applies()).toBe(0);
	});

	it.each([
		"foreign-request",
		"foreign-target",
		"foreign-tenant",
		"foreign-digest",
		"uninspectable-identity",
	] as const)("does not disclose a reservation with %s evidence", async (kind) => {
		const route = routeFixture();
		const f = fixture(
			(id) => {
				const decision = generatedAdmission(id, "priced");
				const reservation = decision.reservation;
				if (reservation === undefined || reservation.identity === undefined)
					throw new Error("fixture identity missing");
				if (kind === "foreign-request") decision.requestId = "other";
				if (kind === "foreign-target") decision.targetId = "other";
				if (kind === "foreign-tenant") reservation.identity.tenantId = "other";
				if (kind === "foreign-digest")
					reservation.requestDigest = `sha256:${"f".repeat(64)}`;
				if (kind === "uninspectable-identity")
					Object.defineProperty(reservation, "identity", {
						get() {
							throw new Error("identity getter");
						},
						enumerable: true,
					});
				return decision;
			},
			() => true,
			"target",
			"attempt",
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
			reservationId: undefined,
			admission: undefined,
		});
		expect(f.uncertain).toEqual([]);
		expect(route.calls.denied).toBe(0);
		expect(f.applies()).toBe(0);
	});

	it("never marks or discloses a foreign reservation returned after the admission deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let started = () => {};
		let release = () => {};
		const start = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const route = routeFixture();
		const f = fixture(
			async (id) => {
				started();
				await gate;
				const decision = admitted(id, "allowed", false);
				decision.reservation.reservationId = "iac:foreign";
				return decision;
			},
			() => true,
			"target",
			"attempt",
			route.port,
			testOperation,
			undefined,
			5_000,
		);
		await f.provider.preview(f.program);
		const pending = expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_DEADLINE_UNKNOWN",
			requiresReconciliation: true,
			reservationId: undefined,
			admission: undefined,
		});
		await start;
		await vi.advanceTimersByTimeAsync(5_001);
		await pending;
		release();
		await vi.advanceTimersByTimeAsync(1);
		expect(f.uncertain).toEqual([]);
		expect(route.calls.denied).toBe(0);
		expect(f.applies()).toBe(0);
	});
	it.each([
		"resolution",
		"operation",
	] as const)("rejects a proxied %s without reflection or route admission", async (part) => {
		for (const revoked of [false, true]) {
			const observed = { traps: 0 };
			const route = routeFixture();
			const f = fixture(
				(id) => admitted(id, "allowed", false),
				() => true,
				"target",
				"attempt",
				route.port,
				testOperation,
				() => {
					const operation =
						part === "operation"
							? hostileProxy(testOperation, observed, revoked)
							: testOperation;
					const resolution = { requestId: "attempt", operation };
					return part === "resolution"
						? hostileProxy(resolution, observed, revoked)
						: resolution;
				},
			);
			await f.provider.preview(f.program);
			await expect(
				f.provider.applyWithAdmission(f.program, "attempt"),
			).rejects.toMatchObject({
				code: "ROUTE_OPERATION_UNVERIFIED",
			});
			expect(observed.traps).toBe(0);
			expect(route.calls.direct).toBe(0);
			expect(f.admissions()).toBe(0);
			expect(f.applies()).toBe(0);
		}
	});

	it.each([
		"attempt",
		"permit",
		"deny",
	] as const)("treats a proxied route %s as uncertain without admission or fallback", async (part) => {
		for (const revoked of [false, true]) {
			const observed = { traps: 0 };
			const base = routeFixture();
			const route: IacRoutePort = {
				...base.port,
				async runDirect(input, run) {
					return base.port.runDirect(input, (attempt) => {
						if (part === "attempt")
							return run(hostileProxy(attempt, observed, revoked));
						return run({
							permit:
								part === "permit"
									? hostileProxy(attempt.permit, observed, revoked)
									: attempt.permit,
							deny:
								part === "deny"
									? hostileProxy(attempt.deny, observed, revoked)
									: attempt.deny,
						});
					});
				},
			};
			const f = fixture(
				(id) => admitted(id, "allowed", false),
				() => true,
				"target",
				"attempt",
				route,
			);
			await f.provider.preview(f.program);
			await expect(
				f.provider.applyWithAdmission(f.program, "attempt"),
			).rejects.toMatchObject({
				code: "ROUTE_OUTCOME_UNKNOWN",
				requiresReconciliation: true,
			});
			expect(observed.traps).toBe(0);
			expect(base.calls.denied).toBe(0);
			expect(f.admissions()).toBe(0);
			expect(f.applies()).toBe(0);
		}
	});

	it("invokes a captured denial without reading its own call accessor", async () => {
		let calls = 0;
		const base = routeFixture();
		const route: IacRoutePort = {
			...base.port,
			async runDirect(input, run) {
				return base.port.runDirect(input, (attempt) => {
					const deny = async () => attempt.deny();
					Object.defineProperty(deny, "call", {
						get() {
							calls++;
							throw new Error("call getter");
						},
					});
					return run({ permit: attempt.permit, deny });
				});
			},
		};
		const f = fixture(
			(id) => ({
				requestId: id,
				targetId: "target",
				status: "denied",
				code: "BUDGET_DENIED",
				message: "",
				budget: { evaluation: "denied", reservation: "not-created" },
			}),
			() => true,
			"target",
			"attempt",
			route,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "BUDGET_DENIED",
			requiresReconciliation: false,
		});
		expect(calls).toBe(0);
		expect(base.calls.denied).toBe(1);
		expect(f.applies()).toBe(0);
	});

	it("treats a proxied route completion as uncertain after provider execution", async () => {
		const observed = { traps: 0 };
		const base = routeFixture();
		const route: IacRoutePort = {
			...base.port,
			async runDirect(input, run) {
				const completion = await base.port.runDirect(input, run);
				return hostileProxy(completion, observed, false);
			},
		};
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			() => true,
			"target",
			"attempt",
			route,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ROUTE_OUTCOME_UNKNOWN",
			requiresReconciliation: true,
			reservationId: "iac:attempt",
		});
		expect(observed.traps).toBe(0);
		expect(f.applies()).toBe(1);
		expect(base.calls.denied).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});
	it.each([
		"receipt",
		"budget",
		"reservation",
		"policy",
		"policy-identity",
		"scope",
		"scope-identity",
		"scope-accounts",
		"nested-policy",
		"nested-policy-identity",
		"account-claims",
		"account-claim",
		"entitlement-claims",
		"entitlement-claim",
		"quote-claims",
	] as const)("rejects a proxied or revoked %s in a receipt without reflection traps or fallback", async (part) => {
		for (const revoked of [false, true]) {
			const observed = { traps: 0 };
			const route = routeFixture();
			const f = fixture(
				(id) => {
					const decision = admitted(id, "bypassed", true);
					const policy = decision.unpricedPolicyProof;
					const scope = decision.reservation.unpricedScopeProof;
					if (policy === undefined || scope === undefined)
						throw new Error("missing fixture proof");
					if (part === "receipt")
						return hostileProxy(decision, observed, revoked);
					if (part === "budget")
						decision.budget = hostileProxy(decision.budget, observed, revoked);
					if (part === "reservation")
						decision.reservation = hostileProxy(
							decision.reservation,
							observed,
							revoked,
						);
					if (part === "policy")
						decision.unpricedPolicyProof = hostileProxy(
							policy,
							observed,
							revoked,
						);
					if (part === "policy-identity")
						policy.identity = hostileProxy(policy.identity, observed, revoked);
					if (part === "scope")
						decision.reservation.unpricedScopeProof = hostileProxy(
							scope,
							observed,
							revoked,
						);
					if (part === "scope-identity")
						Object.defineProperty(scope, "identity", {
							value: hostileProxy(scope.identity, observed, revoked),
							enumerable: true,
						});
					if (part === "scope-accounts")
						Object.defineProperty(scope, "providerAccountIds", {
							value: hostileProxy(scope.providerAccountIds, observed, revoked),
							enumerable: true,
						});
					if (part === "nested-policy" || part === "nested-policy-identity") {
						const nested = { ...policy, identity: { ...policy.identity } };
						if (part === "nested-policy-identity")
							nested.identity = hostileProxy(
								nested.identity,
								observed,
								revoked,
							);
						Object.defineProperty(decision.reservation, "unpricedPolicyProof", {
							value:
								part === "nested-policy"
									? hostileProxy(nested, observed, revoked)
									: nested,
							enumerable: true,
						});
					}
					if (part === "account-claims" || part === "account-claim") {
						const claim = { providerAccountId: "account", liabilityMicros: 1 };
						const claims = [
							part === "account-claim"
								? hostileProxy(claim, observed, revoked)
								: claim,
						];
						Object.defineProperty(decision.reservation, "providerAccounts", {
							value:
								part === "account-claims"
									? hostileProxy(claims, observed, revoked)
									: claims,
							enumerable: true,
						});
					}
					if (part === "entitlement-claims" || part === "entitlement-claim") {
						const claim = { bucketId: "quota", unit: "items", units: 1 };
						const claims = [
							part === "entitlement-claim"
								? hostileProxy(claim, observed, revoked)
								: claim,
						];
						Object.defineProperty(decision.reservation, "entitlementClaims", {
							value:
								part === "entitlement-claims"
									? hostileProxy(claims, observed, revoked)
									: claims,
							enumerable: true,
						});
					}
					if (part === "quote-claims")
						Object.defineProperty(decision, "quote", {
							value: {
								entitlementClaims: [
									hostileProxy({ bucketId: "quota" }, observed, revoked),
								],
							},
							enumerable: true,
						});
					return decision;
				},
				() => true,
				"target",
				"attempt",
				route.port,
			);
			await f.provider.preview(f.program);
			await expect(
				f.provider.applyWithAdmission(f.program, "attempt"),
			).rejects.toMatchObject({
				code:
					part === "receipt" && revoked
						? "ADMISSION_OUTCOME_UNKNOWN"
						: "ADMISSION_RECEIPT_INVALID",
				requiresReconciliation: true,
			});
			expect(observed.traps).toBe(0);
			expect(route.calls.denied).toBe(0);
			expect(f.applies()).toBe(0);
			expect(f.admissions()).toBe(1);
			await expect(
				f.provider.applyWithAdmission(f.program, "attempt"),
			).rejects.toMatchObject({ requiresReconciliation: true });
		}
	});
	it.each([
		"apply",
		"destroy",
	] as const)("checks host authorization before %s replanning or admission", async (action) => {
		const f = fixture((id) => admitted(id, "allowed", false));
		await f.provider.preview(f.program);
		if (action === "destroy")
			await f.provider.applyWithAdmission(f.program, "initial");
		const program = {
			...f.program,
			action,
			operationGeneration:
				action === "destroy" ? "generation-2" : "generation-1",
		};
		if (action === "destroy") await f.provider.preview(program);
		const previousDeclarations = f.declarations();
		const previousAdmissions = f.admissions();
		f.revokeEnvironment();
		await expect(
			action === "destroy"
				? f.provider.destroyWithAdmission(program, "second")
				: f.provider.applyWithAdmission(program, "second"),
		).rejects.toMatchObject({ code: "COMPOSITE_ENVIRONMENT_UNVERIFIED" });
		expect(f.declarations()).toBe(previousDeclarations);
		expect(f.admissions()).toBe(previousAdmissions);
		expect(f.deletions()).toBe(0);
	});
	it("snapshots the requested operation before asynchronous planning", async () => {
		const f = fixture((id) => admitted(id, "allowed", false));
		const program = { ...f.program };
		const pending = f.provider.assessPricing(program);
		Object.assign(program, { action: "destroy" });
		const assessment = await pending;
		expect(assessment.plan.operation).toBe("deploy");
	});

	it("rejects computed operation fields without invoking them", async () => {
		const f = fixture((id) => admitted(id, "allowed", false));
		await f.provider.preview(f.program);
		let actionReads = 0;
		const program = {
			...f.program,
			get action(): "apply" | "destroy" {
				actionReads++;
				return actionReads === 1 ? "apply" : "destroy";
			},
		};
		await expect(
			f.provider.applyWithAdmission(program, "attempt"),
		).rejects.toMatchObject({ code: "PROGRAM_INVALID" });
		expect(actionReads).toBe(0);
		expect(f.applies()).toBe(0);
	});

	it("rejects malformed wire proofs even though their fields accept protobuf values", async () => {
		const f = fixture((id) => {
			const valid = admitted(id, "bypassed", true);
			const wire: FinancialDecision = {
				...valid,
				unpricedPolicyProof: {
					requestDigest: valid.requestDigest,
					inventoryHash: valid.inventoryHash,
					policyHash: "policy",
					effect: "deny",
					evidenceRef: "policy:evidence",
					obligationsSatisfied: false,
					observedAt: "2026-01-01T00:00:00Z",
					validUntil: "2027-01-01T00:00:00Z",
				},
			};
			return wire;
		});
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("requires the host to resolve a stable request ID before claiming a route", async () => {
		const route = routeFixture();
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			null,
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(f.provider.apply(f.program)).rejects.toMatchObject({
			code: "ROUTE_OPERATION_UNVERIFIED",
			requiresReconciliation: false,
		});
		expect(route.calls.direct).toBe(0);
		expect(f.admissions()).toBe(0);
		expect(f.applies()).toBe(0);
	});

	it("requires a host-authorized operation before claiming a route", async () => {
		const route = routeFixture();
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			route.port,
			null,
		);
		await f.provider.preview(f.program);
		await expect(f.provider.apply(f.program)).rejects.toMatchObject({
			code: "ROUTE_OPERATION_REQUIRED",
			requiresReconciliation: false,
		});
		expect(route.calls.direct).toBe(0);
		expect(f.admissions()).toBe(0);
	});

	it("cannot replace the trusted route verifier after provider construction", async () => {
		const route = routeFixture({ verify: () => false });
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			route.port,
		);
		route.port.verifyAttempt = () => true;
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ROUTE_PERMIT_UNVERIFIED",
			requiresReconciliation: true,
		});
		expect(f.admissions()).toBe(0);
		expect(f.applies()).toBe(0);
	});

	it("cannot replace the trusted financial verifier after provider construction", async () => {
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			() => false,
		);
		f.financial.revalidate = () => true;
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_REVALIDATION_FAILED",
			reservationId: "iac:attempt",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("requires the persisted generation before claiming a route", async () => {
		const route = routeFixture();
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			route.port,
		);
		const legacy: IacProgram = { ...f.program };
		delete legacy.operationGeneration;
		await f.provider.preview(legacy);
		await expect(f.provider.apply(legacy)).rejects.toMatchObject({
			code: "OPERATION_GENERATION_REQUIRED",
			requiresReconciliation: false,
		});
		expect(route.calls.direct).toBe(0);
		expect(f.admissions()).toBe(0);
	});

	it("authenticates the actual target-independent operation and generation", async () => {
		const seen: object[] = [];
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			(context) => {
				seen.push(context);
				return {
					requestId: context.requestId ?? "resolved",
					operation: testOperation,
				};
			},
		);
		await f.provider.preview(f.program);
		await f.provider.applyWithAdmission(f.program, "attempt");
		const expected = {
			tenantId: "tenant",
			deploymentId: "d",
			programId: "p",
			resourceId: "app",
			logicalStackName: "App",
			declarationDigest: captureAlchemyProgram(f.program).declarationDigest,
			operation: "deploy",
			operationGeneration: "generation-1",
			requestId: "attempt",
		};
		expect(seen).toEqual([expected, expected]);
	});

	it.each([
		"revoked",
		"request changed",
		"operation changed",
	] as const)("retains the hold when operation revalidation reports %s", async (mode) => {
		let calls = 0;
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			({ requestId }) => {
				if (++calls === 2) {
					if (mode === "revoked") throw new Error("authorization revoked");
					if (mode === "request changed")
						return { requestId: "different", operation: testOperation };
					return {
						requestId: requestId ?? "resolved",
						operation: {
							...testOperation,
							operationId: `sha256:${"a".repeat(64)}`,
						},
					};
				}
				return { requestId: requestId ?? "resolved", operation: testOperation };
			},
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ROUTE_OPERATION_REVALIDATION_FAILED",
			reservationId: "iac:attempt",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("rejects a resolver that substitutes the caller's request ID", async () => {
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			() => ({ requestId: "other", operation: testOperation }),
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({ code: "ROUTE_OPERATION_UNVERIFIED" });
		expect(f.admissions()).toBe(0);
	});

	it("allows a long-lived provider to process a new authenticated generation", async () => {
		const f = fixture((id) => admitted(id, "allowed", false));
		await f.provider.preview(f.program);
		await f.provider.applyWithAdmission(f.program, "first");
		const next = { ...f.program, operationGeneration: "generation-2" };
		await f.provider.preview(next);
		await f.provider.applyWithAdmission(next, "second");
		expect(f.admissions()).toBe(2);
	});

	it("blocks a later generation while the prior resource outcome is unresolved", async () => {
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			() => false,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "first"),
		).rejects.toMatchObject({ code: "ADMISSION_REVALIDATION_FAILED" });
		const next = { ...f.program, operationGeneration: "generation-2" };
		await expect(
			f.provider.applyWithAdmission(next, "second"),
		).rejects.toMatchObject({
			code: "EXECUTION_ALREADY_CLAIMED",
			reservationId: "iac:first",
			requiresReconciliation: true,
		});
		await f.provider.preview(next);
		await expect(
			f.provider.applyWithAdmission(next, "second"),
		).rejects.toMatchObject({ code: "EXECUTION_ALREADY_CLAIMED" });
		expect(f.admissions()).toBe(1);
	});

	it("does not run two generations of the same resource concurrently", async () => {
		let signal = () => {};
		let release = () => {};
		const started = new Promise<void>((resolve) => {
			signal = resolve;
		});
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			async () => {
				signal();
				await pending;
				return true;
			},
		);
		const next = { ...f.program, operationGeneration: "generation-2" };
		await f.provider.preview(f.program);
		await f.provider.preview(next);
		const first = f.provider.applyWithAdmission(f.program, "first");
		try {
			await started;
			await expect(
				f.provider.applyWithAdmission(next, "second"),
			).rejects.toMatchObject({ code: "EXECUTION_IN_PROGRESS" });
		} finally {
			release();
			await first;
		}
		expect(f.admissions()).toBe(1);
	});

	it("does not consume a permit for a different logical operation", async () => {
		const route = routeFixture();
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt", undefined, {
				tenantId: "tenant",
				requestId: "attempt",
				operationId: `sha256:${"a".repeat(64)}`,
				targetId: "target",
				inventoryHash: `sha256:${"c".repeat(64)}`,
				attemptId: "A".repeat(43),
			}),
		).rejects.toMatchObject({
			code: "ROUTE_PERMIT_UNVERIFIED",
			requiresReconciliation: true,
		});
		expect(route.calls.consumed).toBe(0);
		expect(f.admissions()).toBe(0);
	});

	it.each([
		"reused",
		"lost acknowledgment",
	] as const)("does not admit a route permit with %s consumption", async (failure) => {
		const route = routeFixture({
			consume: () => {
				if (failure === "lost acknowledgment") throw new Error("lost");
				return false;
			},
		});
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ROUTE_PERMIT_UNVERIFIED",
			requiresReconciliation: true,
		});
		expect(route.calls.consumed).toBe(1);
		expect(route.calls.denied).toBe(0);
		expect(f.admissions()).toBe(0);
		expect(f.applies()).toBe(0);
	});

	it("retains the hold if the route is no longer active before provider start", async () => {
		let verifications = 0;
		const route = routeFixture({ verify: () => ++verifications === 1 });
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ROUTE_PERMIT_UNVERIFIED",
			requiresReconciliation: true,
			reservationId: "iac:attempt",
		});
		expect(route.calls.consumed).toBe(1);
		expect(route.calls.verified).toBe(2);
		expect(f.admissions()).toBe(1);
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("uses a dispatched permit without acquiring a second route", async () => {
		const route = routeFixture();
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			route.port,
		);
		await f.provider.preview(f.program);
		const attemptId = "A".repeat(43);
		const result = await f.provider.applyWithAdmission(
			f.program,
			"attempt",
			undefined,
			{
				tenantId: "tenant",
				requestId: "attempt",
				operationId: testOperation.operationId,
				targetId: "target",
				inventoryHash: `sha256:${"c".repeat(64)}`,
				attemptId,
			},
		);
		expect(route.calls.direct).toBe(0);
		expect(route.calls.consumed).toBe(1);
		expect(route.calls.verified).toBe(2);
		expect(f.applies()).toBe(1);
		expect(JSON.stringify(result)).not.toContain(attemptId);
		expect(JSON.stringify(result)).not.toContain(testOperation.authorization);
	});

	it("only admits one of two adapters racing the same dispatched permit", async () => {
		let consumed = false;
		const route = routeFixture({
			consume: () => {
				if (consumed) return false;
				consumed = true;
				return true;
			},
		});
		const first = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			route.port,
		);
		const second = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			route.port,
		);
		await Promise.all([
			first.provider.preview(first.program),
			second.provider.preview(second.program),
		]);
		const permit = {
			tenantId: "tenant",
			requestId: "attempt",
			operationId: testOperation.operationId,
			targetId: "target",
			inventoryHash: `sha256:${"c".repeat(64)}`,
			attemptId: "A".repeat(43),
		};
		const outcomes = await Promise.allSettled([
			first.provider.applyWithAdmission(
				first.program,
				"attempt",
				undefined,
				permit,
			),
			second.provider.applyWithAdmission(
				second.program,
				"attempt",
				undefined,
				permit,
			),
		]);
		expect(
			outcomes.filter((outcome) => outcome.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			outcomes.filter((outcome) => outcome.status === "rejected"),
		).toHaveLength(1);
		expect(first.admissions() + second.admissions()).toBe(1);
		expect(first.applies() + second.applies()).toBe(1);
	});

	it("retains a successful hold when durable route completion is unknown", async () => {
		const route = routeFixture({ loseCompletion: true });
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ROUTE_OUTCOME_UNKNOWN",
			requiresReconciliation: true,
			reservationId: "iac:attempt",
		});
		expect(f.applies()).toBe(1);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("uses the host's stable request ID across candidate targets", async () => {
		const seen: string[] = [];
		const deny = (targetId: string) => (requestId: string) => {
			seen.push(requestId);
			return {
				requestId,
				targetId,
				status: "denied",
				code: "NOT_ALLOWED",
				message: "denied",
				budget: { evaluation: "denied", reservation: "not-created" },
			};
		};
		const first = fixture(deny("target-a"), undefined, "target-a");
		const second = fixture(deny("target-b"), undefined, "target-b");
		const firstProgram = {
			...first.program,
			provider: "provider-a",
			driver: "driver-a",
		};
		const secondProgram = {
			...second.program,
			provider: "provider-b",
			driver: "driver-b",
		};
		await first.provider.preview(firstProgram);
		await second.provider.preview(secondProgram);
		await expect(first.provider.apply(firstProgram)).rejects.toMatchObject({
			code: "NOT_ALLOWED",
		});
		await expect(second.provider.apply(secondProgram)).rejects.toMatchObject({
			code: "NOT_ALLOWED",
		});
		expect(seen).toHaveLength(2);
		expect(seen[0]).toBe(seen[1]);
	});

	it("executes an explicitly authorized unbounded exposure and discloses the budget bypass", async () => {
		const f = fixture((id) => admitted(id, "bypassed", true));
		await f.provider.preview(f.program);
		const result = await f.provider.applyWithAdmission(f.program, "attempt");
		expect(result).toMatchObject({
			outputs: { output: "ok" },
			admission: {
				budget: { evaluation: "bypassed", reservation: "held" },
				reservation: { reservationId: "iac:attempt", unboundedExposure: true },
				unpricedPolicyProof: {
					identity: { tenantId: "tenant" },
					effect: "allow",
					evidenceRef: "host:policy",
				},
			},
		});
		expect(f.applies()).toBe(1);
	});

	it.each([
		["bypassed", undefined],
		["bypassed", false],
		["allowed", true],
	] as const)("refuses a mismatched %s admission marker", async (evaluation, unboundedExposure) => {
		const f = fixture((id) => admitted(id, evaluation, unboundedExposure));
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it.each([
		"policy",
		"scope",
	] as const)("refuses a priced receipt carrying unpriced %s evidence", async (kind) => {
		const f = fixture((id) => {
			const priced = admitted(id, "allowed", false);
			const bypassed = admitted(id, "bypassed", true);
			if (kind === "policy")
				return { ...priced, unpricedPolicyProof: bypassed.unpricedPolicyProof };
			return {
				...priced,
				reservation: {
					...priced.reservation,
					unpricedScopeProof: bypassed.reservation.unpricedScopeProof,
				},
			};
		});
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("does not silently replace a ranked priced expectation with a bypassed decision", async () => {
		const f = fixture((id) => admitted(id, "bypassed", true));
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt", {
				targetId: "target",
				inventoryHash: `sha256:${"c".repeat(64)}`,
				modelHash: `sha256:${"b".repeat(64)}`,
				quoteHash: `sha256:${"c".repeat(64)}`,
			}),
		).rejects.toMatchObject({
			code: "ADMISSION_QUOTE_MISMATCH",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("pins the reviewed expectation before invoking the financial authority", async () => {
		const expected = {
			kind: "unpriced" as const,
			targetId: "target",
			inventoryHash: `sha256:${"c".repeat(64)}`,
		};
		const f = fixture((id) => {
			expected.inventoryHash = `sha256:${"d".repeat(64)}`;
			return admitted(id, "bypassed", true);
		});
		await f.provider.preview(f.program);
		const result = await f.provider.applyWithAdmission(
			f.program,
			"attempt",
			expected,
		);
		expect(result.admission.budget.evaluation).toBe("bypassed");
		expect(f.applies()).toBe(1);
	});

	it.each([
		{
			kind: "unknown",
			targetId: "target",
			inventoryHash: `sha256:${"c".repeat(64)}`,
		},
		{ kind: "unpriced", targetId: "target", inventoryHash: "not-a-digest" },
		{
			kind: "unpriced",
			targetId: "target",
			inventoryHash: `sha256:${"c".repeat(64)}`,
			quoteHash: `sha256:${"a".repeat(64)}`,
		},
	])("rejects a malformed routing expectation before admission", async (expected) => {
		const f = fixture((id) => admitted(id, "bypassed", true));
		await f.provider.preview(f.program);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: malformed expectations exercise the public runtime boundary.
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt", expected as never),
		).rejects.toMatchObject({
			code: "EXPECTATION_INVALID",
			requiresReconciliation: false,
		});
		expect(f.admissions()).toBe(0);
		expect(f.applies()).toBe(0);
	});

	it("accepts an explicitly selected unpriced target only with its reviewed inventory", async () => {
		const f = fixture((id) => admitted(id, "bypassed", true));
		await f.provider.preview(f.program);
		const result = await f.provider.applyWithAdmission(f.program, "attempt", {
			kind: "unpriced",
			targetId: "target",
			inventoryHash: `sha256:${"c".repeat(64)}`,
		});
		expect(result.admission.budget.evaluation).toBe("bypassed");
		expect(f.applies()).toBe(1);
	});

	it.each([
		"changed-inventory",
		"changed-mode",
	] as const)("refuses an unpriced expectation with %s", async (reason) => {
		const f = fixture(
			(id) =>
				admitted(
					id,
					reason === "changed-mode" ? "allowed" : "bypassed",
					reason !== "changed-mode",
				),
			undefined,
			undefined,
			undefined,
			routeFixture({
				inventoryHash: `sha256:${(reason === "changed-inventory" ? "d" : "c").repeat(64)}`,
			}).port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt", {
				kind: "unpriced",
				targetId: "target",
				inventoryHash: `sha256:${(reason === "changed-inventory" ? "d" : "c").repeat(64)}`,
			}),
		).rejects.toMatchObject({
			code:
				reason === "changed-inventory"
					? "ROUTE_INVENTORY_MISMATCH"
					: "ADMISSION_QUOTE_MISMATCH",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it.each([
		"requestDigest",
		"inventoryHash",
		"modelHash",
		"quoteHash",
	] as const)("refuses a bypass receipt with invalid %s evidence", async (field) => {
		const f = fixture((id) => ({
			...admitted(id, "bypassed", true),
			[field]:
				field.endsWith("Digest") || field === "inventoryHash"
					? "invalid"
					: `sha256:${"d".repeat(64)}`,
		}));
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("refuses an unbounded admission whose policy proof is for another tenant", async () => {
		const f = fixture((id) => {
			const decision = admitted(id, "bypassed", true);
			if (decision.unpricedPolicyProof === undefined)
				throw new Error("proof fixture missing");
			decision.unpricedPolicyProof.identity.tenantId = "other";
			return decision;
		});
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it.each([
		"foreign-account",
		"foreign-policy",
		"duplicate-account",
	] as const)("refuses unbounded scope proof with %s", async (reason) => {
		const f = fixture((id) => {
			const decision = admitted(id, "bypassed", true);
			const scope = decision.reservation.unpricedScopeProof;
			if (scope === undefined) throw new Error("scope fixture missing");
			if (reason === "foreign-account")
				Object.assign(scope, { providerAccountIds: ["other"] });
			if (reason === "duplicate-account")
				Object.assign(scope, { providerAccountIds: ["account", "account"] });
			if (reason === "foreign-policy")
				Object.assign(scope.identity, { policyRevision: "foreign" });
			return decision;
		});
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it.each([
		"allowed",
		"bypassed",
	] as const)("retains the %s hold when authority revalidation fails", async (mode) => {
		const f = fixture(
			(id) => admitted(id, mode, mode === "bypassed"),
			() => false,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_REVALIDATION_FAILED",
			requiresReconciliation: true,
			reservationId: "iac:attempt",
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("does not expose mutable admission data to the authority verifier", async () => {
		const f = fixture(
			(id) => admitted(id, "bypassed", true),
			(copy) => {
				if (copy.reservation !== undefined)
					copy.reservation.reservationId = "tampered";
				return true;
			},
		);
		await f.provider.preview(f.program);
		const result = await f.provider.applyWithAdmission(f.program, "attempt");
		expect(result.admission.reservation.reservationId).toBe("iac:attempt");
		expect(f.applies()).toBe(1);
	});

	it("treats a lost revalidation response as unresolved and blocks retry", async () => {
		const f = fixture(
			(id) => admitted(id, "bypassed", true),
			() => {
				throw new Error("response lost");
			},
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_REVALIDATION_FAILED",
			requiresReconciliation: true,
			reservationId: "iac:attempt",
		});
		await expect(
			f.provider.applyWithAdmission(f.program, "retry"),
		).rejects.toMatchObject({
			code: "EXECUTION_ALREADY_CLAIMED",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it.each([
		"priced",
		"unpriced",
	] as const)("preserves a %s execution claim through revalidation", async (mode) => {
		let executionDigest: string | undefined;
		const f = fixture(
			(id) => generatedAdmission(id, mode),
			(admission) => {
				executionDigest = admission.reservation?.executionDigest;
				return true;
			},
		);
		await f.provider.preview(f.program);
		await f.provider.applyWithAdmission(f.program, "attempt");
		expect(executionDigest).toBe(`sha256:${"4".repeat(64)}`);
		expect(f.applies()).toBe(1);
	});

	it.each([
		"allowed",
		"bypassed",
	] as const)("refuses a %s direct apply without a valid execution claim", async (evaluation) => {
		for (const kind of ["missing", "empty", "malformed"] as const) {
			const f = fixture((id) => {
				const decision = admitted(id, evaluation, evaluation === "bypassed");
				if (kind === "missing") delete decision.reservation.executionDigest;
				else
					decision.reservation.executionDigest =
						kind === "empty" ? "" : "sha256:not-a-digest";
				return decision;
			});
			await f.provider.preview(f.program);
			const attempt = f.provider.applyWithAdmission(f.program, "attempt");
			await expect(attempt).rejects.toMatchObject({
				code: "ADMISSION_RECEIPT_INVALID",
				requiresReconciliation: true,
			});
			if (kind !== "missing")
				await expect(attempt).rejects.toMatchObject({
					message:
						"ADMISSION_RECEIPT_INVALID: admission receipt could not be safely inspected",
				});
			expect(f.applies()).toBe(0);
			expect(f.uncertain).toEqual(["iac:attempt"]);
		}
	});

	it.each([
		"requestDigest",
		"inventoryHash",
		"modelHash",
		"quoteHash",
	] as const)("refuses a priced direct apply without valid %s", async (field) => {
		const f = fixture((id) => ({
			...admitted(id, "allowed", false),
			[field]: "",
		}));
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});
});
