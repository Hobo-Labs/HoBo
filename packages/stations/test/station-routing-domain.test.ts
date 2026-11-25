import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
	BudgetMigrationProposed,
	CloudBackendId,
	type CloudBackendTarget,
	CutoverCompleted,
	CutoverCooldownActive,
	CutoverFlipLimitExceeded,
	CutoverPreconditionRefused,
	CutoverRampAdvanced,
	CutoverReconciliationRequired,
	CutoverReconciliationResolved,
	CutoverRolledBack,
	CutoverTtlLowered,
	FlagCutoverReconciliation,
	decodeEpochMs,
	decodeLoweredTtlEvidence,
	decodeNonNegativeCount,
	decodeNonNegativeMs,
	decodeNonNegativeSeconds,
	decodePositiveSwapLimit,
	decodeProgressiveRampPlan,
	decodeRampWeightPercent,
	decodeTtlSeconds,
	NonEmptyReason,
	ProposeBudgetMigration,
	RegisterTrafficIncumbent,
	ResolveTrafficCutoverReconciliation,
	RollbackTrafficCutover,
	RoutingMutationAmbiguous,
	StationRouting,
	StationRoutingHandlers,
	TrafficIncumbentRegistered,
	TrafficRoute,
	TrafficRouteId,
	type TrafficRouteState,
	TrafficRoutingBackend,
	TrafficRoutingView,
} from "../src/domain/index.js";

const story = Story.make(StationRouting, {
	layer: StationRoutingHandlers,
	stub: [TrafficRoutingBackend],
});

const VERCEL_TARGET: CloudBackendTarget = {
	provider: "vercel",
	backendId: CloudBackendId.make("vercel-iad1"),
};

const CLOUDFLARE_TARGET: CloudBackendTarget = {
	provider: "cloudflare",
	backendId: CloudBackendId.make("cloudflare-workers-edge"),
};

const TTL_300 = decodeTtlSeconds(300);
const TTL_30 = decodeTtlSeconds(30);
const WEIGHT_10 = decodeRampWeightPercent(10);
const WEIGHT_50 = decodeRampWeightPercent(50);
const WEIGHT_100 = decodeRampWeightPercent(100);

