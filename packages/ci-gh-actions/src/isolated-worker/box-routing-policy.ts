import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_GITHUB_MACHINE_TYPE } from "@hobo/ci";
import { z } from "zod";
import { DEFAULT_CI_PROJECT_PATH } from "../relay-routing.js";
import {
	BOX_ISOLATED_RUNNER_LABEL,
	RUNNER_LABEL,
	TRUNK_RUNNER_LABEL,
} from "../runner-labels.js";
import { parseRunnerRouting, type RunnerRouting } from "../runner-routing.js";
import {
	FLEET_VERDICT_ENTER_MS,
	FLEET_VERDICT_EXIT_MS,
} from "./fleet-verdict-state.js";
import {
	DEFAULT_WORKER_MERGE_GROUP_LEASES,
	DEFAULT_WORKER_PR_CAP_WITH_TRUNK,
	DEFAULT_WORKER_SLOTS,
} from "./worker-slots.js";

export const DEFAULT_CAPACITY_VOLATILITY_MB = 1024;
export const DEFAULT_TRUNK_HEADROOM_FLEET_DEFER_MS = 45_000;
export const DEFAULT_FLEET_MIN_FREE_RUNNERS = 1;
export const DEFAULT_ROUTING_STALL_MS = 10 * 60_000;

export const DEFAULT_RUNNER_ROUTING: RunnerRouting = {
	pin: "auto",
	queue: { maxWaitSeconds: 120, maxQueued: 4 },
	labels: {
		fleet: RUNNER_LABEL,
		trunk: TRUNK_RUNNER_LABEL,
		local: "hobo-local-host",
		github: DEFAULT_GITHUB_MACHINE_TYPE,
		box: BOX_ISOLATED_RUNNER_LABEL,
	},
	localRunner: false,
	boxRunner: false,
	mainWorkspaceParallelCap: 4,
	mainGate: { reuseMergeQueue: true },
	mergeGroup: { reusePrFabric: false },
	verdict: {
		minFreeRunners: DEFAULT_FLEET_MIN_FREE_RUNNERS,
		enterMs: FLEET_VERDICT_ENTER_MS,
		exitMs: FLEET_VERDICT_EXIT_MS,
		stallMs: DEFAULT_ROUTING_STALL_MS,
	},
	box: {
		slots: DEFAULT_WORKER_SLOTS,
		trunkSlots: DEFAULT_WORKER_SLOTS >= 2 ? 1 : 0,
		trunkLend: 0,
		prCapWithTrunk: DEFAULT_WORKER_PR_CAP_WITH_TRUNK,
		mergeGroupLeases: DEFAULT_WORKER_MERGE_GROUP_LEASES,
		capacityVolatilityMb: DEFAULT_CAPACITY_VOLATILITY_MB,
		trunkHeadroomFleetDeferMs: DEFAULT_TRUNK_HEADROOM_FLEET_DEFER_MS,
		jobAdmission: "pull",
	},
	externalPools: [],
	retiredVariables: [
		"HOBO_CI_FLEET_ROUTES",
		"HOBO_CI_FLEET_STATE",
		"HOBO_CI_FLEET_CAPACITY",
		"HOBO_CI_ROUTE",
		"HOBO_CI_LOCAL_RUNNER",
		"HOBO_CI_ROUTE_MAX_WAIT_SECONDS",
		"HOBO_CI_ROUTE_MAX_QUEUED",
		"HOBO_CI_TRUNK_RUNNER",
		"HOBO_CI_BOX_RUNNER",
		"HOBO_CI_MAIN_REUSE_MERGE_QUEUE",
	],
};

export type BoxRoutingPolicy = Readonly<{
	policy: RunnerRouting;
	source: "committed" | "default";
	path: string;
}>;

const Document = z.object({ runnerRouting: z.json().optional() });

export function readBoxRoutingPolicy(checkoutRoot: string): BoxRoutingPolicy {
	const path = join(checkoutRoot, DEFAULT_CI_PROJECT_PATH);
	if (!existsSync(path))
		return { policy: DEFAULT_RUNNER_ROUTING, source: "default", path };
	let document: z.infer<typeof Document>;
	try {
		document = Document.parse(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		throw new Error(`invalid ${DEFAULT_CI_PROJECT_PATH}: not a JSON object`);
	}
	if (document.runnerRouting === undefined)
		return { policy: DEFAULT_RUNNER_ROUTING, source: "default", path };
	const policy = parseRunnerRouting(document.runnerRouting);
	if (!policy)
		throw new Error(
			`invalid runnerRouting in ${DEFAULT_CI_PROJECT_PATH}: see schema/ci-project.schema.json`,
		);
	return { policy, source: "committed", path };
}

export const ROUTING_ENVIRONMENT_NAMES: readonly string[] = Object.freeze([
	"HOBO_CI_ROUTE",
	"HOBO_CI_ROUTE_MAX_WAIT_SECONDS",
	"HOBO_CI_ROUTE_MAX_QUEUED",
	"HOBO_CI_TRUNK_RUNNER",
	"HOBO_CI_LOCAL_RUNNER",
	"HOBO_CI_INCLUDE_OWN_RUN",
	"HOBO_CI_ATTESTED",
	"HOBO_CI_FLEET_ROUTES",
	"HOBO_CI_FLEET_REPORTER_ID",
	"HOBO_CI_FLEET_EXTERNAL_POOLS_JSON",
	"HOBO_CI_FLEET_REPORTERS_JSON",
	"HOBO_CI_FLEET_CAPACITY_VOLATILITY_MB",
	"HOBO_CI_TRUNK_HEADROOM_FLEET_DEFER_MS",
	"HOBO_CI_WORKER_SLOTS",
	"HOBO_CI_WORKER_TRUNK_SLOTS",
	"HOBO_CI_WORKER_TRUNK_LEND",
	"HOBO_CI_WORKER_PR_CAP_WITH_TRUNK",
	"HOBO_CI_WORKER_MERGE_GROUP_LEASES",
	"HOBO_CI_JOB_ADMISSION",
	"MAIN_WORKSPACE_PARALLEL_CAP",
	"HOBO_CI_BOX_RUNNER",
	"HOBO_CI_MAIN_REUSE_MERGE_QUEUE",
]);
export const ROUTING_ENVIRONMENT_PREFIXES: readonly string[] = Object.freeze([
	"HOBO_CI_FLEET_VERDICT_",
]);

export function routingEnvironmentNamesSet(
	env: Readonly<Record<string, string | undefined>>,
): string[] {
	return Object.keys(env)
		.filter(
			(name) =>
				env[name] !== undefined &&
				env[name] !== "" &&
				(ROUTING_ENVIRONMENT_NAMES.includes(name) ||
					ROUTING_ENVIRONMENT_PREFIXES.some((prefix) =>
						name.startsWith(prefix),
					)),
		)
		.sort();
}
