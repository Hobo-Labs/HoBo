/**
 * Runner-infrastructure failure classifier. A failed job whose annotations
 * say "spending limit", "minutes quota", or "no runners available" — or
 * that failed before any step started (how GitHub surfaces a spending-limit
 * refusal) — is evidence the *provider* is blocked, not the build. The
 * classifier turns that evidence into HardBlockSignal records that saturate
 * the provider in the credit ledger regardless of reported numbers.
 * Patterns are ported from QuickDeployAI's deployment-watcher failover
 * classifier and monorepo ci-routing-control-plane hard-block regexes.
 */

import { create } from "@bufbuild/protobuf";

import {
	type HardBlockSignal,
	HardBlockSignalSchema,
} from "./_generated/runner_balancing_pb.js";
import type { ParsedRegistry } from "./parse.js";

const RUNNER_INFRASTRUCTURE_PATTERNS: readonly RegExp[] = [
	/\bjob was not started\b/i,
	/\brecent account payments\b/i,
	/\bspending limit\b/i,
	/\bpayment method\b/i,
	/\bbuild minutes?\b/i,
	/\bminutes? (?:quota|limit|budget)\b/i,
	/\bno runners? (?:matching|matched|available)\b/i,
	/\bdoes not have access to this runner\b/i,
	/\bwaiting for a runner\b/i,
	/\brunner (?:group|scale set) .* (?:unavailable|not found)\b/i,
];

export interface FailedJobEvidence {
	/** Job conclusion as reported by the Actions API. */
	conclusion: string;
	/** runs-on labels the failed job requested. */
	labels: readonly string[];
	/** Annotation titles/messages and any other failure text. */
	texts: readonly string[];
	/** Steps that actually started; 0 on a failure means the runner never picked up. */
	startedStepCount: number;
}

export function isRunnerInfrastructureFailure(
	evidence: FailedJobEvidence,
): boolean {
	if (evidence.conclusion.toLowerCase() !== "failure") return false;
	if (evidence.startedStepCount === 0) return true;
	return evidence.texts.some((text) =>
		RUNNER_INFRASTRUCTURE_PATTERNS.some((pattern) => pattern.test(text)),
	);
}

/** Map a failed job's labels back to the provider that served them. */
export function providerForLabels(
	registry: ParsedRegistry,
	labels: readonly string[],
): string | undefined {
	for (const provider of registry.providers) {
		if (provider.runsOnLabels.some((label) => labels.includes(label))) {
			return provider.id;
		}
	}
	// Track rung values can be richer than the provider's canonical labels
	// (e.g. compound labels); fall back to rung-value matching.
	for (const track of registry.tracks) {
		for (const rung of track.rungs) {
			if (labels.includes(rung.value)) return rung.providerId;
		}
	}
	return undefined;
}

/**
 * Classify a batch of failed jobs into provider-wide hard blocks (resource
 * left empty: a spending/availability block on a provider affects every
 * track routed to it).
 */
export function classifyFailedJobs(
	registry: ParsedRegistry,
	jobs: readonly FailedJobEvidence[],
): HardBlockSignal[] {
	const signals = new Map<string, HardBlockSignal>();
	for (const job of jobs) {
		if (!isRunnerInfrastructureFailure(job)) continue;
		const providerId = providerForLabels(registry, job.labels);
		if (providerId === undefined || signals.has(providerId)) continue;
		const matched = job.texts.find((text) =>
			RUNNER_INFRASTRUCTURE_PATTERNS.some((pattern) => pattern.test(text)),
		);
		signals.set(
			providerId,
			create(HardBlockSignalSchema, {
				providerId,
				resource: "",
				reason:
					matched ??
					"job failed before any step started (runner never picked up)",
			}),
		);
	}
	return [...signals.values()];
}
