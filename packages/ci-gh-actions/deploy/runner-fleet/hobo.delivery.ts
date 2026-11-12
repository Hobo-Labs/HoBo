// HoBo's runner fleet as delivery-as-code. Apply it on the CD Station with
//   hobo deploy pipeline apply --file packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts
// The records come from the declared hosts (hosts.json); see README.md here.
// `camps` declares one Camp per host and `rails` the Station Rail that binds
// their Camp set and approves their provider; later CD commands read both as
// topology with `--yard <this file>` or HOBO_CD_TOPOLOGY=<this file>.
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
const delivery = runnerFleetDelivery(parsed.value, {
	repository: "Hobo-Labs/HoBo",
});

export const sources = delivery.sources;
export const campSets = delivery.campSets;
export const placements = delivery.placements;
export const pipelines = delivery.pipelines;
// An empty stationId is the Station the CD runtime composes (HOBO_STATION).
export const camps = runnerFleetTopology(parsed.value, { stationId: "" });
// The Station Rail for the fleet (empty stationId: the composed Station).
export const rails = [runnerFleetRail()];
