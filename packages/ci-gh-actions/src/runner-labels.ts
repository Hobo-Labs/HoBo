/** The label every HoBo job asks for unless it gates trunk. */
// public-contract: the `runs-on` label workflows ask for and JIT runners register with.
export const RUNNER_LABEL = "hobo";

/**
 * Asked for by jobs of push, workflow_dispatch and merge_group runs. GitHub
 * hands a fresh runner to any queued job its labels match, oldest first, so a
 * runner launched for a trunk job under the shared label is taken by an older
 * pull-request job. A label of their own is the only way to send it to them.
 */
// public-contract: the `runs-on` label hobo-ci.yml's trunk jobs ask for (scripts/lint-actions.ts).
export const TRUNK_RUNNER_LABEL = "hobo-trunk";

/**
 * Optional box fleet identity some workflows use alongside the shared `hobo` mesh
 * label. JIT registration must include every fleet label the job asks for.
 */
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

/**
 * The runner label a job asked for, if HoBo serves it; exactly one label, never more.
 * Overflow machine labels (`ubuntu-24.04`, `hobo-arc`) stay unserved.
 */
export function servedRunnerLabel(
	labels: readonly string[],
): RunnerLabel | undefined {
	if (labels.length !== 1) return undefined;
	const label = labels[0]?.toLowerCase();
	if (!label) return undefined;
	return parseFleetRunnerLabel(label);
}

/** Labels registered on a JIT runner so GitHub can match the shared fleet mesh. */
export function jitRunnerRegistrationLabels(
	jobLabels: readonly string[] | undefined,
	primary: RunnerLabel,
): readonly RunnerLabel[] {
	const out = new Set<RunnerLabel>([primary]);
	for (const raw of jobLabels ?? []) {
		const parsed = parseFleetRunnerLabel(raw.toLowerCase());
		if (parsed) out.add(parsed);
	}
	// Trunk jobs must not pick up shared-label work; everyone else stays in the mesh.
	if (primary !== TRUNK_RUNNER_LABEL) out.add(RUNNER_LABEL);
	return [...out];
}
