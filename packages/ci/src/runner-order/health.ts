/**
 * Whether a hosted runner type is still starting jobs, from what happened to
 * the jobs that asked for it.
 *
 * A hosted provider brings its own runner once a job asks for its label.
 * Nothing tells HoBo when that stops working: the label is still valid, the
 * job just sits queued. So the record is kept from the outside. A job that
 * asked for the label and had no runner after `missedAfterMs` is a miss; a
 * job that got a runner is a start, whatever the job's own result was.
 *
 * Three misses in a row inside the window (earliest to latest, whatever
 * order they were reported in) trip the type, and the walk in
 * `./decide.ts` passes over it. It is not left tripped for good: after a
 * back-off one job is let through as a trial. A trial that starts clears the
 * record; a trial that is missed doubles the back-off, up to a ceiling. A
 * trial nobody reported on expires, so a lost webhook cannot hold a type out
 * forever.
 *
 * Pure functions: no clock, network or store.
 */

export type ProviderOutcome = Readonly<{
	atMs: number;
	/** A runner took the job. */
	started: boolean;
}>;

export type ProviderHealth = Readonly<{
	/** Recent outcomes, oldest first, never more than `tripAfter` of them. */
	outcomes: readonly ProviderOutcome[];
	/** When the type was tripped. Absent while it is healthy. */
	trippedAtMs: number | undefined;
	/** The back-off before the next trial. */
	backoffMs: number;
	/** The earliest a trial job may be let through. */
	nextTrialAtMs: number | undefined;
	/** When the trial in flight was let through. */
	trialStartedAtMs: number | undefined;
}>;

export type ProviderHealthOptions = Readonly<{
	/** Misses in a row that trip a type. */
	tripAfter: number;
	/** The misses must all fall inside this span. */
	windowMs: number;
	/** How long a job may wait for a runner before it counts as a miss. */
	missedAfterMs: number;
	firstBackoffMs: number;
	maxBackoffMs: number;
	/** How long a trial may go unreported before another is allowed. */
	trialTimeoutMs: number;
}>;

// public-contract: when a hosted runner type is tripped and how it is tried again.
export const PROVIDER_HEALTH_DEFAULTS: ProviderHealthOptions = {
	tripAfter: 3,
	windowMs: 30 * 60_000,
	missedAfterMs: 10 * 60_000,
	firstBackoffMs: 10 * 60_000,
	maxBackoffMs: 60 * 60_000,
	trialTimeoutMs: 30 * 60_000,
};

export type ProviderHealthState =
	/** Take jobs as usual. */
	| "healthy"
	/** Pass over it. */
	| "unhealthy"
	/** Tripped, and due one job to find out whether it has recovered. */
	| "trial";

export function newProviderHealth(): ProviderHealth {
	return {
		outcomes: [],
		trippedAtMs: undefined,
		backoffMs: 0,
		nextTrialAtMs: undefined,
		trialStartedAtMs: undefined,
	};
}

/** The key one runner type's record is kept under: provider and label, lower case. */
export function providerHealthKey(provider: string, label: string): string {
	return `${provider}:${label.trim().toLowerCase()}`;
}

/**
 * The newest miss when the last `tripAfter` outcomes are all misses inside
 * the window, else `undefined`. The window runs from the earliest to the
 * latest of them, not the first to the last reported, so misses reported out
 * of order cannot squeeze a wide spread into a negative span.
 */
function tripped(
	outcomes: readonly ProviderOutcome[],
	options: ProviderHealthOptions,
): number | undefined {
	if (outcomes.length < options.tripAfter) return undefined;
	const recent = outcomes.slice(-options.tripAfter);
	if (recent.some((outcome) => outcome.started)) return undefined;
	const times = recent.map((outcome) => outcome.atMs);
	const latest = Math.max(...times);
	return latest - Math.min(...times) <= options.windowMs ? latest : undefined;
}

/**
 * The record after one more job's outcome. A start clears everything. A miss
 * while healthy is counted and may trip the type; a miss while tripped means
 * the trial failed, so the back-off doubles.
 */
export function recordProviderOutcome(
	health: ProviderHealth,
	outcome: ProviderOutcome,
	options: ProviderHealthOptions = PROVIDER_HEALTH_DEFAULTS,
): ProviderHealth {
	if (outcome.started) return newProviderHealth();
	const outcomes = [...health.outcomes, outcome].slice(-options.tripAfter);
	if (health.trippedAtMs !== undefined) {
		const backoffMs = Math.min(
			Math.max(health.backoffMs, options.firstBackoffMs) * 2,
			options.maxBackoffMs,
		);
		return {
			outcomes,
			trippedAtMs: health.trippedAtMs,
			backoffMs,
			nextTrialAtMs: outcome.atMs + backoffMs,
			trialStartedAtMs: undefined,
		};
	}
	const trippedAtMs = tripped(outcomes, options);
	if (trippedAtMs === undefined)
		return {
			outcomes,
			trippedAtMs: undefined,
			backoffMs: 0,
			nextTrialAtMs: undefined,
			trialStartedAtMs: undefined,
		};
	return {
		outcomes,
		trippedAtMs,
		backoffMs: options.firstBackoffMs,
		nextTrialAtMs: trippedAtMs + options.firstBackoffMs,
		trialStartedAtMs: undefined,
	};
}

/** What the walk should do with this runner type at `nowMs`. */
export function providerHealthState(
	health: ProviderHealth,
	nowMs: number,
	options: ProviderHealthOptions = PROVIDER_HEALTH_DEFAULTS,
): ProviderHealthState {
	if (health.trippedAtMs === undefined) return "healthy";
	const trialOut =
		health.trialStartedAtMs !== undefined &&
		nowMs - health.trialStartedAtMs < options.trialTimeoutMs;
	if (trialOut) return "unhealthy";
	return health.nextTrialAtMs !== undefined && nowMs >= health.nextTrialAtMs
		? "trial"
		: "unhealthy";
}

/** The record once a trial job has been let through at `nowMs`. */
export function startProviderTrial(
	health: ProviderHealth,
	nowMs: number,
): ProviderHealth {
	return { ...health, trialStartedAtMs: nowMs };
}

/**
 * Whether a job that asked for a hosted label at `queuedAtMs` and still has
 * no runner at `nowMs` counts as a miss.
 */
export function isProviderMiss(
	queuedAtMs: number,
	nowMs: number,
	options: ProviderHealthOptions = PROVIDER_HEALTH_DEFAULTS,
): boolean {
	return nowMs - queuedAtMs >= options.missedAfterMs;
}
