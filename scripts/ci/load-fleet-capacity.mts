import { z } from "zod";
import {
	DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP,
	FLEET_CAPACITY_VARIABLE,
	type FleetCapacityPublished,
	mainWorkspaceParallelCap,
	parseFleetCapacityPublished,
} from "../../packages/ci/src/fleet/capacity-input.ts";

export type LoadFleetCapacityOptions = Readonly<{
	repository?: string;
	token?: string;
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	variable?: string;
}>;

export async function fetchFleetCapacityVariable(
	options: LoadFleetCapacityOptions,
): Promise<FleetCapacityPublished | undefined> {
	const inline = process.env.HOBO_CI_FLEET_CAPACITY_JSON?.trim();
	if (inline) return parseFleetCapacityPublished(inline);
	const repository = options.repository?.trim();
	const token = options.token?.trim();
	if (!repository || !token) return undefined;
	const variable = options.variable ?? FLEET_CAPACITY_VARIABLE;
	const [owner, repo] = repository.split("/");
	if (!owner || !repo) return undefined;
	const url = `https://api.github.com/repos/${owner}/${repo}/actions/variables/${variable}`;
	const fetchFn = options.fetch ?? globalThis.fetch;
	const response = await fetchFn(url, {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (response.status === 404) return undefined;
	if (!response.ok) {
		console.error(
			`load-fleet-capacity: variables/${variable} returned ${response.status}`,
		);
		return undefined;
	}
	const body: unknown = await response.json();
	const value = z.object({ value: z.string().min(1) }).safeParse(body);
	if (!value.success) return undefined;
	return parseFleetCapacityPublished(value.data.value);
}

export async function resolveMainWorkspaceParallelCap(
	options: LoadFleetCapacityOptions = {},
): Promise<number> {
	const override = Number(process.env.MAIN_WORKSPACE_PARALLEL_CAP ?? "");
	if (
		Number.isInteger(override) &&
		override >= 1 &&
		override <= 8 &&
		process.env.MAIN_WORKSPACE_PARALLEL_CAP !== undefined
	)
		return override;
	const published = await fetchFleetCapacityVariable(options);
	return mainWorkspaceParallelCap(
		published,
		DEFAULT_MAIN_WORKSPACE_PARALLEL_CAP,
	);
}
