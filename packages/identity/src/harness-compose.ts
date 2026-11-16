/**
 * The Harness composition loop (ADR-0083):
 * deploy dark → ramp flag → shift traffic → watch health → promote | auto-rollback
 * → optional experiment conclude.
 *
 * Event-sourced; auto-rollback is a durable obligation shape (policy.Decided-compatible).
 */
import type {
	FeatureFlagStore,
	FlagEvalContext,
} from "./feature-flag-store.js";
import {
	applyRolloutToGatewayRouting,
	type DomainRoutingEvent,
	type TrafficWeightSplit,
} from "./gateway-weight.js";
import {
	analyzeExperimentFromEngine,
	createBuiltinDeliveryAdapter,
	createBuiltinExperimentAnalysis,
	type DeliveryAdapter,
	type ExperimentAnalysisPort,
	type ExperimentAnalysisResult,
} from "./harness-adapters.js";
import {
	type DeliveryHealthSignal,
	OpenDeliveryEngine,
	type RolloutPolicy,
	type RolloutState,
} from "./harness-delivery.js";
import {
	type ExperimentDefinition,
	OpenExperimentEngine,
} from "./harness-experiment.js";

// public-contract: harness facade schema.
export const HARNESS_SCHEMA = "hobo.harness/v1" as const;

export interface ExposureTrack {
	readonly variant: string;
}

export type HarnessPorts = Readonly<{
	flags: FeatureFlagStore;
	delivery: OpenDeliveryEngine;
	experiment: OpenExperimentEngine;
}>;

export type ProgressiveRun = Readonly<{
	rolloutId: string;
	experimentName?: string;
	status: RolloutState["status"];
	percent: number;
	gatewayWeightPercent: number;
	obligations: readonly string[];
	/** Weighted routing split for gateway/domain (ADR-0035). */
	trafficSplit?: TrafficWeightSplit;
	/** domain.RoutingChanged / RolledBack fact from composition. */
	routingEvent?: DomainRoutingEvent;
}>;

/**
 * Coherent progressive-delivery facade over the three ports.
 */
export class Harness {
	readonly schemaVersion = HARNESS_SCHEMA;
	readonly flags: FeatureFlagStore;
	readonly delivery: OpenDeliveryEngine;
	readonly experiment: OpenExperimentEngine;
	readonly deliveryAdapter: DeliveryAdapter;
	readonly analysis: ExperimentAnalysisPort;
	readonly routingEvents: DomainRoutingEvent[] = [];
	private readonly now: () => string;

	constructor(options: {
		readonly store: FeatureFlagStore;
		readonly now?: () => string;
		readonly emitOtel?: (span: {
			readonly name: string;
			readonly attributes: Readonly<Record<string, string | number | boolean>>;
		}) => void;
		readonly deliveryAdapter?: DeliveryAdapter;
		readonly analysis?: ExperimentAnalysisPort;
	}) {
		this.flags = options.store;
		this.now = options.now ?? (() => new Date().toISOString());
		this.delivery = new OpenDeliveryEngine({
			store: options.store,
			...(options.now !== undefined ? { now: options.now } : undefined),
		});
		this.experiment = new OpenExperimentEngine({
			store: options.store,
			...(options.now !== undefined ? { now: options.now } : undefined),
			...(options.emitOtel !== undefined
				? { emitOtel: options.emitOtel }
				: undefined),
		});
		this.deliveryAdapter =
			options.deliveryAdapter ?? createBuiltinDeliveryAdapter();
		this.analysis = options.analysis ?? createBuiltinExperimentAnalysis();
	}

	ports(): HarnessPorts {
		return Object.freeze({
			flags: this.flags,
			delivery: this.delivery,
			experiment: this.experiment,
		});
	}

	/**
	 * Start progressive delivery: optional experiment + staged rollout.
	 * Flag starts dark (0%) unless first stage percent > 0.
	 */
	startProgressive(input: {
		readonly rollout: RolloutPolicy;
		readonly experiment?: ExperimentDefinition;
	}): ProgressiveRun {
		// Ensure flag defined dark then stage-0
		if (!this.flags.get(input.rollout.flag)) {
			this.flags.define({
				key: input.rollout.flag,
				percentage: 0,
				enabled: true,
				state: "ENABLED",
				defaultValue: false,
			});
		}
		if (input.experiment) {
			this.experiment.define(input.experiment);
		}
		const state = this.delivery.start(input.rollout);
		void this.deliveryAdapter.startRemote(input.rollout);
		return this.toRun(state, input.experiment?.name);
	}

	/** Advance composition loop one stage with optional health signals. */
	advance(
		rolloutId: string,
		health: DeliveryHealthSignal = {},
	): ProgressiveRun {
		const state = this.delivery.step(rolloutId, health);
		void this.deliveryAdapter.mirrorStep(state);
		return this.toRun(state);
	}

	/** Assign + expose experiment for a subject (OpenFeature evaluation path). */
	trackExposure(
		experimentName: string,
		context: FlagEvalContext,
	): ExposureTrack {
		const a = this.experiment.evaluateAndExpose(experimentName, context);
		return { variant: a.variant };
	}

	/** Built-in baseline (or residual) analysis + export for an experiment. */
	analyzeExperiment(experimentName: string): ExperimentAnalysisResult | null {
		return analyzeExperimentFromEngine(
			this.experiment,
			experimentName,
			this.analysis,
		);
	}

	/** Conclude experiment with analysis-driven verdict when not supplied. */
	concludeExperiment(
		experimentName: string,
		verdict?: "ship" | "do-not-ship" | "inconclusive",
	): ExperimentAnalysisResult | null {
		const analysis = this.analyzeExperiment(experimentName);
		const v = verdict ?? analysis?.verdict ?? "inconclusive";
		this.experiment.conclude(
			experimentName,
			v,
			analysis?.exportPayload.contentHash,
		);
		return analysis;
	}

	status(rolloutId: string): ProgressiveRun | null {
		const state = this.delivery.get(rolloutId);
		if (!state) return null;
		return this.toRun(state);
	}

	private toRun(state: RolloutState, experimentName?: string): ProgressiveRun {
		const composed = applyRolloutToGatewayRouting(this.delivery, state.id, {
			now: this.now,
		});
		if (composed) {
			this.routingEvents.push(composed.event);
		}
		return Object.freeze({
			rolloutId: state.id,
			...(experimentName !== undefined ? { experimentName } : undefined),
			status: state.status,
			percent: state.percent,
			gatewayWeightPercent: state.gatewayWeightPercent,
			obligations: Object.freeze(
				state.status === "rolled_back"
					? (["auto-rollback-applied"] as const)
					: state.policy.autoRollback
						? (["auto-rollback-on-slo-or-golden"] as const)
						: [],
			),
			...(composed
				? { trafficSplit: composed.split, routingEvent: composed.event }
				: undefined),
		});
	}
}

export function createHarness(options: {
	readonly store: FeatureFlagStore;
	readonly now?: () => string;
	readonly emitOtel?: (span: {
		readonly name: string;
		readonly attributes: Readonly<Record<string, string | number | boolean>>;
	}) => void;
	readonly deliveryAdapter?: DeliveryAdapter;
	readonly analysis?: ExperimentAnalysisPort;
}): Harness {
	return new Harness(options);
}
