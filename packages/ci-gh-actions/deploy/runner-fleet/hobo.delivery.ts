import { readFileSync } from "node:fs";

import {
	parseRunnerHosts,
	runnerFleetDelivery,
	runnerFleetRail,
	runnerFleetTopology,
} from "../../src/runner-fleet-delivery.js";

const parsed = parseRunnerHosts(
	readFileSync(new URL("hosts.json", import.meta.url), "utf8"),
);
if (!parsed.ok)
	throw new Error(
		`${parsed.code}: ${parsed.problems.join("; ")}\n${parsed.remediation}`,
	);
const releaseIndexBase = process.env.HOBO_CI_RUNNER_RELEASE_INDEX?.trim();
const delivery = runnerFleetDelivery(parsed.value, {
	repository: "Hobo-Labs/HoBo",
	...(releaseIndexBase ? { releaseIndexBase } : undefined),
});

export const sources = delivery.sources;
export const campSets = delivery.campSets;
export const placements = delivery.placements;
export const pipelines = delivery.pipelines;
export const camps = runnerFleetTopology(parsed.value, { stationId: "" });
export const rails = [runnerFleetRail()];
