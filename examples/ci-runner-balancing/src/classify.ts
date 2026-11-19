
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
	conclusion: string;
	labels: readonly string[];
	texts: readonly string[];
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

export function providerForLabels(
	registry: ParsedRegistry,
	labels: readonly string[],
): string | undefined {
	for (const provider of registry.providers) {
		if (provider.runsOnLabels.some((label) => labels.includes(label))) {
			return provider.id;
		}
	}
	for (const track of registry.tracks) {
		for (const rung of track.rungs) {
			if (labels.includes(rung.value)) return rung.providerId;
		}
	}
	return undefined;
}

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
