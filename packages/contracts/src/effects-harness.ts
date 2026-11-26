/**
 * Effect-aware contract harness extensions (ADR-0136).
 * Pure contracts isolate without infrastructure; domain effects drive mocks;
 * ResilienceProfile guides fault-injection vectors.
 */

import { type BoundaryContract, effectiveEffects } from "./contract-ir.js";
import {
	createEffectTracer,
	createInMemoryEffectSink,
	type DomainEffect,
	type EffectSpec,
	isPure,
} from "./effects.js";
import type { JsonValue } from "./json.js";
import {
	applyResilienceProfile,
	type ResilienceFact,
	type ResilienceProfile,
} from "./resilience.js";

export interface DomainMock {
	readonly domain: DomainEffect;
	readonly kind: string;
	readonly handle: (request: JsonValue) => JsonValue;
}

export interface EffectIsolationReport {
	readonly contractId: string;
	readonly pure: boolean;
	readonly purity: string;
	readonly domains: readonly string[];
	readonly capabilities: readonly string[];
	readonly mocks: readonly DomainMock[];
	readonly isolationMode: "zero-infra" | "domain-mocked" | "conservative";
}

/**
 * Build an isolation report and automatic mocks from declared effects.
 */
export function createEffectIsolation(
	contract: BoundaryContract,
): EffectIsolationReport {
	const effects = effectiveEffects(contract);
	const pure = isPure(effects);
	const mocks = pure ? [] : mocksForEffects(effects);
	return {
		contractId: contract.id,
		pure,
		purity: effects.purity,
		domains: effects.domains,
		capabilities: effects.capabilities,
		mocks,
		isolationMode: pure
			? "zero-infra"
			: mocks.length > 0
				? "domain-mocked"
				: "conservative",
	};
}

export function mocksForEffects(effects: EffectSpec): DomainMock[] {
	return effects.domains.map((domain) => mockForDomain(domain));
}

function mockForDomain(domain: DomainEffect): DomainMock {
	switch (domain) {
		case "network":
		case "externalCall":
			return {
				domain,
				kind: "http-stub",
				handle: () => ({ status: 200, body: { mocked: true, domain } }),
			};
		case "storage":
			return {
				domain,
				kind: "storage-dual",
				handle: (req) => ({ stored: true, dual: req, domain }),
			};
		case "identity":
			return {
				domain,
				kind: "identity-stub",
				handle: () => ({ principal: { kind: "system", id: "mock" } }),
			};
		case "policyEval":
			return {
				domain,
				kind: "policy-stub",
				handle: () => ({ effect: "allow", reason: "mock-allow" }),
			};
		case "eventEmit":
			return {
				domain,
				kind: "event-sink",
				handle: (evt) => ({ appended: true, event: evt }),
			};
		case "clock":
			return {
				domain,
				kind: "manual-clock",
				handle: () => "2026-07-27T00:00:00.000Z",
			};
		case "agentTool":
			return {
				domain,
				kind: "agent-tool-stub",
				handle: () => ({ toolResult: "mocked" }),
			};
		default:
			return {
				domain,
				kind: "generic-stub",
				handle: () => ({ mocked: true, domain }),
			};
	}
}

/**
 * Filter contracts to those that are pure (zero-infra unit test candidates).
 */
export function filterPureContracts(
	contracts: readonly BoundaryContract[],
): BoundaryContract[] {
	return contracts.filter((c) => isPure(effectiveEffects(c)));
}

/**
 * Fault-injection vectors guided by ResilienceProfile + declared effects.
 */
export async function runResilienceFaultInjection(input: {
	contract: BoundaryContract;
	profile?: ResilienceProfile;
	/** Injected failure sequence by attempt number (1-based). */
	failures?: Array<{
		attempt: number;
		failureClass: "transient" | "policy.Decided" | "terminal" | "cancellation";
		message?: string;
	}>;
}): Promise<{
	ok: boolean;
	facts: readonly ResilienceFact[];
	attempts: number;
	neverRetriedPolicyOrTerminal: boolean;
}> {
	const profile = input.profile ??
		input.contract.resilience ?? {
			schemaVersion: "hobo.resilience-profile/v1" as const,
			id: "harness-default",
			strategies: [
				{
					kind: "retry" as const,
					seed: "harness-seed",
					maxAttempts: 3,
					baseDelayMs: 1,
					maxDelayMs: 10,
					retryOn: "transient-only" as const,
				},
			],
			neverRetry: ["policy.Decided", "terminal", "cancellation"] as const,
		};

	const failureMap = new Map((input.failures ?? []).map((f) => [f.attempt, f]));

	const result = await applyResilienceProfile({
		// SAFETY: assertion required at this I/O or test boundary.
		profile: profile as ResilienceProfile,
		now: () => "2026-07-27T00:00:00.000Z",
		op: (attempt) => {
			const f = failureMap.get(attempt);
			if (f) {
				throw {
					failureClass: f.failureClass,
					message: f.message ?? f.failureClass,
				};
			}
			return { ok: true, attempt };
		},
	});

	const neverRetriedPolicyOrTerminal = result.facts.every((fact) => {
		if (fact.type !== "resilience.Attempt") return true;
		if (
			fact.failureClass === "policy.Decided" ||
			fact.failureClass === "terminal" ||
			fact.failureClass === "cancellation"
		) {
			return fact.retried === false;
		}
		return true;
	});

	return {
		ok: result.ok,
		facts: result.facts,
		attempts: result.attempts,
		neverRetriedPolicyOrTerminal,
	};
}

/**
 * Dual fixtures keyed on effects: pure vs domain-effect paths.
 */
export interface DualEffectFixtures {
	readonly purePath: { readonly mode: "pure"; readonly infrastructure: "none" };
	readonly effectPath: {
		readonly mode: "effects";
		readonly mocks: DomainMock[];
	};
}

export function dualFixturesForEffects(
	effects: EffectSpec,
): DualEffectFixtures {
	return {
		purePath: { mode: "pure", infrastructure: "none" },
		effectPath: {
			mode: "effects",
			mocks: mocksForEffects(effects),
		},
	};
}

/**
 * Capture declare+invoke without re-executing on inspection.
 */
export function captureContractEffects(contract: BoundaryContract) {
	const sink = createInMemoryEffectSink();
	const tracer = createEffectTracer(sink);
	const effects = effectiveEffects(contract);
	tracer.declare({
		contractId: contract.id,
		channel: contract.edge.channel,
		effects,
		at: "2026-07-27T00:00:00.000Z",
	});
	tracer.invoked({
		contractId: contract.id,
		channel: contract.edge.channel,
		effects,
		at: "2026-07-27T00:00:01.000Z",
	});
	return {
		facts: sink.facts(),
		/** Replay inspection: return recorded facts only — no re-invoke. */
		inspect() {
			return sink.facts();
		},
	};
}
