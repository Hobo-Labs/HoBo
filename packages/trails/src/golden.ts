/**
 * Golden Suite oracles for Trails (dual consistency, zero-loss, fail-closed).
 */

import type { JsonObject } from "./json.js";
import type { TrailRunResult } from "./runner.js";

// public-contract: trail golden oracle schema.
export const TRAIL_GOLDEN_SCHEMA = "hobo.trail-golden/v1" as const;

export type TrailGoldenOracleId =
	| "dual-consistency"
	| "zero-loss"
	| "fail-closed"
	| "progressive-abort"
	| "compensation"
	| "history-idempotent"
	| "identity-hands-off"
	| "junction-integrity";

export type TrailGoldenVerdict = Readonly<{
	schemaVersion: typeof TRAIL_GOLDEN_SCHEMA;
	oracle: TrailGoldenOracleId;
	ok: boolean;
	summary: string;
	evidence: JsonObject;
}>;

export function goldenDualConsistency(
	result: TrailRunResult,
): TrailGoldenVerdict {
	const dataOk = result.dataResults.every((d) => d.consistent);
	const identityOk =
		!result.run.identityLinked ||
		result.identityProgress?.migrationPresent === true;
	const ok = dataOk && identityOk && result.run.dualOk;
	return Object.freeze({
		schemaVersion: TRAIL_GOLDEN_SCHEMA,
		oracle: "dual-consistency",
		ok,
		summary: ok
			? "dual consistency holds for identity and data"
			: "dual consistency failed",
		evidence: Object.freeze({
			dataOk,
			identityOk,
			dualOk: result.run.dualOk,
		}),
	});
}

export function goldenZeroLoss(result: TrailRunResult): TrailGoldenVerdict {
	const ok =
		result.dataResults.every((d) => d.zeroLoss) &&
		(result.cutover || result.dataResults.length === 0);
	return Object.freeze({
		schemaVersion: TRAIL_GOLDEN_SCHEMA,
		oracle: "zero-loss",
		ok,
		summary: ok ? "zero-loss cutover evidence ok" : "zero-loss violated",
		evidence: Object.freeze({
			dataResults: result.dataResults.map((d) => ({
				stepId: d.stepId,
				zeroLoss: d.zeroLoss,
			})),
			cutover: result.cutover,
		}),
	});
}

export function goldenFailClosed(result: TrailRunResult): TrailGoldenVerdict {
	// When dual diverged, must compensate/abort — never remain cutover.
	// Check run.state (source of truth), not just result flags that could lie.
	const diverged = result.dataResults.some((d) => !d.consistent);
	const stateSafe =
		result.run.state === "compensated" ||
		result.run.state === "aborted" ||
		result.run.state === "failed";
	const flagsSafe =
		result.compensated === true &&
		result.cutover === false &&
		result.run.dualOk === false;
	const ok = !diverged || (stateSafe && flagsSafe);
	return Object.freeze({
		schemaVersion: TRAIL_GOLDEN_SCHEMA,
		oracle: "fail-closed",
		ok,
		summary: ok
			? "fail-closed posture held"
			: "diverged dual reached or remained cutover (unsafe)",
		evidence: Object.freeze({
			diverged,
			compensated: result.compensated,
			cutover: result.cutover,
			runState: result.run.state,
			dualOk: result.run.dualOk,
		}),
	});
}

export function goldenProgressiveAbort(
	result: TrailRunResult,
): TrailGoldenVerdict {
	const ok =
		!result.aborted ||
		result.compensated ||
		result.run.state === "aborted" ||
		result.run.state === "failed";
	return Object.freeze({
		schemaVersion: TRAIL_GOLDEN_SCHEMA,
		oracle: "progressive-abort",
		ok,
		summary: ok
			? "progressive abort path recorded"
			: "abort without terminal state",
		evidence: Object.freeze({
			aborted: result.aborted,
			state: result.run.state,
			rampPercent: result.rampPercent,
		}),
	});
}

export function goldenCompensation(result: TrailRunResult): TrailGoldenVerdict {
	const ok =
		!result.compensated ||
		(result.run.state === "compensated" && result.run.percent === 0);
	return Object.freeze({
		schemaVersion: TRAIL_GOLDEN_SCHEMA,
		oracle: "compensation",
		ok,
		summary: ok
			? "compensation restored safe dual/source posture"
			: "compensation incomplete",
		evidence: Object.freeze({
			compensated: result.compensated,
			percent: result.run.percent,
			state: result.run.state,
		}),
	});
}

export function goldenHistoryIdempotent(
	result: TrailRunResult,
): TrailGoldenVerdict {
	const keys = result.history.map(
		(h) => `${h.trailId}/${h.stepId}/${h.target}/${h.tenant}`,
	);
	const unique = new Set(keys);
	const ok = keys.length === unique.size;
	return Object.freeze({
		schemaVersion: TRAIL_GOLDEN_SCHEMA,
		oracle: "history-idempotent",
		ok,
		summary: ok
			? "history rows unique per trail/step/target"
			: "duplicate history rows",
		evidence: Object.freeze({ count: keys.length, unique: unique.size }),
	});
}

export function goldenIdentityHandsOff(input: {
	readonly bindleConfigRequired: boolean;
	readonly continuousDefault: boolean;
}): TrailGoldenVerdict {
	const ok =
		input.bindleConfigRequired === false && input.continuousDefault === true;
	return Object.freeze({
		schemaVersion: TRAIL_GOLDEN_SCHEMA,
		oracle: "identity-hands-off",
		ok,
		summary: ok
			? "continuous identity requires zero Bindle config"
			: "identity continuous incorrectly requires authoring",
		evidence: Object.freeze({ ...input }),
	});
}

export function goldenJunctionIntegrity(
	result: TrailRunResult,
): TrailGoldenVerdict {
	const ok = result.run.junctionOk || result.compensated;
	return Object.freeze({
		schemaVersion: TRAIL_GOLDEN_SCHEMA,
		oracle: "junction-integrity",
		ok,
		summary: ok
			? "junction health enforced (or compensated)"
			: "junction unhealthy without compensation",
		evidence: Object.freeze({
			junctionOk: result.run.junctionOk,
			compensated: result.compensated,
		}),
	});
}

/** Run all Golden oracles against a Trail result. */
export function runTrailGoldenSuite(
	result: TrailRunResult,
	identityHandsOff?: {
		readonly bindleConfigRequired: boolean;
		readonly continuousDefault: boolean;
	},
): readonly TrailGoldenVerdict[] {
	const verdicts: TrailGoldenVerdict[] = [
		goldenDualConsistency(result),
		goldenZeroLoss(result),
		goldenFailClosed(result),
		goldenProgressiveAbort(result),
		goldenCompensation(result),
		goldenHistoryIdempotent(result),
		goldenJunctionIntegrity(result),
	];
	if (identityHandsOff) {
		verdicts.push(goldenIdentityHandsOff(identityHandsOff));
	}
	return Object.freeze(verdicts);
}
