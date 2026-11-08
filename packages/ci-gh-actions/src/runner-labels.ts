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

export type RunnerLabel = typeof RUNNER_LABEL | typeof TRUNK_RUNNER_LABEL;

/**
 * The runner label a job asked for, if HoBo serves it; exactly one label, never more.
 * Overflow machine labels (`ubuntu-24.04`, `hobo-arc`) stay unserved.
 */
export function servedRunnerLabel(
	labels: readonly string[],
): RunnerLabel | undefined {
	if (labels.length !== 1) return undefined;
	const label = labels[0]?.toLowerCase();
	return label === RUNNER_LABEL || label === TRUNK_RUNNER_LABEL
		? label
		: undefined;
}
