import type { RunnerRelayInput } from "../_generated/runner_route_pb.js";
import {
	RUNNER_STEP_KEYS,
	type RunnerStepKey,
	runnerLabelForSize,
	runnerStepKey,
} from "./providers.js";

// public-contract: the relay input value that means "the order's size".
export const RUNNER_INPUT_AUTO = "auto";

// public-contract: the label `machine: auto` stands for.
export const ANY_MACHINE_LABEL = "self-hosted";
// public-contract: the label `fleet: auto` stands for.
export const FLEET_LABEL = "hobo";

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
	runId: number,
): readonly string[] {
	if (key === "machine") return [ANY_MACHINE_LABEL];
	if (key === "fleet") return [FLEET_LABEL];
	const label = runnerLabelForSize(key, vcpus, runId);

	return label ? [label] : [RUNNER_INPUT_AUTO];
}

export function resolveAutoInputs(
	inputs: RelayInputs,
	vcpus: number,
	runId: number,
): RelayInputs {
	const resolved = new Map<RunnerStepKey, readonly string[]>();
	if (inputs.size === 0) {
		for (const key of RUNNER_STEP_KEYS)
			resolved.set(key, autoLabels(key, vcpus, runId));
		return resolved;
	}
	for (const [key, labels] of inputs)
		resolved.set(key, isAuto(labels) ? autoLabels(key, vcpus, runId) : labels);
	return resolved;
}

export function isUnresolvedAuto(labels: readonly string[]): boolean {
	return isAuto(labels);
}
