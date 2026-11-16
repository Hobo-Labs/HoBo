/**
 * What one relay job allows: for each runner type, the labels the job behind
 * it would ask that type for.
 *
 * A relay names one input per runner type the job may use. A type it leaves
 * out is never used for that job, whatever the runner order says, so a
 * workflow cannot be moved onto capacity its author did not write down. The
 * one exception is a relay with no inputs at all, which means "any type, at
 * the order's size".
 *
 * Pure functions: no clock, network or store.
 */
import type { RunnerRelayInput } from "../_generated/runner_route_pb.js";
import {
	RUNNER_STEP_KEYS,
	type RunnerStepKey,
	runnerLabelForSize,
	runnerStepKey,
} from "./providers.js";

/** The input value that asks for the order's size instead of naming a label. */
// public-contract: the relay input value that means "the order's size".
export const RUNNER_INPUT_AUTO = "auto";

/**
 * The label a `machine` or `fleet` input gets from `auto`: any machine, and
 * the fleet's own label.
 */
// public-contract: the label `machine: auto` stands for.
export const ANY_MACHINE_LABEL = "self-hosted";
// public-contract: the label `fleet: auto` stands for.
export const FLEET_LABEL = "hobo";

/** Labels by runner type. A type with no entry was not named by the relay. */
export type RelayInputs = ReadonlyMap<RunnerStepKey, readonly string[]>;

/** One input's text as a workflow writes it: comma-separated, spaces ignored. */
export function relayInputLabels(text: string): readonly string[] {
	return text
		.split(",")
		.map((label) => label.trim())
		.filter((label) => label.length > 0);
}

/**
 * The relay's inputs from the request record. An input with an unknown key or
 * no labels is dropped; a key named twice keeps its first entry.
 */
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
	// No machine that large: the step keeps `auto` and the walk skips it as `no_size`.
	return label ? [label] : [RUNNER_INPUT_AUTO];
}

/**
 * The inputs with every `auto` replaced by the label for `vcpus`. A relay
 * that named nothing gets every runner type at that size. A provider with no
 * machine that large keeps the literal `auto`, which the walk reports as
 * `no_size` instead of guessing a label.
 */
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

/** True while an input still holds the literal `auto`: no size could be chosen. */
export function isUnresolvedAuto(labels: readonly string[]): boolean {
	return isAuto(labels);
}
