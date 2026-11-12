/**
 * HoBo Continuous Delivery plane facade.
 * Resolved Set → attested apply → OpenDelivery progressive → failure A2H/self-heal.
 * Not an Argo-shaped controller; no ambient credentials.
 */
import { createHarness, FeatureFlagStore, type Harness } from "@hobo/identity";

import type { ProgressiveAnalysisPort } from "./analysis-adapter.js";
import {
	type AttestedApplyResult,
	type AttestedApplyWorkerOptions,
	type CdApplyEvent,
	createAttestedApplyWorker,
} from "./attested-apply.js";
import {
	createDefaultSafetyEnvelope,
	decideFailurePath,
	type FailureDisposition,
	type FailureSignal,
	type SafetyEnvelope,
	type SelfHealAgentRegistration,
} from "./incident-a2h.js";
import {
	type ProgressiveCdResult,
	runProgressiveComposition,
} from "./progressive-cd.js";
import type { ResolvedDeploymentSet } from "./resolved-set.js";
import type { SecretFreeStatus } from "./secret-free.js";

// public-contract: continuous delivery plane schema.
export const CD_PLANE_SCHEMA = "hobo.continuous-delivery/v1" as const;

export type ContinuousDeliveryResult = Readonly<{
	schemaVersion: typeof CD_PLANE_SCHEMA;
	apply: AttestedApplyResult;
	progressive?: ProgressiveCdResult;
	failure?: FailureDisposition;
	status:
		| "deployed"
		| "holding"
		| "rolled-back"
		| "failed"
		| "a2h"
		| "self-heal-pending";
	/** Secret-free event lines for CLI logs. */
	logLines: readonly string[];
}>;

export type RollbackResult = Readonly<{
	disposition: FailureDisposition;
	/** Progressive exposure after rollback (must be zeroed). */
	progressive: Readonly<{
		flagPercent: number;
		gatewayWeightPercent: number;
		flagKillSwitch: boolean;
		status: "rolled_back";
	}>;
}>;

export type ContinuousDeliveryPlane = Readonly<{
	schemaVersion: typeof CD_PLANE_SCHEMA;
	/**
	 * Full path: attested apply of resolved set, then progressive composition.
	 * On failure: Incident + A2H or sandboxed self-heal.
	 */
	deliver(
		set: ResolvedDeploymentSet,
		options?: {
			readonly deploymentId?: string;
			readonly healthSamples?: ProgressiveCdResult["evidence"]["samples"];
			readonly forceFailure?: FailureSignal;
			readonly selfHealAgent?: SelfHealAgentRegistration;
			readonly envelope?: SafetyEnvelope;
			readonly attemptFixInLane?: Parameters<
				typeof decideFailurePath
			>[0]["attemptFixInLane"];
			readonly analysis?: ProgressiveAnalysisPort;
		},
	): Promise<ContinuousDeliveryResult>;
	status(
		set: ResolvedDeploymentSet,
		deploymentId: string,
	): Promise<readonly SecretFreeStatus[]>;
	/**
	 * Operator rollback: zeros flag % + gateway weight + kill-switch via Harness,
	 * then opens A2H disposition.
	 */
	rollback(
		set: ResolvedDeploymentSet,
		deploymentId: string,
		reason: string,
	): Promise<RollbackResult>;
	/** Prior apply events for a deployment (CLI logs). */
	logs(deploymentId: string): readonly CdApplyEvent[];
	/** Most recent delivery result if any. */
	lastResult(): ContinuousDeliveryResult | null;
}>;

type ProgressiveCtx = Readonly<{
	deploymentId: string;
	rolloutId: string;
	flag: string;
	harness: Harness;
	store: FeatureFlagStore;
}>;

