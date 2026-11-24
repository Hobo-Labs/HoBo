import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Activity } from "effect/workflow";
import {
	CloudBackendId,
	CloudProviderKind,
	TrafficRouteId,
} from "./ids.js";
import {
	CompleteTrafficCutover,
	CutoverNotInProgress,
	FlagCutoverReconciliation,
	RecordRampStep,
	RecordTtlLowered,
	RollbackTrafficCutover,
	TrafficRoute,
} from "./TrafficRoute.aggregate.js";

export class RoutingMutationAmbiguous extends Domain.Rejection(
	"RoutingMutationAmbiguous",
	{
		reason: Schema.String,
	},
) {}

export class TrafficRoutingBackend extends Domain.ExternalSystem(
	"TrafficRoutingBackend",
	{
		lowerTtl: {
			args: {
				routeId: TrafficRouteId,
				ttlSeconds: Schema.Int,
			},
			success: {
				appliedTtlSeconds: Schema.Int,
			},
			error: [RoutingMutationAmbiguous],
		},
		applyWeight: {
			args: {
				routeId: TrafficRouteId,
				toProvider: CloudProviderKind,
				toBackendId: CloudBackendId,
				weightPercent: Schema.Int,
			},
			success: {
				appliedWeightPercent: Schema.Int,
			},
			error: [RoutingMutationAmbiguous],
		},
		observeHealth: {
			args: {
				routeId: TrafficRouteId,
				toProvider: CloudProviderKind,
				toBackendId: CloudBackendId,
				weightPercent: Schema.Int,
			},
			success: {
				healthy: Schema.Boolean,
				summary: Schema.String,
			},
			error: [RoutingMutationAmbiguous],
		},
		restoreIncumbent: {
			args: {
				routeId: TrafficRouteId,
				reason: Schema.String,
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
			toProvider: CloudProviderKind,
			toBackendId: CloudBackendId,
			rampSteps: Schema.Array(Schema.Int),
			lowTtlSeconds: Schema.Int,
			completedAtMs: Schema.Int,
		},
		rejects: [CutoverNotInProgress],
	},
	{
		description:
			"Lower DNS TTL, ramp traffic progressively across Vercel and Cloudflare with health checks, roll back on unhealthy probes, and fail closed to reconciliation on ambiguous noRollback errors.",
	},
) {}

export const ExecuteProgressiveCutoverLive = ExecuteProgressiveCutover.toLayer(
	Effect.gen(function* () {
		const routes = yield* TrafficRoute;
		const backend = yield* TrafficRoutingBackend;

		return Effect.fn(function* ({
			key,
			toProvider,
			toBackendId,
			rampSteps,
			lowTtlSeconds,
			completedAtMs,
		}) {
			const lowered = yield* Activity.make({
				name: "lower-dns-ttl",
				success: Schema.Struct({ appliedTtlSeconds: Schema.Int }),
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
				error: CutoverNotInProgress,
				execute: routes
					.send(
						key,
						new RecordTtlLowered({
							ttlSeconds: lowered.success.appliedTtlSeconds,
						}),
					)
					.pipe(Effect.asVoid),
			});

			const steps = rampSteps.length > 0 ? rampSteps : [10, 50, 100];
			for (const weightPercent of steps) {
				const applied = yield* Activity.make({
					name: `apply-weight-${weightPercent}`,
					success: Schema.Struct({ appliedWeightPercent: Schema.Int }),
					error: RoutingMutationAmbiguous,
					execute: backend.applyWeight({
						routeId: key,
						toProvider,
						toBackendId,
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
					error: CutoverNotInProgress,
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
						summary: Schema.String,
					}),
					error: RoutingMutationAmbiguous,
					execute: backend.observeHealth({
						routeId: key,
						toProvider,
						toBackendId,
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
					yield* Activity.make({
						name: `restore-incumbent-${weightPercent}`,
						success: Schema.Struct({ restored: Schema.Boolean }),
						error: RoutingMutationAmbiguous,
						execute: backend.restoreIncumbent({
							routeId: key,
							reason: health.success.summary,
						}),
					}).pipe(Effect.ignore);
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
				error: CutoverNotInProgress,
				execute: routes
					.send(key, new CompleteTrafficCutover({ completedAtMs }))
					.pipe(Effect.asVoid),
			});
		});
	}),
);
