/**
 * Correlation helpers: continuous identity, Station/Yard/Camp, Trails, Harness,
 * and control-plane event IDs — without free-text PII.
 */
import {
	type IsolationClass,
	parseSessionCorrelation,
	type SessionCorrelation,
} from "./types.js";

export type CorrelationInput = Readonly<{
	stationId: string;
	tenant?: string;
	env?: string;
	isolationClass?: IsolationClass;
	principalRef?: string;
	yardId?: string;
	campId?: string;
	trailId?: string;
	controlPlaneEventId?: string;
	errorId?: string;
	harnessFlagKeys?: readonly string[];
}>;

export function buildCorrelation(input: CorrelationInput): SessionCorrelation {
	return parseSessionCorrelation({
		stationId: input.stationId,
		tenant: input.tenant ?? "local",
		env: input.env ?? "local-dev",
		isolationClass: input.isolationClass ?? "local-dev",
		principalRef: input.principalRef,
		yardId: input.yardId,
		campId: input.campId,
		trailId: input.trailId,
		controlPlaneEventId: input.controlPlaneEventId,
		errorId: input.errorId,
		harnessFlagKeys: input.harnessFlagKeys ?? [],
	});
}

/**
 * Attach OpenFeature / Harness flag exposures observed during the session.
 */
export function withHarnessExposures(
	correlation: SessionCorrelation,
	flagKeys: readonly string[],
): SessionCorrelation {
	const merged = new Set([...correlation.harnessFlagKeys, ...flagKeys]);
	return Object.freeze({
		...correlation,
		harnessFlagKeys: Object.freeze([...merged]),
	});
}

/**
 * Link a control-plane incident / error so agents can jump session ↔ event log.
 */
export function withErrorLink(
	correlation: SessionCorrelation,
	errorId: string,
	controlPlaneEventId?: string,
): SessionCorrelation {
	return Object.freeze({
		...correlation,
		errorId,
		...(controlPlaneEventId !== undefined
			? { controlPlaneEventId }
			: correlation.controlPlaneEventId
				? { controlPlaneEventId: correlation.controlPlaneEventId }
				: {}),
	});
}

/**
 * Link a Trail cutover / migration run for investigation context.
 */
export function withTrail(
	correlation: SessionCorrelation,
	trailId: string,
): SessionCorrelation {
	return Object.freeze({ ...correlation, trailId });
}
