import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	BudgetLedgerSnapshotSchema,
	buildDeploymentRequestFromParts,
	contentHashOf,
	createLocalHostCatalog,
	createSqliteBudgetAdmissionAuthority,
	HostingPolicyProofSchema,
	HostingQuoteSchema,
	LOCAL_HOST_PROVIDER_ID,
	localYardInstance,
	resolveBindleDeployment,
	YARD_EVENTS,
	yardEvent,
} from "../src/index.js";
import { bindTestYardWork } from "./yard-hosting-fixtures.js";

describe("funded Yard quote and policy context", () => {
	it.each([
		"provider",
		"yard",
		"liability",
		"source quote",
		"identity",
		"authority",
		"budget",
		"budget authority",
		"reserve method",
		"uncertain method",
		"persistence",
		"clock",
		"catalog",
		"owner",
		"request",
	])("refuses changed %s while policy is awaited before reserving", async (change) => {
		const now = "2026-10-29T12:00:00Z";
		const dir = mkdtempSync(join(tmpdir(), "yard-quote-race-"));
		const authority = createSqliteBudgetAdmissionAuthority({
			path: join(dir, "budget.sqlite"),
			now: () => now,
			snapshot: create(BudgetLedgerSnapshotSchema, {
				identity: {
					tenantId: "tenant",
					budgetId: "hosting",
					periodId: "2026-10",
					policyRevision: "r1",
				},
				limitMicros: 100,
				observedAt: "2026-10-29T00:00:00Z",
				validUntil: "2026-11-01T00:00:00Z",
			}),
		});
		try {
			const request = buildDeploymentRequestFromParts({
				bindleName: "shop",
				ownerTenantId: "tenant",
				providerId: LOCAL_HOST_PROVIDER_ID,
				resources: [
					{ resourceId: "api", port: "hobo:http-service", features: [] },
				],
			});
			const yard = localYardInstance({
				yardId: "yard:a",
				ownerTenantId: "tenant",
				providerId: LOCAL_HOST_PROVIDER_ID,
			});
			const quote = create(HostingQuoteSchema, {
				quoteId: "q",
				yardId: "yard:a",
				providerId: LOCAL_HOST_PROVIDER_ID,
				ownerTenantId: "tenant",
				currency: "USD",
				totalMicros: 10,
				liabilityBoundMicros: 20,
				components: [{ name: "execution", costMicros: 10 }],
				requestDigest: contentHashOf(request),
				observedAt: "2026-10-29T00:00:00Z",
				validUntil: "2026-11-01T00:00:00Z",
			});
			bindTestYardWork(quote, request, "broker:test", createLocalHostCatalog());
			const deps = {
				brokerId: "broker:test",
				ownerTenantId: "tenant",
				catalog: createLocalHostCatalog(),
				seedLocalYard: false,
				priorEvents: [
					yardEvent(YARD_EVENTS.Registered, { yard }),
					yardEvent(YARD_EVENTS.Ready, { yardId: yard.yardId }),
				],
				hostingBudget: { authority, quotes: [quote], now: () => now },
				authorizeHosting: async (input) => {
					if (change === "provider") input.quote.providerId = "foreign";
					if (change === "yard") input.quote.yardId = "yard:foreign";
					if (change === "liability") {
						input.quote.totalMicros = 1;
						input.quote.liabilityBoundMicros = 1;
						input.quote.components[0].costMicros = 1;
					}
					if (change === "source quote") quote.providerId = "foreign";
					if (change === "identity") input.identity.tenantId = "foreign";
					if (change === "budget authority")
						Object.assign(deps.hostingBudget, { authority: { ...authority } });
					if (change === "reserve method") {
						const prior = authority.reserve.bind(authority);
						Object.assign(authority, { reserve: (input) => prior(input) });
					}
					if (change === "uncertain method") {
						const prior = authority.uncertain.bind(authority);
						Object.assign(authority, { uncertain: (id: string) => prior(id) });
					}
					if (change === "persistence")
						Object.assign(authority, { persistence: "memory" });
					if (change === "clock")
						Object.assign(deps.hostingBudget, { now: () => now });
					if (change === "authority")
						Object.assign(deps, { authorizeHosting: () => undefined });
					if (change === "budget")
						Object.assign(deps, { hostingBudget: { ...deps.hostingBudget } });
					if (change === "catalog") deps.catalog.catalogHash = "sha256:changed";
					if (change === "owner")
						Object.assign(deps, { ownerTenantId: "foreign" });
					if (change === "request")
						Object.assign(input.request.yard.requestedLayout.properties, {
							changed: true,
						});
					return {
						gate: { effect: "allow", reasons: [], events: [] },
						proof: create(HostingPolicyProofSchema, {
							requestDigest: input.requestDigest,
							quoteId: input.quote.quoteId,
							quoteDigest: input.quoteDigest,
							identity: input.identity,
							effect: "allow",
							policyHash: "approved",
							evidenceRef: "policy",
							obligationsSatisfied: true,
						}),
					};
				},
			};
			const result = await resolveBindleDeployment(request, deps);
			expect(result.outcome).toBe("rejected");
			expect(result.receipt).toBeUndefined();
			expect(authority.read(now).reservedMicros).toBe(0);
		} finally {
			authority.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("funded Yard hold races", () => {
	it.each([
		"catalog",
		"reserved quote",
		"expiry",
	])("retains a new hold and refuses changed %s after reservation", async (change) => {
		let now = "2026-10-29T12:00:00Z";
		const dir = mkdtempSync(join(tmpdir(), "yard-hold-race-"));
		const authority = createSqliteBudgetAdmissionAuthority({
			path: join(dir, "budget.sqlite"),
			now: () => now,
			snapshot: create(BudgetLedgerSnapshotSchema, {
				identity: {
					tenantId: "tenant",
					budgetId: "hosting",
					periodId: "2026-10",
					policyRevision: "r1",
				},
				limitMicros: 100,
				observedAt: "2026-10-29T00:00:00Z",
				validUntil: "2026-11-01T00:00:00Z",
			}),
		});
		try {
			const request = buildDeploymentRequestFromParts({
				bindleName: "shop",
				ownerTenantId: "tenant",
				providerId: LOCAL_HOST_PROVIDER_ID,
				resources: [
					{ resourceId: "api", port: "hobo:http-service", features: [] },
				],
			});
			const yard = localYardInstance({
				yardId: "yard:a",
				ownerTenantId: "tenant",
				providerId: LOCAL_HOST_PROVIDER_ID,
			});
			const quote = create(HostingQuoteSchema, {
				quoteId: "q",
				yardId: "yard:a",
				providerId: LOCAL_HOST_PROVIDER_ID,
				ownerTenantId: "tenant",
				currency: "USD",
				totalMicros: 10,
				liabilityBoundMicros: 20,
				components: [{ name: "execution", costMicros: 10 }],
				requestDigest: contentHashOf(request),
				observedAt: "2026-10-29T00:00:00Z",
				validUntil: "2026-11-01T00:00:00Z",
			});
			bindTestYardWork(quote, request, "broker:test", createLocalHostCatalog());
			const catalog = createLocalHostCatalog();
			const wrapped = {
				...authority,
				reserve(input) {
					const result = authority.reserve(input);
					if (change === "catalog") catalog.catalogHash = "sha256:changed";
					if (change === "reserved quote") input.quote.providerId = "foreign";
					if (change === "expiry") now = "2026-11-01T00:00:00Z";
					return result;
				},
			};
			const result = await resolveBindleDeployment(request, {
				brokerId: "broker:test",
				ownerTenantId: "tenant",
				catalog,
				seedLocalYard: false,
				priorEvents: [
					yardEvent(YARD_EVENTS.Registered, { yard }),
					yardEvent(YARD_EVENTS.Ready, { yardId: yard.yardId }),
				],
				hostingBudget: { authority: wrapped, quotes: [quote], now: () => now },
				authorizeHosting(input) {
					return {
						gate: { effect: "allow", reasons: [], events: [] },
						proof: create(HostingPolicyProofSchema, {
							requestDigest: input.requestDigest,
							quoteId: input.quote.quoteId,
							quoteDigest: input.quoteDigest,
							identity: input.identity,
							effect: "allow",
							policyHash: "approved",
							evidenceRef: "policy",
							obligationsSatisfied: true,
						}),
					};
				},
			});
			expect(result.outcome).toBe("rejected");
			expect(result.receipt).toBeUndefined();
			expect(
				authority.lookup(`hosting:broker:test:${request.requestId}`)?.status,
			).toBe("held");
			now = "2026-10-29T12:00:00Z";
			expect(authority.read(now).reservedMicros).toBe(20);
		} finally {
			authority.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

it("admits only unchanged, policy-approved funded quotes across generated cases", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.record({
				quote: fc.boolean(),
				catalog: fc.boolean(),
				budget: fc.boolean(),
				policy: fc.boolean(),
				proof: fc.boolean(),
			}),
			async (flags) => {
				const now = "2026-10-29T12:00:00Z";
				const dir = mkdtempSync(join(tmpdir(), "yard-quote-property-"));
				const authority = createSqliteBudgetAdmissionAuthority({
					path: join(dir, "budget.sqlite"),
					now: () => now,
					snapshot: create(BudgetLedgerSnapshotSchema, {
						identity: {
							tenantId: "tenant",
							budgetId: "hosting",
							periodId: "2026-10",
							policyRevision: "r1",
						},
						limitMicros: 100,
						observedAt: "2026-10-29T00:00:00Z",
						validUntil: "2026-11-01T00:00:00Z",
					}),
				});
				try {
					const request = buildDeploymentRequestFromParts({
						bindleName: "shop",
						ownerTenantId: "tenant",
						providerId: LOCAL_HOST_PROVIDER_ID,
						resources: [
							{ resourceId: "api", port: "hobo:http-service", features: [] },
						],
					});
					const yard = localYardInstance({
						yardId: "yard:a",
						ownerTenantId: "tenant",
						providerId: LOCAL_HOST_PROVIDER_ID,
					});
					const quote = create(HostingQuoteSchema, {
						quoteId: "q",
						yardId: "yard:a",
						providerId: LOCAL_HOST_PROVIDER_ID,
						ownerTenantId: "tenant",
						currency: "USD",
						totalMicros: 10,
						liabilityBoundMicros: 20,
						components: [{ name: "execution", costMicros: 10 }],
						requestDigest: contentHashOf(request),
						observedAt: "2026-10-29T00:00:00Z",
						validUntil: "2026-11-01T00:00:00Z",
					});
					bindTestYardWork(
						quote,
						request,
						"broker:test",
						createLocalHostCatalog(),
					);
					const deps = {
						brokerId: "broker:test",
						ownerTenantId: "tenant",
						catalog: createLocalHostCatalog(),
						seedLocalYard: false,
						priorEvents: [
							yardEvent(YARD_EVENTS.Registered, { yard }),
							yardEvent(YARD_EVENTS.Ready, { yardId: yard.yardId }),
						],
						hostingBudget: { authority, quotes: [quote], now: () => now },
						authorizeHosting: async (input) => {
							if (flags.quote) input.quote.providerId = "foreign";
							if (flags.catalog) deps.catalog.catalogHash = "sha256:changed";
							if (flags.budget)
								Object.assign(deps, {
									hostingBudget: { ...deps.hostingBudget },
								});
							const effect = flags.policy ? "deny" : "allow";
							return {
								gate: { effect, reasons: [], events: [] },
								proof: create(HostingPolicyProofSchema, {
									requestDigest: input.requestDigest,
									quoteId: input.quote.quoteId,
									quoteDigest: input.quoteDigest,
									identity: input.identity,
									effect,
									policyHash: "approved",
									evidenceRef: "policy",
									obligationsSatisfied: !flags.proof,
								}),
							};
						},
					};
					const result = await resolveBindleDeployment(request, deps);
					const safe = !Object.values(flags).some(Boolean);
					expect(result.outcome).toBe(safe ? "resolved" : "rejected");
					expect(authority.read(now).reservedMicros).toBe(safe ? 20 : 0);
				} finally {
					authority.close();
					rmSync(dir, { recursive: true, force: true });
				}
			},
		),
		{ seed: 614525, numRuns: 100 },
	);
});

it("retains the hold if the final freshness clock changes hosting context", async () => {
	const now = "2026-10-29T12:00:00Z";
	const dir = mkdtempSync(join(tmpdir(), "yard-clock-race-"));
	const authority = createSqliteBudgetAdmissionAuthority({
		path: join(dir, "budget.sqlite"),
		now: () => now,
		snapshot: create(BudgetLedgerSnapshotSchema, {
			identity: {
				tenantId: "tenant",
				budgetId: "hosting",
				periodId: "2026-10",
				policyRevision: "r1",
			},
			limitMicros: 100,
			observedAt: "2026-10-29T00:00:00Z",
			validUntil: "2026-11-01T00:00:00Z",
		}),
	});
	try {
		const request = buildDeploymentRequestFromParts({
			bindleName: "shop",
			ownerTenantId: "tenant",
			providerId: LOCAL_HOST_PROVIDER_ID,
			resources: [
				{ resourceId: "api", port: "hobo:http-service", features: [] },
			],
		});
		const yard = localYardInstance({
			yardId: "yard:a",
			ownerTenantId: "tenant",
			providerId: LOCAL_HOST_PROVIDER_ID,
		});
		const quote = create(HostingQuoteSchema, {
			quoteId: "q",
			yardId: "yard:a",
			providerId: LOCAL_HOST_PROVIDER_ID,
			ownerTenantId: "tenant",
			currency: "USD",
			totalMicros: 10,
			liabilityBoundMicros: 20,
			components: [{ name: "execution", costMicros: 10 }],
			requestDigest: contentHashOf(request),
			observedAt: "2026-10-29T00:00:00Z",
			validUntil: "2026-11-01T00:00:00Z",
		});
		bindTestYardWork(quote, request, "broker:test", createLocalHostCatalog());
		const catalog = createLocalHostCatalog();
		const clock = () => {
			if (authority.lookup(`hosting:broker:test:${request.requestId}`))
				catalog.catalogHash = "sha256:changed";
			return now;
		};
		const result = await resolveBindleDeployment(request, {
			brokerId: "broker:test",
			ownerTenantId: "tenant",
			catalog,
			seedLocalYard: false,
			priorEvents: [
				yardEvent(YARD_EVENTS.Registered, { yard }),
				yardEvent(YARD_EVENTS.Ready, { yardId: yard.yardId }),
			],
			hostingBudget: { authority, quotes: [quote], now: clock },
			authorizeHosting(input) {
				return {
					gate: { effect: "allow", reasons: [], events: [] },
					proof: create(HostingPolicyProofSchema, {
						requestDigest: input.requestDigest,
						quoteId: input.quote.quoteId,
						quoteDigest: input.quoteDigest,
						identity: input.identity,
						effect: "allow",
						policyHash: "approved",
						evidenceRef: "policy",
						obligationsSatisfied: true,
					}),
				};
			},
		});
		expect(result.outcome).toBe("rejected");
		expect(result.receipt).toBeUndefined();
		expect(
			authority.lookup(`hosting:broker:test:${request.requestId}`)?.status,
		).toBe("held");
		expect(authority.read(now).reservedMicros).toBe(20);
	} finally {
		authority.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("retains the hold if context changes after funded admission and before the receipt", async () => {
	const now = "2026-10-29T12:00:00Z";
	const dir = mkdtempSync(join(tmpdir(), "yard-post-admit-race-"));
	const authority = createSqliteBudgetAdmissionAuthority({
		path: join(dir, "budget.sqlite"),
		now: () => now,
		snapshot: create(BudgetLedgerSnapshotSchema, {
			identity: {
				tenantId: "tenant",
				budgetId: "hosting",
				periodId: "2026-10",
				policyRevision: "r1",
			},
			limitMicros: 100,
			observedAt: "2026-10-29T00:00:00Z",
			validUntil: "2026-11-01T00:00:00Z",
		}),
	});
	try {
		const request = buildDeploymentRequestFromParts({
			bindleName: "shop",
			ownerTenantId: "tenant",
			providerId: LOCAL_HOST_PROVIDER_ID,
			resources: [
				{ resourceId: "api", port: "hobo:http-service", features: [] },
			],
		});
		const yard = localYardInstance({
			yardId: "yard:a",
			ownerTenantId: "tenant",
			providerId: LOCAL_HOST_PROVIDER_ID,
		});
		const quote = create(HostingQuoteSchema, {
			quoteId: "q",
			yardId: "yard:a",
			providerId: LOCAL_HOST_PROVIDER_ID,
			ownerTenantId: "tenant",
			currency: "USD",
			totalMicros: 10,
			liabilityBoundMicros: 20,
			components: [{ name: "execution", costMicros: 10 }],
			requestDigest: contentHashOf(request),
			observedAt: "2026-10-29T00:00:00Z",
			validUntil: "2026-11-01T00:00:00Z",
		});
		bindTestYardWork(quote, request, "broker:test", createLocalHostCatalog());
		const catalog = createLocalHostCatalog();
		const result = await resolveBindleDeployment(request, {
			brokerId: "broker:test",
			ownerTenantId: "tenant",
			catalog,
			seedLocalYard: false,
			priorEvents: [
				yardEvent(YARD_EVENTS.Registered, { yard }),
				yardEvent(YARD_EVENTS.Ready, { yardId: yard.yardId }),
			],
			hostingBudget: { authority, quotes: [quote], now: () => now },
			authorizeHosting(input) {
				queueMicrotask(() =>
					queueMicrotask(() => {
						catalog.catalogHash = "sha256:changed";
					}),
				);
				return {
					gate: { effect: "allow", reasons: [], events: [] },
					proof: create(HostingPolicyProofSchema, {
						requestDigest: input.requestDigest,
						quoteId: input.quote.quoteId,
						quoteDigest: input.quoteDigest,
						identity: input.identity,
						effect: "allow",
						policyHash: "approved",
						evidenceRef: "policy",
						obligationsSatisfied: true,
					}),
				};
			},
		});
		expect(result.outcome).toBe("rejected");
		expect(result.receipt).toBeUndefined();
		expect(
			authority.lookup(`hosting:broker:test:${request.requestId}`)?.status,
		).toBe("held");
		expect(authority.read(now).reservedMicros).toBe(20);
	} finally {
		authority.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("rejects instead of throwing when budget lookup is unavailable", async () => {
	const now = "2026-10-29T12:00:00Z";
	const dir = mkdtempSync(join(tmpdir(), "yard-lookup-failure-"));
	const authority = createSqliteBudgetAdmissionAuthority({
		path: join(dir, "budget.sqlite"),
		now: () => now,
		snapshot: create(BudgetLedgerSnapshotSchema, {
			identity: {
				tenantId: "tenant",
				budgetId: "hosting",
				periodId: "2026-10",
				policyRevision: "r1",
			},
			limitMicros: 100,
			observedAt: "2026-10-29T00:00:00Z",
			validUntil: "2026-11-01T00:00:00Z",
		}),
	});
	try {
		const request = buildDeploymentRequestFromParts({
			bindleName: "shop",
			ownerTenantId: "tenant",
			providerId: LOCAL_HOST_PROVIDER_ID,
			resources: [],
		});
		const broken = {
			...authority,
			lookup() {
				throw new Error("storage unavailable");
			},
		};
		const result = await resolveBindleDeployment(request, {
			brokerId: "broker:test",
			catalog: createLocalHostCatalog(),
			hostingBudget: { authority: broken, quotes: [], now: () => now },
		});
		expect(result.outcome).toBe("rejected");
		expect(result.receipt).toBeUndefined();
		expect(authority.read(now).reservedMicros).toBe(0);
	} finally {
		authority.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("refuses a quote for a different Yard or provider before reservation", async () => {
	const now = "2026-10-29T12:00:00Z";
	const dir = mkdtempSync(join(tmpdir(), "yard-foreign-quote-"));
	const authority = createSqliteBudgetAdmissionAuthority({
		path: join(dir, "budget.sqlite"),
		now: () => now,
		snapshot: create(BudgetLedgerSnapshotSchema, {
			identity: {
				tenantId: "tenant",
				budgetId: "hosting",
				periodId: "2026-10",
				policyRevision: "r1",
			},
			limitMicros: 100,
			observedAt: "2026-10-29T00:00:00Z",
			validUntil: "2026-11-01T00:00:00Z",
		}),
	});
	try {
		const request = buildDeploymentRequestFromParts({
			bindleName: "shop",
			ownerTenantId: "tenant",
			providerId: LOCAL_HOST_PROVIDER_ID,
			resources: [
				{ resourceId: "api", port: "hobo:http-service", features: [] },
			],
		});
		const yard = localYardInstance({
			yardId: "yard:a",
			ownerTenantId: "tenant",
			providerId: LOCAL_HOST_PROVIDER_ID,
		});
		const quote = create(HostingQuoteSchema, {
			quoteId: "q",
			yardId: "yard:foreign",
			providerId: "foreign",
			ownerTenantId: "tenant",
			currency: "USD",
			totalMicros: 10,
			liabilityBoundMicros: 20,
			components: [{ name: "execution", costMicros: 10 }],
			requestDigest: contentHashOf(request),
			observedAt: "2026-10-29T00:00:00Z",
			validUntil: "2026-11-01T00:00:00Z",
		});
		bindTestYardWork(quote, request, "broker:test", createLocalHostCatalog(), {
			yardId: "yard:a",
			providerId: LOCAL_HOST_PROVIDER_ID,
		});
		const result = await resolveBindleDeployment(request, {
			brokerId: "broker:test",
			ownerTenantId: "tenant",
			catalog: createLocalHostCatalog(),
			seedLocalYard: false,
			priorEvents: [
				yardEvent(YARD_EVENTS.Registered, { yard }),
				yardEvent(YARD_EVENTS.Ready, { yardId: yard.yardId }),
			],
			hostingBudget: { authority, quotes: [quote], now: () => now },
			authorizeHosting(input) {
				return {
					gate: { effect: "allow", reasons: [], events: [] },
					proof: create(HostingPolicyProofSchema, {
						requestDigest: input.requestDigest,
						quoteId: input.quote.quoteId,
						quoteDigest: input.quoteDigest,
						identity: input.identity,
						effect: "allow",
						policyHash: "approved",
						evidenceRef: "policy",
						obligationsSatisfied: true,
					}),
				};
			},
		});
		expect(result.outcome).toBe("rejected");
		expect(result.receipt).toBeUndefined();
		expect(authority.read(now).reservedMicros).toBe(0);
	} finally {
		authority.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
