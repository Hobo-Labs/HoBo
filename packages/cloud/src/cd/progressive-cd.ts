/**
 * Progressive composition under OpenDelivery / Harness after attested apply.
 * Flag ramp ± gateway traffic ± sustained-evidence analysis ± auto-rollback.
 */
import {
	createHarness,
	type DeliveryHealthSignal,
	FeatureFlagStore,
	type Harness,
	type ProgressiveRun,
} from "@hobo/identity";

import {
	createBuiltinProgressiveAnalysis,
	type ProgressiveAnalysisPort,
	type ProgressiveAnalysisResult,
} from "./analysis-adapter.js";
import type { ResolvedDeploymentSet } from "./resolved-set.js";

// public-contract: progressive CD composition schema.
export const PROGRESSIVE_CD_SCHEMA = "hobo.progressive-cd/v1" as const;

export type SustainedEvidenceWindow = Readonly<{
	/** Default 15 minutes (ADR-0104 calibration). */
	windowMinutes: number;
	/** Two consecutive usable samples required. */
	requiredSamples: number;
	samples: readonly DeliveryHealthSignal[];
}>;

export type ProgressiveCdResult = Readonly<{
	schemaVersion: typeof PROGRESSIVE_CD_SCHEMA;
	deploymentId: string;
	flag: string;
	rolloutId: string;
	status: ProgressiveRun["status"];
	percent: number;
	gatewayWeightPercent: number;
	/** Flag percentage after composition (0 when rolled back / kill-switch). */
	flagPercent: number;
	flagKillSwitch: boolean;
	obligations: readonly string[];
	evidence: SustainedEvidenceWindow;
	analysis: ProgressiveAnalysisResult;
	promoted: boolean;
	rolledBack: boolean;
	/** True when analysis verdict is hold (awaiting sustained evidence). */
	held: boolean;
}>;

/**
 * Run progressive stages after a successful apply.
 * Sustained evidence: two consecutive healthy samples promote;
 * any SLO/Golden/guardrail failure triggers auto-rollback obligation.
 */
export async function runProgressiveComposition(input: {
	readonly set: ResolvedDeploymentSet;
	readonly deploymentId: string;
	readonly store?: FeatureFlagStore;
	readonly harness?: Harness;
	readonly healthSamples?: readonly DeliveryHealthSignal[];
	readonly analysis?: ProgressiveAnalysisPort;
}): Promise<ProgressiveCdResult> {
	const flag = input.set.progressive?.flag ?? `deploy.${input.set.setId}`;
	const stages = input.set.progressive?.stages ?? ([5, 25, 100] as const);
	const traffic = input.set.progressive?.traffic ?? "gateway-weighted";
	const autoRollback = input.set.progressive?.autoRollback !== false;

	const store = input.store ?? new FeatureFlagStore({ sampleRate: 0 });
	if (!store.get(flag)) {
		store.define({
			key: flag,
			percentage: 0,
			state: "ENABLED",
			defaultValue: false,
			variants: { control: false, treatment: true },
			defaultVariant: "control",
			metadata: {
				tenant: input.set.tenant,
				deploymentId: input.deploymentId,
			},
		});
	}

	const harness = input.harness ?? createHarness({ store });

	const analysisPort = input.analysis ?? createBuiltinProgressiveAnalysis();

	const run = harness.startProgressive({
		rollout: {
			name: `cd-${input.deploymentId}`,
			flag,
			stages: stages.map((percent) => ({ percent })),
			traffic,
			autoRollback,
		},
	});

	const samples = [...(input.healthSamples ?? [{}, {}])];
	const evidence: SustainedEvidenceWindow = Object.freeze({
		windowMinutes: 15,
		requiredSamples: 2,
		samples: Object.freeze(samples),
	});

	const analysis = await analysisPort.analyze({
		samples,
		stagePercent: run.percent,
	});

	let current: ProgressiveRun = run;

	if (analysis.verdict === "rollback") {
		// Drive auto-rollback with the unhealthy signal (or synthetic SLO burn).
		const unhealthy =
			samples.find(
				(s) =>
					s.sloBurning === true ||
					s.goldenFailed === true ||
					s.guardrailRegressed === true,
			) ?? ({ sloBurning: true } as const);
		current = harness.advance(run.rolloutId, unhealthy);
	} else if (analysis.verdict === "hold") {
		// Sustained evidence not yet satisfied — do not advance or promote.
		// Leave rollout at the stage-0 percent (running), promoted=false.
		current = run;
	} else {
		// verdict === "promote": advance through stages while evidence is healthy.
		for (const sample of samples) {
			const unhealthy =
				sample.sloBurning === true ||
				sample.goldenFailed === true ||
				sample.guardrailRegressed === true;
			if (unhealthy) {
				current = harness.advance(run.rolloutId, sample);
				break;
			}
			current = harness.advance(run.rolloutId, sample);
			if (current.status !== "running") break;
		}
		// If still running after healthy samples, promote remaining stages.
		while (current.status === "running") {
			current = harness.advance(run.rolloutId, {});
		}
	}

	const flagDef = store.get(flag);
	const held = analysis.verdict === "hold" && current.status === "running";
	return Object.freeze({
		schemaVersion: PROGRESSIVE_CD_SCHEMA,
		deploymentId: input.deploymentId,
		flag,
		rolloutId: run.rolloutId,
		status: current.status,
		percent: current.percent,
		gatewayWeightPercent: current.gatewayWeightPercent,
		flagPercent: flagDef?.percentage ?? 0,
		flagKillSwitch: flagDef?.killSwitch === true,
		obligations: current.obligations,
		evidence,
		analysis,
		// Hold must never report promoted, even if stage percent is non-zero.
		promoted: !held && current.status === "promoted",
		rolledBack: current.status === "rolled_back",
		held,
	});
}
