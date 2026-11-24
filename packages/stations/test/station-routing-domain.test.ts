import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
	BudgetMigrationProposed,
	CloudBackendId,
	CutoverCompleted,
	CutoverCooldownActive,
	CutoverRampAdvanced,
	CutoverReconciliationRequired,
	CutoverRolledBack,
	CutoverTtlLowered,
	ProposeBudgetMigration,
	RegisterTrafficIncumbent,
	RoutingMutationAmbiguous,
	StationRouting,
	StationRoutingHandlers,
	TrafficIncumbentRegistered,
	TrafficRoute,
	TrafficRouteId,
	TrafficRoutingBackend,
	TrafficRoutingView,
} from "../src/domain/index.js";

const story = Story.make(StationRouting, {
	layer: StationRoutingHandlers,
	stub: [TrafficRoutingBackend],
});

describe("@hobo/stations/domain StationRouting (Vercel <-> Cloudflare budget migration)", () => {
	it("passes Domain.verify static model verification", () => {
		expect(Domain.verify(StationRouting)).toEqual([]);
	});

	it("progressively migrates traffic from Vercel to Cloudflare on budget exhaustion and enforces stability cooldown", async () => {
		const routeId = TrafficRouteId.make("route-ci-relay");
		const route = TrafficRoute.ref(routeId);
		const vercelBackend = CloudBackendId.make("vercel-iad1");
		const cloudflareBackend = CloudBackendId.make("cloudflare-workers-edge");

		await Effect.runPromise(
			story(
				Story.when(
					route,
					new RegisterTrafficIncumbent({
						provider: "vercel",
						backendId: vercelBackend,
						ttlSeconds: 300,
						cooldownMs: 60_000,
						maxSwapsPerWindow: 2,
					}),
				),
				Story.then(
					route,
					new TrafficIncumbentRegistered({
						provider: "vercel",
						backendId: vercelBackend,
						ttlSeconds: 300,
						cooldownMs: 60_000,
						maxSwapsPerWindow: 2,
					}),
				),
				Story.when(
					route,
					new ProposeBudgetMigration({
						toProvider: "cloudflare",
						toBackendId: cloudflareBackend,
						reason: "vercel-credits-exhausted-cloudflare-lower-cost",
						nowMs: 1_000,
						preconditionsMet: true,
					}),
				),
				Story.then(
					route,
					new BudgetMigrationProposed({
						fromProvider: "vercel",
						fromBackendId: vercelBackend,
						toProvider: "cloudflare",
						toBackendId: cloudflareBackend,
						reason: "vercel-credits-exhausted-cloudflare-lower-cost",
						proposedAtMs: 1_000,
					}),
				),
				Story.call(TrafficRoutingBackend.lowerTtl, { routeId, ttlSeconds: 30 }),
				Story.succeed(TrafficRoutingBackend.lowerTtl, {
					appliedTtlSeconds: 30,
				}),
				Story.then(route, new CutoverTtlLowered({ ttlSeconds: 30 })),
				Story.call(TrafficRoutingBackend.applyWeight, {
					routeId,
					toProvider: "cloudflare",
					toBackendId: cloudflareBackend,
					weightPercent: 10,
				}),
				Story.succeed(TrafficRoutingBackend.applyWeight, {
					appliedWeightPercent: 10,
				}),
				Story.then(
					route,
					new CutoverRampAdvanced({
						targetWeightPercent: 10,
						toProvider: "cloudflare",
						toBackendId: cloudflareBackend,
					}),
				),
				Story.call(TrafficRoutingBackend.observeHealth, {
					routeId,
					toProvider: "cloudflare",
					toBackendId: cloudflareBackend,
					weightPercent: 10,
				}),
				Story.succeed(TrafficRoutingBackend.observeHealth, {
					healthy: true,
					summary: "p99 18ms, 0% 5xx",
				}),
				Story.call(TrafficRoutingBackend.applyWeight, {
					routeId,
					toProvider: "cloudflare",
					toBackendId: cloudflareBackend,
					weightPercent: 50,
				}),
				Story.succeed(TrafficRoutingBackend.applyWeight, {
					appliedWeightPercent: 50,
				}),
				Story.then(
					route,
					new CutoverRampAdvanced({
						targetWeightPercent: 50,
						toProvider: "cloudflare",
						toBackendId: cloudflareBackend,
					}),
				),
				Story.call(TrafficRoutingBackend.observeHealth, {
					routeId,
					toProvider: "cloudflare",
					toBackendId: cloudflareBackend,
					weightPercent: 50,
				}),
				Story.succeed(TrafficRoutingBackend.observeHealth, {
					healthy: true,
					summary: "p99 20ms, 0% 5xx",
				}),
				Story.call(TrafficRoutingBackend.applyWeight, {
					routeId,
					toProvider: "cloudflare",
					toBackendId: cloudflareBackend,
					weightPercent: 100,
				}),
				Story.succeed(TrafficRoutingBackend.applyWeight, {
					appliedWeightPercent: 100,
				}),
				Story.then(
					route,
					new CutoverRampAdvanced({
						targetWeightPercent: 100,
						toProvider: "cloudflare",
						toBackendId: cloudflareBackend,
					}),
				),
				Story.call(TrafficRoutingBackend.observeHealth, {
					routeId,
					toProvider: "cloudflare",
					toBackendId: cloudflareBackend,
					weightPercent: 100,
				}),
				Story.succeed(TrafficRoutingBackend.observeHealth, {
					healthy: true,
					summary: "p99 21ms, 0% 5xx",
				}),
				Story.then(
					route,
					new CutoverCompleted({
						activeProvider: "cloudflare",
						activeBackendId: cloudflareBackend,
						completedAtMs: 5_000,
					}),
				),
				Story.view(TrafficRoutingView, route, {
					phase: "steady",
					activeProvider: "cloudflare",
					activeBackendId: cloudflareBackend,
					swapsCompleted: 1,
				}),
				Story.when(
					route,
					new ProposeBudgetMigration({
						toProvider: "vercel",
						toBackendId: vercelBackend,
						reason: "too-soon-flipback",
						nowMs: 10_000,
						preconditionsMet: true,
					}),
				),
				Story.rejected(
					new CutoverCooldownActive({
						nextAllowedAtMs: 65_000,
						nowMs: 10_000,
					}),
				),
			),
		);
	});

	it("rolls back to incumbent on unhealthy ramp probe and flags reconciliation on ambiguous noRollback failure", async () => {
		const rollbackRouteId = TrafficRouteId.make("route-rollback");
		const rollbackRoute = TrafficRoute.ref(rollbackRouteId);
		const reconcileRouteId = TrafficRouteId.make("route-reconcile");
		const reconcileRoute = TrafficRoute.ref(reconcileRouteId);
		const vercelBackend = CloudBackendId.make("vercel-iad1");
		const cfBackend = CloudBackendId.make("cloudflare-workers-edge");

		await Effect.runPromise(
			story(
				Story.when(
					rollbackRoute,
					new RegisterTrafficIncumbent({
						provider: "cloudflare",
						backendId: cfBackend,
						ttlSeconds: 300,
						cooldownMs: 0,
						maxSwapsPerWindow: 4,
					}),
				),
				Story.then(
					rollbackRoute,
					new TrafficIncumbentRegistered({
						provider: "cloudflare",
						backendId: cfBackend,
						ttlSeconds: 300,
						cooldownMs: 0,
						maxSwapsPerWindow: 4,
					}),
				),
				Story.when(
					rollbackRoute,
					new ProposeBudgetMigration({
						toProvider: "vercel",
						toBackendId: vercelBackend,
						reason: "vercel-credit-grant-replenished",
						nowMs: 1_000,
						preconditionsMet: true,
					}),
				),
				Story.then(
					rollbackRoute,
					new BudgetMigrationProposed({
						fromProvider: "cloudflare",
						fromBackendId: cfBackend,
						toProvider: "vercel",
						toBackendId: vercelBackend,
						reason: "vercel-credit-grant-replenished",
						proposedAtMs: 1_000,
					}),
				),
				Story.call(TrafficRoutingBackend.lowerTtl, {
					routeId: rollbackRouteId,
					ttlSeconds: 30,
				}),
				Story.succeed(TrafficRoutingBackend.lowerTtl, {
					appliedTtlSeconds: 30,
				}),
				Story.then(rollbackRoute, new CutoverTtlLowered({ ttlSeconds: 30 })),
				Story.call(TrafficRoutingBackend.applyWeight, {
					routeId: rollbackRouteId,
					toProvider: "vercel",
					toBackendId: vercelBackend,
					weightPercent: 10,
				}),
				Story.succeed(TrafficRoutingBackend.applyWeight, {
					appliedWeightPercent: 10,
				}),
				Story.then(
					rollbackRoute,
					new CutoverRampAdvanced({
						targetWeightPercent: 10,
						toProvider: "vercel",
						toBackendId: vercelBackend,
					}),
				),
				Story.call(TrafficRoutingBackend.observeHealth, {
					routeId: rollbackRouteId,
					toProvider: "vercel",
					toBackendId: vercelBackend,
					weightPercent: 10,
				}),
				Story.succeed(TrafficRoutingBackend.observeHealth, {
					healthy: false,
					summary: "5xx spike on canary",
				}),
				Story.call(TrafficRoutingBackend.restoreIncumbent, {
					routeId: rollbackRouteId,
					reason: "5xx spike on canary",
				}),
				Story.succeed(TrafficRoutingBackend.restoreIncumbent, {
					restored: true,
				}),
				Story.then(
					rollbackRoute,
					new CutoverRolledBack({
						restoredProvider: "cloudflare",
						restoredBackendId: cfBackend,
						reason: "5xx spike on canary",
					}),
				),
				Story.view(TrafficRoutingView, rollbackRoute, {
					phase: "rolled-back",
					activeProvider: "cloudflare",
				}),

				Story.when(
					reconcileRoute,
					new RegisterTrafficIncumbent({
						provider: "vercel",
						backendId: vercelBackend,
						ttlSeconds: 300,
						cooldownMs: 0,
						maxSwapsPerWindow: 4,
					}),
				),
				Story.then(
					reconcileRoute,
					new TrafficIncumbentRegistered({
						provider: "vercel",
						backendId: vercelBackend,
						ttlSeconds: 300,
						cooldownMs: 0,
						maxSwapsPerWindow: 4,
					}),
				),
				Story.when(
					reconcileRoute,
					new ProposeBudgetMigration({
						toProvider: "cloudflare",
						toBackendId: cfBackend,
						reason: "budget-shift",
						nowMs: 3_000,
						preconditionsMet: true,
					}),
				),
				Story.then(
					reconcileRoute,
					new BudgetMigrationProposed({
						fromProvider: "vercel",
						fromBackendId: vercelBackend,
						toProvider: "cloudflare",
						toBackendId: cfBackend,
						reason: "budget-shift",
						proposedAtMs: 3_000,
					}),
				),
				Story.call(TrafficRoutingBackend.lowerTtl, {
					routeId: reconcileRouteId,
					ttlSeconds: 30,
				}),
				Story.fail(
					TrafficRoutingBackend.lowerTtl,
					new RoutingMutationAmbiguous({
						reason: "dns-provider-timeout-outcome-unknown",
					}),
				),
				Story.then(
					reconcileRoute,
					new CutoverReconciliationRequired({
						reason: "dns-provider-timeout-outcome-unknown",
					}),
				),
				Story.view(TrafficRoutingView, reconcileRoute, {
					phase: "reconciliation-required",
					reconciliationReason: "dns-provider-timeout-outcome-unknown",
				}),
			),
		);
	});
});
