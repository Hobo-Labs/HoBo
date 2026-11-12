// HoBo's runner fleet as delivery-as-code. Apply it on the CD Station with
//   hobo deploy pipeline apply --file packages/ci-gh-actions/deploy/runner-fleet/hobo.delivery.ts
// The records come from the declared hosts (hosts.json); see README.md here.

import {
	parseRunnerHosts,
	runnerFleetDelivery,
} from "../../src/runner-fleet-delivery.js";
import hosts from "./hosts.json" with { type: "json" };

const parsed = parseRunnerHosts(hosts);
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
