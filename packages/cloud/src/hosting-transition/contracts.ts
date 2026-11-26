import {
	createEffectSpec,
	createEffectTracer,
	createResilienceProfile,
	type EffectCaptureFact,
	type EffectSpec,
	effectSubtype,
	pureEffects,
	type ResilienceProfile,
	validateResilienceAgainstEffects,
} from "@hobo/contracts";

const mutationEffects = createEffectSpec({
	purity: "noRollback",
	capabilities: ["allocates", "decides", "suspends"],
	domains: ["network", "externalCall", "iac", "storage", "eventEmit"],
});
const mutationResilience = createResilienceProfile({
	id: "hosting-mutation-single-attempt/v1",
	strategies: [
		{
			kind: "retry",
			seed: "hosting-mutation",
			maxAttempts: 1,
			baseDelayMs: 0,
			maxDelayMs: 0,
			retryOn: "transient-only",
		},
	],
});
const observationEffects = createEffectSpec({
	purity: "varies",
	capabilities: ["decides", "suspends"],
	domains: ["network", "externalCall", "storage"],
});
const observationResilience = createResilienceProfile({
	id: "hosting-observation-durable-retry/v1",
	strategies: [
		{
			kind: "retry",
			seed: "hosting-observation",
			maxAttempts: 1,
			baseDelayMs: 0,
			maxDelayMs: 0,
			retryOn: "transient-only",
		},
	],
});

/** Retry timing/deadlines are journaled by the coordinator; these profiles forbid hidden retries. */
export const hostingTransitionContracts = Object.freeze({
	plan: { effects: pureEffects() },
	reserve: {
		effects: createEffectSpec({
			purity: "transacts",
			capabilities: ["decides"],
			domains: ["storage", "eventEmit", "metering"],
		}),
	},
	mutate: { effects: mutationEffects, resilience: mutationResilience },
	observe: { effects: observationEffects, resilience: observationResilience },
});

export function validateHostingAdapterContract(
	effects: EffectSpec,
	resilience: ResilienceProfile,
): void {
	if (!effectSubtype(effects, mutationEffects))
		throw new Error("hosting adapter widens approved effect boundary");
	validateResilienceAgainstEffects(resilience, effects);
	for (const strategy of resilience.strategies) {
		if (strategy.kind === "hedging" || strategy.kind === "fallback")
			throw new Error("hosting mutation cannot hedge or silently fall back");
		if (strategy.kind === "retry" && strategy.maxAttempts !== 1)
			throw new Error(
				"hosting mutation requires one attempt and reconciliation",
			);
	}
}

export function hostingEffectFacts(
	contractId: string,
	channel: "mutate" | "observe",
	at: string,
) {
	const facts: EffectCaptureFact[] = [];
	const tracer = createEffectTracer({
		record: (fact) => {
			facts.push(fact);
		},
	});
	const effects = hostingTransitionContracts[channel].effects;
	tracer.declare({ contractId, channel, effects, at });
	tracer.invoked({ contractId, channel, effects, at });
	return facts;
}
