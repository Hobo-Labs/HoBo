// Runner-host health as Camp inventory evidence, and the runner fleet's
// Station Rail: what the CD agent on a runner host reports (claims on its
// reconcile observation) and what the Station turns them into
// (CampInventory.observe conditions), plus the Rail that makes the fleet's
// Placement decidable.
import { readFileSync } from "node:fs";
import { createRail } from "@hobo/stations";
import { describe, expect, it } from "vitest";
import { parseMeshAdvert } from "../src/mesh-records.js";
import {
	parseRunnerHosts,
	RUNNER_FLEET_CAMP_SET,
	RUNNER_FLEET_PROVIDER,
	runnerFleetRail,
	runnerFleetTopology,
} from "../src/runner-fleet-delivery.js";
import {
	RUNNER_HOST_HEALTH_CLAIMS,
	runnerHostAbsentReport,
	runnerHostCampReport,
	runnerHostHealthConditions,
} from "../src/runner-host-realizer.js";

const recorded = JSON.parse(
	readFileSync(
		new URL("./fixtures/runner-host/box-host.json", import.meta.url),
		"utf8",
	),
);
const advert = parseMeshAdvert(recorded.meshAdvert);
if (!advert) throw new Error("fixture mesh advert does not parse");
const NOW = advert.validUntilMs - 30_000;
const DIGEST = `sha256:${"2".repeat(64)}`;

/** A resolver outcome as the realizer reports it for the recorded box host. */
function outcomeWith(
	meshAdvert: Record<string, unknown> | undefined,
	serving = true,
) {
	return {
		contract: "hobo.resolver/v1",
		action: "noop" as const,
		physicalId: "hobo-ci-runners/box/controller",
		outputs: {
			hostId: "box",
			controllerDigest: DIGEST,
			image: `ghcr.io/hobo-labs/hobo/hobo-ci-worker@${DIGEST}`,
			inFlightJobs: 0,
			busyRunners: 0,
			onlineRunners: 0,
			serving,
			claims: { platform: "linux/x64", capacity: "4" },
			retained: [],
			...(meshAdvert ? { meshAdvert } : undefined),
		},
		diagnostics: [],
	};
}

const fresh = {
	healthy: true,
	validUntilMs: advert.validUntilMs,
	sinceMs: advert.sinceMs,
	labels: [...advert.labels],
};

const claimOf = (
	claims: readonly Readonly<{ name: string; value: string }>[],
	name: string,
) => claims.find((claim) => claim.name === name)?.value;

describe("runner-host health claims (agent side)", () => {
	it("a fresh healthy advert reports served labels, advert freshness and readiness as claims", () => {
		const report = runnerHostCampReport(outcomeWith(fresh), NOW);
		const claims = report.claims;
		expect(claimOf(claims, "label:hobo.ci/serves-hobo")).toBe("true");
		expect(claimOf(claims, "label:hobo.ci/serves-hobo-trunk")).toBe("true");
		expect(claimOf(claims, "label:hobo.ci/serves-hobo-local-host")).toBe(
			"false",
		);
		expect(claimOf(claims, RUNNER_HOST_HEALTH_CLAIMS.advert)).toBe("fresh");
		expect(claimOf(claims, RUNNER_HOST_HEALTH_CLAIMS.validUntil)).toBe(
			new Date(advert.validUntilMs).toISOString(),
		);
		expect(claimOf(claims, RUNNER_HOST_HEALTH_CLAIMS.ready)).toBe("true");
		expect(
			claims.every((claim) => claim.reportedBy === "runner-host:box"),
		).toBe(true);
	});

	it("an expired advert reads expired and not ready, and claims no served labels", () => {
		const report = runnerHostCampReport(
			outcomeWith({ ...fresh, validUntilMs: NOW - 1 }),
			NOW,
		);
		expect(claimOf(report.claims, RUNNER_HOST_HEALTH_CLAIMS.advert)).toBe(
			"expired",
		);
		expect(claimOf(report.claims, RUNNER_HOST_HEALTH_CLAIMS.ready)).toBe(
			"false",
		);
		expect(report.claims.some((claim) => claim.name.startsWith("label:"))).toBe(
			false,
		);
	});

	it("a host with no controller reports the advert missing and not ready", () => {
		const report = runnerHostAbsentReport("box", NOW);
		expect(report.resource.healthy).toBe(false);
		expect(claimOf(report.claims, RUNNER_HOST_HEALTH_CLAIMS.advert)).toBe(
			"missing",
		);
		expect(claimOf(report.claims, RUNNER_HOST_HEALTH_CLAIMS.ready)).toBe(
			"false",
		);
	});
});

