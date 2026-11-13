/**
 * The box daemon's routing policy (plan 0026, 3.4; ADR-0181): the committed
 * `runnerRouting` block of `.hobo/ci.json` in the daemon's own checkout.
 *
 * No environment variable chooses a runner label, a tier, a pool, a slot
 * split, a limit or a reporter on the box (R2). The daemon reads the file once
 * at start. A checkout with no `runnerRouting` (an older one) runs on the
 * code's defaults below, which the committed block equals, so that changes
 * nothing (R3). A block that is there but is not a policy refuses to start, as
 * the daemon's other invalid settings do.
 *
 * At start the daemon also logs, once, the **names** (never the values) of
 * any routing environment variable still set on the box, so a box-local
 * override that stopped applying is visible.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_GITHUB_MACHINE_TYPE } from "@hobo/ci";
import { z } from "zod";
import { DEFAULT_CI_PROJECT_PATH } from "../relay-routing.js";
import { RUNNER_LABEL, TRUNK_RUNNER_LABEL } from "../runner-labels.js";
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

/** Headroom admission keeps above the heavy class before it admits. */
export const DEFAULT_CAPACITY_VOLATILITY_MB = 1024;
/** How long a trunk job waits on headroom before it defers to the fleet. */
export const DEFAULT_TRUNK_HEADROOM_FLEET_DEFER_MS = 45_000;
/** Free runners elsewhere that still count as "something else can take it". */
export const DEFAULT_FLEET_MIN_FREE_RUNNERS = 1;
/** Work assigned to a label with nothing started this long is `stalled`. */
export const DEFAULT_ROUTING_STALL_MS = 10 * 60_000;

/** How often the box relay looks for a newer main (plan 0026, 3.8). */
export const DEFAULT_SELF_UPDATE_INTERVAL_HOURS = 3;

/**
 * The code's defaults. The committed `runnerRouting` equals them (plan 0026,
 * M8), so a checkout without the block routes exactly as one with it.
 */
export const DEFAULT_RUNNER_ROUTING: RunnerRouting = {
	pin: "auto",
	queue: { maxWaitSeconds: 120, maxQueued: 4 },
	labels: {
		fleet: RUNNER_LABEL,
		trunk: TRUNK_RUNNER_LABEL,
		local: "hobo-local-host",
		github: DEFAULT_GITHUB_MACHINE_TYPE,
	},
	localRunner: false,
	mainWorkspaceParallelCap: 4,
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
	],
	selfUpdate: {
		enabled: true,
		intervalHours: DEFAULT_SELF_UPDATE_INTERVAL_HOURS,
	},
};

export type BoxRoutingPolicy = Readonly<{
	policy: RunnerRouting;
	/** `committed`: read from the file; `default`: the file has no block. */
	source: "committed" | "default";
	path: string;
}>;

/** The one part of `.hobo/ci.json` the box reads; the rest is not its business. */
const Document = z.object({ runnerRouting: z.json().optional() });

/**
 * The policy in `<checkoutRoot>/.hobo/ci.json`. Throws when the file is
 * there but is not JSON, or its `runnerRouting` is not a policy.
 */
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

/**
 * Every environment name plan 0026 (3.4) counts as routing. None of them is
 * read on the box any more; `routingEnvironmentNamesSet` names the ones still
 * set, for the start log.
 */
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
]);
/** Every `HOBO_CI_FLEET_VERDICT_*` name is routing too. */
export const ROUTING_ENVIRONMENT_PREFIXES: readonly string[] = Object.freeze([
	"HOBO_CI_FLEET_VERDICT_",
]);

/** The routing names set (non-empty) in `env`, sorted. Never their values. */
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
