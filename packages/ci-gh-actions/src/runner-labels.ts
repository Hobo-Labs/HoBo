// public-contract: the `runs-on` label workflows ask for and JIT runners register with.
export const RUNNER_LABEL = "hobo";

// public-contract: the `runs-on` label hobo-ci.yml's trunk jobs ask for (scripts/lint-actions.ts).
export const TRUNK_RUNNER_LABEL = "hobo-trunk";

// public-contract: optional box fleet runner label paired with the shared hobo mesh label.
export const BOX_ISOLATED_RUNNER_LABEL = "hobo-box";

export type RunnerLabel =
	| typeof RUNNER_LABEL
	| typeof TRUNK_RUNNER_LABEL
	| typeof BOX_ISOLATED_RUNNER_LABEL;

function parseFleetRunnerLabel(lowered: string): RunnerLabel | undefined {
	if (lowered === RUNNER_LABEL) return RUNNER_LABEL;
	if (lowered === TRUNK_RUNNER_LABEL) return TRUNK_RUNNER_LABEL;
	if (lowered === BOX_ISOLATED_RUNNER_LABEL) return BOX_ISOLATED_RUNNER_LABEL;
	return undefined;
}

export function servedRunnerLabel(
	labels: readonly string[],
): RunnerLabel | undefined {
	if (labels.length !== 1) return undefined;
	const label = labels[0]?.toLowerCase();
	if (!label) return undefined;
	return parseFleetRunnerLabel(label);
}

export function jitRunnerRegistrationLabels(
	jobLabels: readonly string[] | undefined,
	primary: RunnerLabel,
): readonly RunnerLabel[] {
	const out = new Set<RunnerLabel>([primary]);
	for (const raw of jobLabels ?? []) {
		const parsed = parseFleetRunnerLabel(raw.toLowerCase());
		if (parsed) out.add(parsed);
	}
	if (primary !== TRUNK_RUNNER_LABEL) out.add(RUNNER_LABEL);
	return [...out];
}