describe("@hobo/stations/domain StationRouting (static invariants + BDD)", () => {
	it("passes Domain.verify static model verification", () => {
		expect(Domain.verify(StationRouting)).toEqual([]);
	});

	it("rejects illegal TTLs, weights, swap limits, ramp plans, and TTL evidence at the schema boundary", () => {
		expect(() => decodeTtlSeconds(4)).toThrow();
		expect(() => decodeRampWeightPercent(-1)).toThrow();
		expect(() => decodeRampWeightPercent(101)).toThrow();
		expect(() => decodePositiveSwapLimit(0)).toThrow();
		expect(() => decodeNonNegativeMs(-1)).toThrow();
		expect(() =>
			decodeProgressiveRampPlan([WEIGHT_50, WEIGHT_10, WEIGHT_100]),
		).toThrow();
		expect(() =>
			decodeProgressiveRampPlan([WEIGHT_10, WEIGHT_50]),
		).toThrow();
		expect(() =>
			decodeLoweredTtlEvidence({
				previousTtlSeconds: TTL_300,
				loweredTtlSeconds: TTL_300,
				waitedSeconds: decodeNonNegativeSeconds(300),
			}),
		).toThrow();
		expect(() =>
			decodeLoweredTtlEvidence({
				previousTtlSeconds: TTL_300,
				loweredTtlSeconds: TTL_30,
				waitedSeconds: decodeNonNegativeSeconds(120),
			}),
		).toThrow();
		expect(
			decodeLoweredTtlEvidence({
				previousTtlSeconds: TTL_300,
				loweredTtlSeconds: TTL_30,
				waitedSeconds: decodeNonNegativeSeconds(300),
			}),
		).toEqual({
			previousTtlSeconds: 300,
			loweredTtlSeconds: 30,
			waitedSeconds: 300,
		});
	});

	it("prevents unbranded primitives, cross-brand IDs, and impossible state fields at compile time", () => {
		const compileTimeChecks = (state: TrafficRouteState) => {
			if (state._tag === "Steady") {
				const incumbent: CloudBackendTarget = state.incumbent;
				// @ts-expect-error Steady state cannot carry a challenger
				const impossibleChallenger = state.challenger;
				return { incumbent, impossibleChallenger };
			}
			if (state._tag === "Unregistered") {
				// @ts-expect-error Unregistered state cannot carry an incumbent
				const impossibleIncumbent = state.incumbent;
				return { impossibleIncumbent };
			}
			return state;
		};

		const rejectRawPrimitives = () => {
			new RegisterTrafficIncumbent({
				incumbent: {
					provider: "vercel",
					// @ts-expect-error TrafficRouteId is nominally distinct from CloudBackendId
					backendId: TrafficRouteId.make("route-1"),
				},
				// @ts-expect-error raw number is not a branded TtlSeconds
				ttlSeconds: 300,
				policy: {
					cooldownMs: decodeNonNegativeMs(0),
					rollbackCooldownMs: decodeNonNegativeMs(0),
					flipWindowMs: decodeNonNegativeMs(86_400_000),
					maxSwapsPerWindow: decodePositiveSwapLimit(1),
				},
			});
		};

		expect(compileTimeChecks).toBeDefined();
		expect(rejectRawPrimitives).toBeDefined();
	});

	it("progressively migrates Vercel -> Cloudflare and enforces target distinction, cooldown, and flip limit", async () => {
		const routeId = TrafficRouteId.make("route-ci-relay");
		const route = TrafficRoute.ref(routeId);
		const policy = {
			cooldownMs: decodeNonNegativeMs(60_000),
			rollbackCooldownMs: decodeNonNegativeMs(60_000),
			flipWindowMs: decodeNonNegativeMs(86_400_000),
			maxSwapsPerWindow: decodePositiveSwapLimit(1),
		};
		const budgetReason = NonEmptyReason.make(
			"vercel-credits-exhausted-cloudflare-lower-cost",
		);
		const healthy10 = NonEmptyReason.make("p99 18ms, 0% 5xx");
		const healthy50 = NonEmptyReason.make("p99 20ms, 0% 5xx");
		const healthy100 = NonEmptyReason.make("p99 21ms, 0% 5xx");

		await Effect.runPromise(
			story(
				Story.when(
					route,
					new RegisterTrafficIncumbent({
						incumbent: VERCEL_TARGET,
						ttlSeconds: TTL_300,
						policy,
					}),
				),
				Story.then(
					route,
					new TrafficIncumbentRegistered({
						incumbent: VERCEL_TARGET,
						ttlSeconds: TTL_300,
						policy,
					}),
				),
				Story.when(
					route,
					new ProposeBudgetMigration({
						to: VERCEL_TARGET,
						reason: NonEmptyReason.make("noop-same-target"),
						nowMs: decodeEpochMs(500),
						preconditionsMet: true,
					}),
				),
				Story.rejected(
					new CutoverPreconditionRefused({
						reason: "target-matches-incumbent",
					}),
				),
				Story.when(
					route,
					new ProposeBudgetMigration({
						to: CLOUDFLARE_TARGET,
						reason: budgetReason,
						nowMs: decodeEpochMs(1_000),
						preconditionsMet: true,
					}),
				),
				Story.then(
					route,
					new BudgetMigrationProposed({
						from: VERCEL_TARGET,
						to: CLOUDFLARE_TARGET,
						reason: budgetReason,
						proposedAtMs: decodeEpochMs(1_000),
						previousTtlSeconds: TTL_300,
					}),
				),
				Story.call(TrafficRoutingBackend.lowerTtl, {
					routeId,
					ttlSeconds: TTL_30,
					previousTtlSeconds: TTL_300,
				}),
				Story.succeed(TrafficRoutingBackend.lowerTtl, {
					appliedTtlSeconds: TTL_30,
					waitedSeconds: 300,
				}),
				Story.then(route, new CutoverTtlLowered({ ttlSeconds: TTL_30 })),
				Story.call(TrafficRoutingBackend.applyWeight, {
					routeId,
					to: CLOUDFLARE_TARGET,
					weightPercent: WEIGHT_10,
				}),
				Story.succeed(TrafficRoutingBackend.applyWeight, {
					appliedWeightPercent: WEIGHT_10,
				}),
				Story.then(
					route,
					new CutoverRampAdvanced({
						targetWeightPercent: WEIGHT_10,
						to: CLOUDFLARE_TARGET,
					}),
				),
				Story.call(TrafficRoutingBackend.observeHealth, {
					routeId,
					to: CLOUDFLARE_TARGET,
					weightPercent: WEIGHT_10,
				}),
				Story.succeed(TrafficRoutingBackend.observeHealth, {
					healthy: true,
					summary: healthy10,
				}),
				Story.call(TrafficRoutingBackend.applyWeight, {
					routeId,
					to: CLOUDFLARE_TARGET,
					weightPercent: WEIGHT_50,
				}),
				Story.succeed(TrafficRoutingBackend.applyWeight, {
					appliedWeightPercent: WEIGHT_50,
				}),
				Story.then(
					route,
					new CutoverRampAdvanced({
						targetWeightPercent: WEIGHT_50,
						to: CLOUDFLARE_TARGET,
					}),
				),
				Story.call(TrafficRoutingBackend.observeHealth, {
					routeId,
					to: CLOUDFLARE_TARGET,
					weightPercent: WEIGHT_50,
				}),
				Story.succeed(TrafficRoutingBackend.observeHealth, {
					healthy: true,
					summary: healthy50,
				}),
				Story.call(TrafficRoutingBackend.applyWeight, {
					routeId,
					to: CLOUDFLARE_TARGET,
					weightPercent: WEIGHT_100,
				}),
				Story.succeed(TrafficRoutingBackend.applyWeight, {
					appliedWeightPercent: WEIGHT_100,
				}),
				Story.then(
					route,
					new CutoverRampAdvanced({
						targetWeightPercent: WEIGHT_100,
						to: CLOUDFLARE_TARGET,
					}),
				),
				Story.call(TrafficRoutingBackend.observeHealth, {
					routeId,
					to: CLOUDFLARE_TARGET,
					weightPercent: WEIGHT_100,
				}),
				Story.succeed(TrafficRoutingBackend.observeHealth, {
					healthy: true,
					summary: healthy100,
				}),
				Story.then(
					route,
					new CutoverCompleted({
						incumbent: CLOUDFLARE_TARGET,
						completedAtMs: decodeEpochMs(5_000),
						swapsInWindow: decodeNonNegativeCount(1),
					}),
				),
				Story.view(TrafficRoutingView, route, {
					_tag: "Steady",
					incumbent: CLOUDFLARE_TARGET,
					ttlSeconds: TTL_30,
					swapsCompleted: decodeNonNegativeCount(1),
				}),
				Story.when(
					route,
					new ProposeBudgetMigration({
						to: VERCEL_TARGET,
						reason: NonEmptyReason.make("too-soon-flipback"),
						nowMs: decodeEpochMs(10_000),
						preconditionsMet: true,
					}),
				),
				Story.rejected(
					new CutoverCooldownActive({
						nextAllowedAtMs: decodeEpochMs(65_000),
						nowMs: decodeEpochMs(10_000),
					}),
				),
				Story.when(
					route,
					new ProposeBudgetMigration({
						to: VERCEL_TARGET,
						reason: NonEmptyReason.make("past-cooldown-but-at-flip-limit"),
						nowMs: decodeEpochMs(70_000),
						preconditionsMet: true,
					}),
				),
				Story.rejected(
					new CutoverFlipLimitExceeded({
						swapsInWindow: decodeNonNegativeCount(1),
						maxSwapsPerWindow: decodePositiveSwapLimit(1),
					}),
				),
			),
		);
	});

	it("rolls back on unhealthy probe and blocks new migrations after ambiguous noRollback failure", async () => {
		const rollbackRouteId = TrafficRouteId.make("route-rollback");
		const rollbackRoute = TrafficRoute.ref(rollbackRouteId);
		const reconcileRouteId = TrafficRouteId.make("route-reconcile");
		const reconcileRoute = TrafficRoute.ref(reconcileRouteId);
		const policy = {
			cooldownMs: decodeNonNegativeMs(0),
			rollbackCooldownMs: decodeNonNegativeMs(30_000),
			flipWindowMs: decodeNonNegativeMs(86_400_000),
			maxSwapsPerWindow: decodePositiveSwapLimit(4),
		};
		const canaryFailure = NonEmptyReason.make("5xx spike on canary");
		const ambiguousFailure = NonEmptyReason.make(
			"dns-provider-timeout-outcome-unknown",
		);
		const replenishReason = NonEmptyReason.make(
			"vercel-credit-grant-replenished",
		);
		const shiftReason = NonEmptyReason.make("budget-shift");

		await Effect.runPromise(
			story(
				Story.when(
					rollbackRoute,
					new RegisterTrafficIncumbent({
						incumbent: CLOUDFLARE_TARGET,
						ttlSeconds: TTL_300,
						policy,
					}),
				),
				Story.then(
					rollbackRoute,
					new TrafficIncumbentRegistered({
						incumbent: CLOUDFLARE_TARGET,
						ttlSeconds: TTL_300,
						policy,
					}),
				),
				Story.when(
					rollbackRoute,
					new ProposeBudgetMigration({
						to: VERCEL_TARGET,
						reason: replenishReason,
						nowMs: decodeEpochMs(1_000),
						preconditionsMet: true,
					}),
				),
				Story.then(
					rollbackRoute,
					new BudgetMigrationProposed({
						from: CLOUDFLARE_TARGET,
						to: VERCEL_TARGET,
						reason: replenishReason,
						proposedAtMs: decodeEpochMs(1_000),
						previousTtlSeconds: TTL_300,
					}),
				),
				Story.call(TrafficRoutingBackend.lowerTtl, {
					routeId: rollbackRouteId,
					ttlSeconds: TTL_30,
					previousTtlSeconds: TTL_300,
				}),
				Story.succeed(TrafficRoutingBackend.lowerTtl, {
					appliedTtlSeconds: TTL_30,
					waitedSeconds: 300,
				}),
				Story.then(rollbackRoute, new CutoverTtlLowered({ ttlSeconds: TTL_30 })),
				Story.call(TrafficRoutingBackend.applyWeight, {
					routeId: rollbackRouteId,
					to: VERCEL_TARGET,
					weightPercent: WEIGHT_10,
				}),
				Story.succeed(TrafficRoutingBackend.applyWeight, {
					appliedWeightPercent: WEIGHT_10,
				}),
				Story.then(
					rollbackRoute,
					new CutoverRampAdvanced({
						targetWeightPercent: WEIGHT_10,
						to: VERCEL_TARGET,
					}),
				),
				Story.call(TrafficRoutingBackend.observeHealth, {
					routeId: rollbackRouteId,
					to: VERCEL_TARGET,
					weightPercent: WEIGHT_10,
				}),
				Story.succeed(TrafficRoutingBackend.observeHealth, {
					healthy: false,
					summary: canaryFailure,
				}),
				Story.call(TrafficRoutingBackend.restoreIncumbent, {
					routeId: rollbackRouteId,
					reason: canaryFailure,
				}),
				Story.succeed(TrafficRoutingBackend.restoreIncumbent, {
					restored: true,
				}),
				Story.call(TrafficRoutingBackend.restoreTtl, {
					routeId: rollbackRouteId,
					ttlSeconds: TTL_300,
				}),
				Story.succeed(TrafficRoutingBackend.restoreTtl, {
					appliedTtlSeconds: TTL_300,
				}),
				Story.then(
					rollbackRoute,
					new CutoverRolledBack({
						restored: CLOUDFLARE_TARGET,
						reason: canaryFailure,
						rolledBackAtMs: decodeEpochMs(5_000),
						restoredTtlSeconds: TTL_300,
					}),
				),
				Story.view(TrafficRoutingView, rollbackRoute, {
					_tag: "RolledBack",
					incumbent: CLOUDFLARE_TARGET,
					ttlSeconds: TTL_300,
					reason: canaryFailure,
				}),
				Story.when(
					reconcileRoute,
					new RegisterTrafficIncumbent({
						incumbent: VERCEL_TARGET,
						ttlSeconds: TTL_300,
						policy,
					}),
				),
				Story.then(
					reconcileRoute,
					new TrafficIncumbentRegistered({
						incumbent: VERCEL_TARGET,
						ttlSeconds: TTL_300,
						policy,
					}),
				),
				Story.when(
					reconcileRoute,
					new ProposeBudgetMigration({
						to: CLOUDFLARE_TARGET,
						reason: shiftReason,
						nowMs: decodeEpochMs(3_000),
						preconditionsMet: true,
					}),
				),
				Story.then(
					reconcileRoute,
					new BudgetMigrationProposed({
						from: VERCEL_TARGET,
						to: CLOUDFLARE_TARGET,
						reason: shiftReason,
						proposedAtMs: decodeEpochMs(3_000),
						previousTtlSeconds: TTL_300,
					}),
				),
				Story.call(TrafficRoutingBackend.lowerTtl, {
					routeId: reconcileRouteId,
					ttlSeconds: TTL_30,
					previousTtlSeconds: TTL_300,
				}),
				Story.fail(
					TrafficRoutingBackend.lowerTtl,
					new RoutingMutationAmbiguous({
						reason: ambiguousFailure,
					}),
				),
				Story.then(
					reconcileRoute,
					new CutoverReconciliationRequired({
						reason: ambiguousFailure,
					}),
				),
				Story.view(TrafficRoutingView, reconcileRoute, {
					_tag: "ReconciliationRequired",
					reason: ambiguousFailure,
				}),
				Story.when(
					reconcileRoute,
					new ProposeBudgetMigration({
						to: CLOUDFLARE_TARGET,
						reason: shiftReason,
						nowMs: decodeEpochMs(5_000),
						preconditionsMet: true,
					}),
				),
				Story.rejected(
					new CutoverPreconditionRefused({
						reason: "reconciliation-pending",
					}),
				),
				Story.when(
					reconcileRoute,
					new RegisterTrafficIncumbent({
						incumbent: VERCEL_TARGET,
						ttlSeconds: TTL_300,
						policy,
					}),
				),
				Story.rejected(
					new CutoverPreconditionRefused({
						reason: "reconciliation-pending",
					}),
				),
			),
		);
	});

	it("fails closed to ReconciliationRequired when incumbent restoration fails or is unconfirmed during rollback", async () => {
		const routeId = TrafficRouteId.make("route-failed-restore");
		const route = TrafficRoute.ref(routeId);
		const policy = {
			cooldownMs: decodeNonNegativeMs(0),
			rollbackCooldownMs: decodeNonNegativeMs(30_000),
			flipWindowMs: decodeNonNegativeMs(86_400_000),
			maxSwapsPerWindow: decodePositiveSwapLimit(4),
		};
		const canaryFailure = NonEmptyReason.make("canary-5xx-burst");
		const restoreFailure = NonEmptyReason.make("dns-restore-timeout");
		const shiftReason = NonEmptyReason.make("budget-shift");

		await Effect.runPromise(
			story(
				Story.when(
					route,
					new RegisterTrafficIncumbent({
						incumbent: VERCEL_TARGET,
						ttlSeconds: TTL_300,
						policy,
					}),
				),
				Story.then(
					route,
					new TrafficIncumbentRegistered({
						incumbent: VERCEL_TARGET,
						ttlSeconds: TTL_300,
						policy,
					}),
				),
				Story.when(
					route,
					new ProposeBudgetMigration({
						to: CLOUDFLARE_TARGET,
						reason: shiftReason,
						nowMs: decodeEpochMs(1_000),
						preconditionsMet: true,
					}),
				),
				Story.then(
					route,
					new BudgetMigrationProposed({
						from: VERCEL_TARGET,
						to: CLOUDFLARE_TARGET,
						reason: shiftReason,
						proposedAtMs: decodeEpochMs(1_000),
						previousTtlSeconds: TTL_300,
					}),
				),
				Story.call(TrafficRoutingBackend.lowerTtl, {
					routeId,
					ttlSeconds: TTL_30,
					previousTtlSeconds: TTL_300,
				}),
				Story.succeed(TrafficRoutingBackend.lowerTtl, {
					appliedTtlSeconds: TTL_30,
					waitedSeconds: 300,
				}),
				Story.then(route, new CutoverTtlLowered({ ttlSeconds: TTL_30 })),
				Story.call(TrafficRoutingBackend.applyWeight, {
					routeId,
					to: CLOUDFLARE_TARGET,
					weightPercent: WEIGHT_10,
				}),
				Story.succeed(TrafficRoutingBackend.applyWeight, {
					appliedWeightPercent: WEIGHT_10,
				}),
				Story.then(
					route,
					new CutoverRampAdvanced({
						targetWeightPercent: WEIGHT_10,
						to: CLOUDFLARE_TARGET,
					}),
				),
				Story.call(TrafficRoutingBackend.observeHealth, {
					routeId,
					to: CLOUDFLARE_TARGET,
					weightPercent: WEIGHT_10,
				}),
				Story.succeed(TrafficRoutingBackend.observeHealth, {
					healthy: false,
					summary: canaryFailure,
				}),
				Story.call(TrafficRoutingBackend.restoreIncumbent, {
					routeId,
					reason: canaryFailure,
				}),
				Story.fail(
					TrafficRoutingBackend.restoreIncumbent,
					new RoutingMutationAmbiguous({ reason: restoreFailure }),
				),
				Story.then(
					route,
					new CutoverReconciliationRequired({ reason: restoreFailure }),
				),
				Story.view(TrafficRoutingView, route, {
					_tag: "ReconciliationRequired",
					reason: restoreFailure,
				}),
			),
		);
	});

	it("decays flip-window swap counts after the window elapses", async () => {
		const routeId = TrafficRouteId.make("route-flip-decay");
		const route = TrafficRoute.ref(routeId);
		const policy = {
			cooldownMs: decodeNonNegativeMs(0),
			rollbackCooldownMs: decodeNonNegativeMs(0),
			flipWindowMs: decodeNonNegativeMs(1_000),
			maxSwapsPerWindow: decodePositiveSwapLimit(1),
		};
		const shiftReason = NonEmptyReason.make("budget-shift");

		await Effect.runPromise(
			story(
				Story.when(
					route,
					new RegisterTrafficIncumbent({
						incumbent: VERCEL_TARGET,
						ttlSeconds: TTL_300,
						policy,
					}),
				),
				Story.then(
					route,
					new TrafficIncumbentRegistered({
						incumbent: VERCEL_TARGET,
						ttlSeconds: TTL_300,
						policy,
					}),
				),
				Story.when(
					route,
					new ProposeBudgetMigration({
						to: CLOUDFLARE_TARGET,
						reason: shiftReason,
						nowMs: decodeEpochMs(1_000),
						preconditionsMet: true,
					}),
				),
				Story.then(
					route,
					new BudgetMigrationProposed({
						from: VERCEL_TARGET,
						to: CLOUDFLARE_TARGET,
						reason: shiftReason,
						proposedAtMs: decodeEpochMs(1_000),
						previousTtlSeconds: TTL_300,
					}),
				),
				Story.call(TrafficRoutingBackend.lowerTtl, {
					routeId,
					ttlSeconds: TTL_30,
					previousTtlSeconds: TTL_300,
				}),
				Story.succeed(TrafficRoutingBackend.lowerTtl, {
					appliedTtlSeconds: TTL_30,
					waitedSeconds: 300,
				}),
				Story.then(route, new CutoverTtlLowered({ ttlSeconds: TTL_30 })),
				Story.call(TrafficRoutingBackend.applyWeight, {
					routeId,
					to: CLOUDFLARE_TARGET,
					weightPercent: WEIGHT_10,
				}),
				Story.succeed(TrafficRoutingBackend.applyWeight, {
					appliedWeightPercent: WEIGHT_10,
				}),
				Story.then(
					route,
					new CutoverRampAdvanced({
						targetWeightPercent: WEIGHT_10,
						to: CLOUDFLARE_TARGET,
					}),
				),
				Story.call(TrafficRoutingBackend.observeHealth, {
					routeId,
					to: CLOUDFLARE_TARGET,
					weightPercent: WEIGHT_10,
				}),
				Story.succeed(TrafficRoutingBackend.observeHealth, {
					healthy: true,
					summary: NonEmptyReason.make("ok"),
				}),
				Story.call(TrafficRoutingBackend.applyWeight, {
					routeId,
					to: CLOUDFLARE_TARGET,
					weightPercent: WEIGHT_50,
				}),
				Story.succeed(TrafficRoutingBackend.applyWeight, {
					appliedWeightPercent: WEIGHT_50,
				}),
				Story.then(
					route,
					new CutoverRampAdvanced({
						targetWeightPercent: WEIGHT_50,
						to: CLOUDFLARE_TARGET,
					}),
				),
				Story.call(TrafficRoutingBackend.observeHealth, {
					routeId,
					to: CLOUDFLARE_TARGET,
					weightPercent: WEIGHT_50,
				}),
				Story.succeed(TrafficRoutingBackend.observeHealth, {
					healthy: true,
					summary: NonEmptyReason.make("ok"),
				}),
				Story.call(TrafficRoutingBackend.applyWeight, {
					routeId,
					to: CLOUDFLARE_TARGET,
					weightPercent: WEIGHT_100,
				}),
				Story.succeed(TrafficRoutingBackend.applyWeight, {
					appliedWeightPercent: WEIGHT_100,
				}),
				Story.then(
					route,
					new CutoverRampAdvanced({
						targetWeightPercent: WEIGHT_100,
						to: CLOUDFLARE_TARGET,
					}),
				),
				Story.call(TrafficRoutingBackend.observeHealth, {
					routeId,
					to: CLOUDFLARE_TARGET,
					weightPercent: WEIGHT_100,
				}),
				Story.succeed(TrafficRoutingBackend.observeHealth, {
					healthy: true,
					summary: NonEmptyReason.make("ok"),
				}),
				Story.then(
					route,
					new CutoverCompleted({
						incumbent: CLOUDFLARE_TARGET,
						completedAtMs: decodeEpochMs(5_000),
						swapsInWindow: decodeNonNegativeCount(1),
					}),
				),
				Story.when(
					route,
					new ProposeBudgetMigration({
						to: VERCEL_TARGET,
						reason: NonEmptyReason.make("inside-flip-window"),
						nowMs: decodeEpochMs(5_500),
						preconditionsMet: true,
					}),
				),
				Story.rejected(
					new CutoverFlipLimitExceeded({
						swapsInWindow: decodeNonNegativeCount(1),
						maxSwapsPerWindow: decodePositiveSwapLimit(1),
					}),
				),
				Story.when(
					route,
					new ProposeBudgetMigration({
						to: VERCEL_TARGET,
						reason: NonEmptyReason.make("after-flip-window-decay"),
						nowMs: decodeEpochMs(6_500),
						preconditionsMet: true,
					}),
				),
				Story.then(
					route,
					new BudgetMigrationProposed({
						from: CLOUDFLARE_TARGET,
						to: VERCEL_TARGET,
						reason: NonEmptyReason.make("after-flip-window-decay"),
						proposedAtMs: decodeEpochMs(6_500),
						previousTtlSeconds: TTL_30,
					}),
				),
			),
		);
	});

	it("enforces rollback cooldown before proposing after RolledBack", async () => {
		const routeId = TrafficRouteId.make("route-rollback-cooldown");
		const route = TrafficRoute.ref(routeId);
		const policy = {
			cooldownMs: decodeNonNegativeMs(0),
			rollbackCooldownMs: decodeNonNegativeMs(30_000),
			flipWindowMs: decodeNonNegativeMs(86_400_000),
			maxSwapsPerWindow: decodePositiveSwapLimit(4),
		};

		await Effect.runPromise(
			story(
				Story.when(
					route,
					new RegisterTrafficIncumbent({
						incumbent: VERCEL_TARGET,
						ttlSeconds: TTL_300,
						policy,
					}),
				),
				Story.then(
					route,
					new TrafficIncumbentRegistered({
						incumbent: VERCEL_TARGET,
						ttlSeconds: TTL_300,
						policy,
					}),
				),
				Story.when(
					route,
					new ProposeBudgetMigration({
						to: CLOUDFLARE_TARGET,
						reason: NonEmptyReason.make("shift"),
						nowMs: decodeEpochMs(1_000),
						preconditionsMet: true,
					}),
				),
				Story.then(
					route,
					new BudgetMigrationProposed({
						from: VERCEL_TARGET,
						to: CLOUDFLARE_TARGET,
						reason: NonEmptyReason.make("shift"),
						proposedAtMs: decodeEpochMs(1_000),
						previousTtlSeconds: TTL_300,
					}),
				),
				Story.when(
					route,
					new RollbackTrafficCutover({
						reason: NonEmptyReason.make("canary-failed"),
						rolledBackAtMs: decodeEpochMs(5_000),
					}),
				),
				Story.then(
					route,
					new CutoverRolledBack({
						restored: VERCEL_TARGET,
						reason: NonEmptyReason.make("canary-failed"),
						rolledBackAtMs: decodeEpochMs(5_000),
						restoredTtlSeconds: TTL_300,
					}),
				),
				Story.when(
					route,
					new ProposeBudgetMigration({
						to: CLOUDFLARE_TARGET,
						reason: NonEmptyReason.make("too-soon-after-rollback"),
						nowMs: decodeEpochMs(10_000),
						preconditionsMet: true,
					}),
				),
				Story.rejected(
					new CutoverCooldownActive({
						nextAllowedAtMs: decodeEpochMs(35_000),
						nowMs: decodeEpochMs(10_000),
					}),
				),
				Story.call(TrafficRoutingBackend.lowerTtl, {
					routeId,
					ttlSeconds: TTL_30,
					previousTtlSeconds: TTL_300,
				}),
				Story.succeed(TrafficRoutingBackend.lowerTtl, {
					appliedTtlSeconds: TTL_30,
					waitedSeconds: 300,
				}),
			),
		);
	});

	it("clears ReconciliationRequired via ResolveTrafficCutoverReconciliation", async () => {
		const routeId = TrafficRouteId.make("route-resolve");
		const route = TrafficRoute.ref(routeId);
		const policy = {
			cooldownMs: decodeNonNegativeMs(0),
			rollbackCooldownMs: decodeNonNegativeMs(0),
			flipWindowMs: decodeNonNegativeMs(86_400_000),
			maxSwapsPerWindow: decodePositiveSwapLimit(4),
		};

		await Effect.runPromise(
			story(
				Story.when(
					route,
					new RegisterTrafficIncumbent({
						incumbent: VERCEL_TARGET,
						ttlSeconds: TTL_300,
						policy,
					}),
				),
				Story.then(
					route,
					new TrafficIncumbentRegistered({
						incumbent: VERCEL_TARGET,
						ttlSeconds: TTL_300,
						policy,
					}),
				),
				Story.when(
					route,
					new FlagCutoverReconciliation({
						reason: NonEmptyReason.make("ambiguous-dns"),
					}),
				),
				Story.then(
					route,
					new CutoverReconciliationRequired({
						reason: NonEmptyReason.make("ambiguous-dns"),
					}),
				),
				Story.when(
					route,
					new ResolveTrafficCutoverReconciliation({
						resolvedAtMs: decodeEpochMs(8_000),
					}),
				),
				Story.then(
					route,
					new CutoverReconciliationResolved({
						incumbent: VERCEL_TARGET,
						ttlSeconds: TTL_300,
						policy,
						resolvedAtMs: decodeEpochMs(8_000),
					}),
				),
				Story.view(TrafficRoutingView, route, {
					_tag: "Steady",
					incumbent: VERCEL_TARGET,
					ttlSeconds: TTL_300,
					swapsCompleted: decodeNonNegativeCount(0),
				}),
			),
		);
	});
});
