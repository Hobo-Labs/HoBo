import type { GithubTransport } from "./github.js";

export type GithubRunnerDeregisterOutcome = "removed" | "absent" | "refused";

/** Remove this host's JIT runner registration without touching the workflow run. */
export async function deregisterGithubRunner(
	github: GithubTransport,
	installationId: number,
	repository: string,
	runnerId: number,
): Promise<GithubRunnerDeregisterOutcome> {
	if (!Number.isInteger(runnerId) || runnerId <= 0) return "absent";
	const response = await github.request(
		installationId,
		`/repos/${repository}/actions/runners/${runnerId}`,
		"DELETE",
	);
	if (response.status === 204) return "removed";
	if (response.status === 404 || response.status === 422) return "absent";
	return "refused";
}
