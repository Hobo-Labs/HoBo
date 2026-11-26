export type ProviderOutcome = Readonly<{
	atMs: number;
	started: boolean;
}>;

export type ProviderHealth = Readonly<{
	outcomes: readonly ProviderOutcome[];
	trippedAtMs: number | undefined;
	backoffMs: number;
	nextTrialAtMs: number | undefined;
	trialStartedAtMs: number | undefined;
}>;

export type ProviderHealthOptions = Readonly<{
	tripAfter: number;
	windowMs: number;
	missedAfterMs: number;
	firstBackoffMs: number;
	maxBackoffMs: number;
	trialTimeoutMs: number;
}>;

export const PROVIDER_HEALTH_DEFAULTS: ProviderHealthOptions = {
	tripAfter: 3,
	windowMs: 30 * 60_000,
	missedAfterMs: 10 * 60_000,
	firstBackoffMs: 10 * 60_000,
	maxBackoffMs: 60 * 60_000,
	trialTimeoutMs: 30 * 60_000,
};

export type ProviderHealthState = "healthy" | "unhealthy" | "trial";

export function newProviderHealth(): ProviderHealth {
	return {
		outcomes: [],
		trippedAtMs: undefined,
		backoffMs: 0,
		nextTrialAtMs: undefined,
		trialStartedAtMs: undefined,
	};
}

export function providerHealthKey(provider: string, label: string): string {
	return `${provider}:${label.trim().toLowerCase()}`;
}

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

export function startProviderTrial(
	health: ProviderHealth,
	nowMs: number,
): ProviderHealth {
	return { ...health, trialStartedAtMs: nowMs };
}

export function isProviderMiss(
	queuedAtMs: number,
	nowMs: number,
	options: ProviderHealthOptions = PROVIDER_HEALTH_DEFAULTS,
): boolean {
	return nowMs - queuedAtMs >= options.missedAfterMs;
}