export function createContinuousDeliveryPlane(
	options: AttestedApplyWorkerOptions & {
		readonly store?: FeatureFlagStore;
		readonly analysis?: ProgressiveAnalysisPort;
	} = {},
): ContinuousDeliveryPlane {
	const worker = createAttestedApplyWorker(options);
	const store = options.store ?? new FeatureFlagStore({ sampleRate: 0 });
	const harness = createHarness({ store });
	let last: ContinuousDeliveryResult | null = null;
	let progressiveCtx: ProgressiveCtx | null = null;

	const toLogLines = (
		apply: AttestedApplyResult,
		progressive?: ProgressiveCdResult,
		failure?: FailureDisposition,
	): readonly string[] => {
		const lines: string[] = [];
		for (const e of apply.events) {
			lines.push(`${e.time} ${e.type} ${JSON.stringify(e.data)}`.slice(0, 500));
		}
		if (progressive) {
			lines.push(
				`progressive status=${progressive.status} percent=${progressive.percent} gateway=${progressive.gatewayWeightPercent} flagPercent=${progressive.flagPercent} killSwitch=${progressive.flagKillSwitch} held=${progressive.held}`,
			);
		}
		if (failure) {
			lines.push(`failure kind=${failure.kind} incident=${failure.incidentId}`);
		}
		return Object.freeze(lines);
	};

	const planeStatus = (
		progressive?: ProgressiveCdResult,
	): ContinuousDeliveryResult["status"] => {
		if (!progressive) return "failed";
		if (progressive.held) return "holding";
		if (progressive.promoted) return "deployed";
		if (progressive.rolledBack) return "rolled-back";
		return "failed";
	};

	return Object.freeze({
		schemaVersion: CD_PLANE_SCHEMA,
		async deliver(set, opts = {}) {
			const apply = await worker.apply(set, {
				...(opts.deploymentId !== undefined
					? { deploymentId: opts.deploymentId }
					: undefined),
			});

			if (apply.status === "failed" || opts.forceFailure === "apply-failed") {
				const failure = decideFailurePath({
					signal: "apply-failed",
					tenant: set.tenant,
					environment: set.environment,
					deploymentId: apply.deploymentId,
					setId: set.setId,
					context: {
						reason: apply.reason ?? "apply-failed",
						secretFree: true,
						principal: apply.principal.svidSubject,
					},
					envelope: opts.envelope ?? createDefaultSafetyEnvelope(),
					...(opts.selfHealAgent !== undefined
						? { selfHealAgent: opts.selfHealAgent }
						: undefined),
					...(opts.attemptFixInLane !== undefined
						? { attemptFixInLane: opts.attemptFixInLane }
						: undefined),
				});
				const result: ContinuousDeliveryResult = Object.freeze({
					schemaVersion: CD_PLANE_SCHEMA,
					apply,
					failure,
					status:
						failure.kind === "a2h"
							? ("a2h" as const)
							: ("self-heal-pending" as const),
					logLines: toLogLines(apply, undefined, failure),
				});
				last = result;
				return result;
			}

			const progressive = await runProgressiveComposition({
				set,
				deploymentId: apply.deploymentId,
				store,
				harness,
				...(opts.healthSamples !== undefined
					? { healthSamples: opts.healthSamples }
					: undefined),
				analysis: opts.analysis ?? options.analysis,
			});

			progressiveCtx = Object.freeze({
				deploymentId: apply.deploymentId,
				rolloutId: progressive.rolloutId,
				flag: progressive.flag,
				harness,
				store,
			});

			if (
				progressive.rolledBack ||
				opts.forceFailure === "progressive-rollback" ||
				opts.forceFailure === "slo-burn" ||
				opts.forceFailure === "golden-failed"
			) {
				const signal: FailureSignal =
					opts.forceFailure ??
					(progressive.rolledBack ? "progressive-rollback" : "slo-burn");
				// If forceFailure after a promote, force harness rollback now.
				let progressiveFinal = progressive;
				if (!progressive.rolledBack) {
					harness.delivery.rollback(progressive.rolloutId, {
						reason: signal,
						manual: false,
					});
					const flagDef = store.get(progressive.flag);
					progressiveFinal = Object.freeze({
						...progressive,
						status: "rolled_back" as const,
						percent: 0,
						gatewayWeightPercent: 0,
						flagPercent: flagDef?.percentage ?? 0,
						flagKillSwitch: flagDef?.killSwitch === true,
						promoted: false,
						rolledBack: true,
						held: false,
					});
				}
				const failure = decideFailurePath({
					signal,
					tenant: set.tenant,
					environment: set.environment,
					deploymentId: apply.deploymentId,
					setId: set.setId,
					context: {
						rolloutId: progressiveFinal.rolloutId,
						percent: progressiveFinal.percent,
						flagPercent: progressiveFinal.flagPercent,
						gatewayWeightPercent: progressiveFinal.gatewayWeightPercent,
						secretFree: true,
					},
					envelope: opts.envelope ?? createDefaultSafetyEnvelope(),
					...(opts.selfHealAgent !== undefined
						? { selfHealAgent: opts.selfHealAgent }
						: undefined),
					...(opts.attemptFixInLane !== undefined
						? { attemptFixInLane: opts.attemptFixInLane }
						: undefined),
				});
				const result: ContinuousDeliveryResult = Object.freeze({
					schemaVersion: CD_PLANE_SCHEMA,
					apply,
					progressive: progressiveFinal,
					failure,
					status:
						failure.kind === "a2h"
							? ("a2h" as const)
							: ("self-heal-pending" as const),
					logLines: toLogLines(apply, progressiveFinal, failure),
				});
				last = result;
				return result;
			}

			const result: ContinuousDeliveryResult = Object.freeze({
				schemaVersion: CD_PLANE_SCHEMA,
				apply,
				progressive,
				status: planeStatus(progressive),
				logLines: toLogLines(apply, progressive),
			});
			last = result;
			return result;
		},

		async status(set, deploymentId) {
			return worker.status(set, deploymentId);
		},

		async rollback(set, deploymentId, reason) {
			// Zero progressive exposure via Harness OpenDelivery (flag + gateway + kill-switch).
			if (progressiveCtx && progressiveCtx.deploymentId === deploymentId) {
				progressiveCtx.harness.delivery.rollback(progressiveCtx.rolloutId, {
					reason,
					manual: true,
				});
			} else if (last?.progressive?.flag) {
				// Fallback: kill-switch + zero percent when rollout id lost.
				store.activateKillSwitch(last.progressive.flag, "cd-plane-rollback");
				store.define({
					key: last.progressive.flag,
					percentage: 0,
					killSwitch: true,
					enabled: true,
					state: "ENABLED",
				});
			}

			const flagKey =
				progressiveCtx?.flag ??
				last?.progressive?.flag ??
				`deploy.${set.setId}`;
			const flagDef = store.get(flagKey);
			const rollout =
				progressiveCtx !== null
					? harness.delivery.get(progressiveCtx.rolloutId)
					: undefined;

			const progressiveSnap = Object.freeze({
				flagPercent: flagDef?.percentage ?? 0,
				gatewayWeightPercent: rollout?.gatewayWeightPercent ?? 0,
				flagKillSwitch: flagDef?.killSwitch === true,
				status: "rolled_back" as const,
			});

			const disposition = decideFailurePath({
				signal: "progressive-rollback",
				tenant: set.tenant,
				environment: set.environment,
				deploymentId,
				setId: set.setId,
				context: {
					reason,
					secretFree: true,
					manual: true,
					flagPercent: progressiveSnap.flagPercent,
					gatewayWeightPercent: progressiveSnap.gatewayWeightPercent,
					flagKillSwitch: progressiveSnap.flagKillSwitch,
				},
				envelope: createDefaultSafetyEnvelope({ reversible: true }),
			});

			// Reflect zeros on last result for observers.
			if (last && last.apply.deploymentId === deploymentId) {
				last = Object.freeze({
					...last,
					status: "a2h" as const,
					failure: disposition,
					progressive: last.progressive
						? Object.freeze({
								...last.progressive,
								status: "rolled_back" as const,
								percent: 0,
								gatewayWeightPercent: progressiveSnap.gatewayWeightPercent,
								flagPercent: progressiveSnap.flagPercent,
								flagKillSwitch: progressiveSnap.flagKillSwitch,
								promoted: false,
								rolledBack: true,
								held: false,
							})
						: undefined,
				});
			}

			return Object.freeze({
				disposition,
				progressive: progressiveSnap,
			});
		},

		logs(deploymentId) {
			return worker.eventsFor(deploymentId);
		},

		lastResult() {
			return last;
		},
	});
}
