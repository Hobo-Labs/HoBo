import type { RunnerRelayInput } from "../_generated/runner_route_pb.js";
import {
	type RunnerStepKey,
	runnerLabelForSize,
	runnerStepKey,
} from "./providers.js";

export const RUNNER_INPUT_AUTO = "auto";

export const ANY_MACHINE_LABEL = "self-hosted";
export const HOBO_FLEET_LABEL = "hobo";

export type RelayInputs = ReadonlyMap<RunnerStepKey, readonly string[]>;

export function relayInputLabels(text: string): readonly string[] {
	return text
		.split(",")
		.map((label) => label.trim())
		.filter((label) => label.length > 0);
}

export function relayInputs(inputs: readonly RunnerRelayInput[]): RelayInputs {
	const byKey = new Map<RunnerStepKey, readonly string[]>();
	for (const input of inputs) {
		const key = runnerStepKey(input.key);
		const labels = input.labels.flatMap(relayInputLabels);
		if (!key || labels.length === 0 || byKey.has(key)) continue;
		byKey.set(key, labels);
	}
	return byKey;
}

function isAuto(labels: readonly string[]): boolean {
	return labels.length === 1 && labels[0]?.toLowerCase() === RUNNER_INPUT_AUTO;
}

function autoLabels(
	key: RunnerStepKey,
	vcpus: number,
	runId: number | bigint,
): readonly string[] | undefined {
	if (key === "machine") return [ANY_MACHINE_LABEL];
	if (key === "fleet") return [HOBO_FLEET_LABEL];
	const label = runnerLabelForSize(key, vcpus, runId);
	return label ? [label] : undefined;
}

export function resolveAutoInputs(
	inputs: RelayInputs,
	vcpus: number,
	runId: number | bigint,
): RelayInputs {
	const resolved = new Map<RunnerStepKey, readonly string[]>();
	for (const [key, labels] of inputs) {
		const resolvedLabels = isAuto(labels)
			? autoLabels(key, vcpus, runId)
			: labels;
		if (resolvedLabels) resolved.set(key, resolvedLabels);
	}
	return resolved;
}

export function isUnresolvedAuto(labels: readonly string[]): boolean {
	return isAuto(labels);
}
