import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";
import {
	CloudBackendTarget,
	EpochMs,
	NonEmptyReason,
	ProgressiveRampPlan,
	RampWeightPercent,
	TrafficRouteId,
	TtlSeconds,
} from "./ids.js";
import {
	CompleteTrafficCutover,
	CutoverNotInProgress,
	CutoverPreconditionRefused,
	FlagCutoverReconciliation,
	RecordRampStep,
	RecordTtlLowered,
	RollbackTrafficCutover,
	TrafficRoute,
} from "./TrafficRoute.aggregate.js";

export class RoutingMutationAmbiguous extends Domain.Rejection(
	"RoutingMutationAmbiguous",
	{
		reason: NonEmptyReason,
	},
) {}

export class TrafficRoutingBackend extends Domain.ExternalSystem(
	"TrafficRoutingBackend",
	{
		lowerTtl: {
			args: {
				routeId: TrafficRouteId,
				ttlSeconds: TtlSeconds,
			},
			success: {
				appliedTtlSeconds: TtlSeconds,
			},
			error: [RoutingMutationAmbiguous],
		},
		applyWeight: {
			args: {
				routeId: TrafficRouteId,
				to: CloudBackendTarget,
				weightPercent: RampWeightPercent,
			},
			success: {
				appliedWeightPercent: RampWeightPercent,
			},
			error: [RoutingMutationAmbiguous],
		},
		observeHealth: {
			args: {
				routeId: TrafficRouteId,
				to: CloudBackendTarget,
				weightPercent: RampWeightPercent,
			},
			success: {
				healthy: Schema.Boolean,
				summary: NonEmptyReason,
			},
			error: [RoutingMutationAmbiguous],
		},
		restoreIncumbent: {
			args: {
				routeId: TrafficRouteId,
				reason: NonEmptyReason,
			},
			success: {
				restored: Schema.Boolean,
			},
			error: [RoutingMutationAmbiguous],
		},
	},
) {}

export class ExecuteProgressiveCutover extends Domain.Saga(
	"ExecuteProgressiveCutover",
	{
		key: TrafficRouteId,
		input: {
			to: CloudBackendTarget,
			rampPlan: ProgressiveRampPlan,
			lowTtlSeconds: TtlSeconds,
			completedAtMs: EpochMs,
		},
		rejects: [CutoverNotInProgress, CutoverPreconditionRefused],
	},
	{
		description:
			"Lower DNS TTL, ramp traffic progressively across cloud targets with health probes, roll back on unhealthy probes, and fail closed to reconciliation on ambiguous noRollback errors.",
	},
) {}

export const ExecuteProgressiveCutoverLive = ExecuteProgressiveCutover.toLayer(
	Effect.gen(function* () {
		const routes = yield* TrafficRoute;
		const backend = yield* TrafficRoutingBackend;

		return Effect.fn(function* ({
			key,
			to,
			rampPlan,
			lowTtlSeconds,
			completedAtMs,
		}) {
			const lowered = yield* Activity.make({
				name: "lower-dns-ttl",
				success: Schema.Struct({ appliedTtlSeconds: TtlSeconds }),
				error: RoutingMutationAmbiguous,
				execute: backend.lowerTtl({
					routeId: key,
					ttlSeconds: lowTtlSeconds,
				}),
			}).pipe(Effect.result);

			if (lowered._tag === "Failure") {
				yield* Activity.make({
					name: "flag-ttl-reconciliation",
					execute: routes
						.send(
							key,
							new FlagCutoverReconciliation({ reason: lowered.failure.reason }),
						)
						.pipe(Effect.asVoid),
				});
				return;
			}

			yield* Activity.make({
				name: "record-ttl-lowered",
				error: Schema.Union([CutoverNotInProgress, CutoverPreconditionRefused]),
				execute: routes
					.send(
						key,
						new RecordTtlLowered({
							ttlSeconds: lowered.success.appliedTtlSeconds,
						}),
					)
					.pipe(Effect.asVoid),
			});

			for (const weightPercent of rampPlan) {
				const applied = yield* Activity.make({
					name: `apply-weight-${weightPercent}`,
					success: Schema.Struct({ appliedWeightPercent: RampWeightPercent }),
					error: RoutingMutationAmbiguous,
					execute: backend.applyWeight({
						routeId: key,
						to,
						weightPercent,
					}),
				}).pipe(Effect.result);

				if (applied._tag === "Failure") {
					yield* Activity.make({
						name: `flag-weight-reconciliation-${weightPercent}`,
						execute: routes
							.send(
								key,
								new FlagCutoverReconciliation({
									reason: applied.failure.reason,
								}),
							)
							.pipe(Effect.asVoid),
					});
					return;
				}

				yield* Activity.make({
					name: `record-ramp-${weightPercent}`,
					error: Schema.Union([
						CutoverNotInProgress,
						CutoverPreconditionRefused,
					]),
					execute: routes
						.send(
							key,
							new RecordRampStep({
								targetWeightPercent: applied.success.appliedWeightPercent,
							}),
						)
						.pipe(Effect.asVoid),
				});

				const health = yield* Activity.make({
					name: `observe-health-${weightPercent}`,
					success: Schema.Struct({
						healthy: Schema.Boolean,
						summary: NonEmptyReason,
					}),
					error: RoutingMutationAmbiguous,
					execute: backend.observeHealth({
						routeId: key,
						to,
						weightPercent,
					}),
				}).pipe(Effect.result);

				if (health._tag === "Failure") {
					yield* Activity.make({
						name: `flag-health-reconciliation-${weightPercent}`,
						execute: routes
							.send(
								key,
								new FlagCutoverReconciliation({
									reason: health.failure.reason,
								}),
							)
							.pipe(Effect.asVoid),
					});
					return;
				}

				if (!health.success.healthy) {
					const restored = yield* Activity.make({
						name: `restore-incumbent-${weightPercent}`,
						success: Schema.Struct({ restored: Schema.Boolean }),
						error: RoutingMutationAmbiguous,
						execute: backend.restoreIncumbent({
							routeId: key,
							reason: health.success.summary,
						}),
					}).pipe(Effect.result);

					if (restored._tag === "Failure" || !restored.success.restored) {
						const reason =
							restored._tag === "Failure"
								? restored.failure.reason
								: NonEmptyReason.make(
										`incumbent-restoration-unconfirmed:${health.success.summary}`,
									);
						yield* Activity.make({
							name: `flag-restore-reconciliation-${weightPercent}`,
							execute: routes
								.send(key, new FlagCutoverReconciliation({ reason }))
								.pipe(Effect.asVoid),
						});
						return;
					}

					yield* Activity.make({
						name: `record-rollback-${weightPercent}`,
						error: CutoverNotInProgress,
						execute: routes
							.send(
								key,
								new RollbackTrafficCutover({ reason: health.success.summary }),
							)
							.pipe(Effect.asVoid),
					});
					return;
				}
			}

			yield* Activity.make({
				name: "complete-cutover",
				error: Schema.Union([CutoverNotInProgress, CutoverPreconditionRefused]),
				execute: routes
					.send(key, new CompleteTrafficCutover({ completedAtMs }))
					.pipe(Effect.asVoid),
			});
		});
	}),
);