describe("runner-host health conditions (Station side)", () => {
	it("maps the claims to the mesh table: fresh and healthy is REACHABLE, LEASED and READY", () => {
		const { claims } = runnerHostCampReport(outcomeWith(fresh), NOW);
		const health = runnerHostHealthConditions(claims, NOW);
		expect(health.advert).toBe("fresh");
		expect(
			health.conditions.map((c) => [c.type, c.status, c.reason, c.source]),
		).toEqual([
			[
				"CAMP_CONDITION_TYPE_REACHABLE",
				"CONDITION_STATUS_TRUE",
				"mesh-advert-fresh",
				"SIGNAL_SOURCE_HEALTH_SOURCE",
			],
			[
				"CAMP_CONDITION_TYPE_LEASED",
				"CONDITION_STATUS_TRUE",
				`mesh-lease-valid-until:${new Date(advert.validUntilMs).toISOString()}`,
				"SIGNAL_SOURCE_HEALTH_SOURCE",
			],
			[
				"CAMP_CONDITION_TYPE_READY",
				"CONDITION_STATUS_TRUE",
				"runner-host-healthy",
				"SIGNAL_SOURCE_HEALTH_SOURCE",
			],
		]);
	});

	it("a fresh advert from a draining or unhealthy host is READY false", () => {
		const { claims } = runnerHostCampReport(
			outcomeWith({ ...fresh, healthy: false }, false),
			NOW,
		);
		const ready = runnerHostHealthConditions(claims, NOW).conditions.find(
			(c) => c.type === "CAMP_CONDITION_TYPE_READY",
		);
		expect(ready?.status).toBe("CONDITION_STATUS_FALSE");
		expect(ready?.reason).toBe("runner-host-draining-or-pressured");
	});

	it("a lease that lapsed after the agent reported reads expired at the Station's clock", () => {
		const { claims } = runnerHostCampReport(outcomeWith(fresh), NOW);
		const later = runnerHostHealthConditions(claims, advert.validUntilMs + 1);
		expect(later.advert).toBe("expired");
		expect(later.conditions.map((c) => c.status)).toEqual([
			"CONDITION_STATUS_FALSE",
			"CONDITION_STATUS_FALSE",
			"CONDITION_STATUS_FALSE",
		]);
	});

	it("missing evidence is UNKNOWN, never assumed healthy", () => {
		const health = runnerHostHealthConditions([], NOW);
		expect(health.advert).toBe("missing");
		expect(health.conditions.map((c) => c.status)).toEqual([
			"CONDITION_STATUS_UNKNOWN",
			"CONDITION_STATUS_UNKNOWN",
			"CONDITION_STATUS_UNKNOWN",
		]);
	});
});

describe("the runner fleet's Station Rail", () => {
	const hosts = parseRunnerHosts(
		readFileSync(
			new URL("../deploy/runner-fleet/hosts.json", import.meta.url),
			"utf8",
		),
	);
	if (!hosts.ok) throw new Error("hosts.json does not parse");

	it("binds the fleet's Camp set and approves exactly the provider its Camps declare", () => {
		const rail = runnerFleetRail();
		expect(rail.delivery.campSets).toEqual([RUNNER_FLEET_CAMP_SET]);
		const providers = new Set(
			runnerFleetTopology(hosts.value, { stationId: "" }).map(
				(camp) => camp.provider,
			),
		);
		expect([...providers]).toEqual([RUNNER_FLEET_PROVIDER]);
		expect(rail.approvedProviders).toEqual([RUNNER_FLEET_PROVIDER]);
	});

	it("is a valid @hobo/stations Rail once a Station is named", () => {
		const rail = createRail({ ...runnerFleetRail(), stationId: "station-a" });
		expect(rail.approvedProviders).toEqual([RUNNER_FLEET_PROVIDER]);
		expect(rail.delivery).toEqual({ campSets: [RUNNER_FLEET_CAMP_SET] });
		expect(rail.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
	});
});
