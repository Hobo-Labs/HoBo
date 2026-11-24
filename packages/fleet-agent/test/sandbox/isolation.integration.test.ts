import { type FleetLog, type SandboxDriver, SandboxTier } from "@hobo/fleet";
import {
	runSandboxConformance,
	runSandboxIsolationProbe,
} from "@hobo/fleet/testing";
import { describe, expect, it } from "vitest";
import { createEgressProxyFactory } from "../../src/egress/index.js";
import {
	configuredSandboxDrivers,
	sandboxSettings,
} from "../../src/sandbox/index.js";

const unavailable: string[] = [];
const log: FleetLog = (event, fields) => {
	if (
		event === "hobo_fleet_sandbox_unavailable" &&
		fields.component !== "egress"
	)
		unavailable.push(`${fields.tier} ${fields.runtime}: ${fields.reason}`);
};

const probeImage =
	process.env.HOBO_FLEET_PROBE_IMAGE ??
	"docker.io/library/busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec";
const allowedHost = process.env.HOBO_FLEET_PROBE_ALLOWED_HOST ?? "example.com";

const settings = sandboxSettings(process.env, process.geteuid?.() ?? 0);
const cache = process.env.HOBO_FLEET_SANDBOX_CACHE;
const drivers: readonly SandboxDriver[] = await configuredSandboxDrivers({
	log,
	settings:
		cache === undefined || cache === ""
			? settings
			: { ...settings, cacheDir: cache },
});

describe("O10: sandboxDrivers on this host", () => {
	it("returns an S1_CONTAINER driver", () => {
		expect(
			drivers.some((driver) => driver.tier === SandboxTier.S1_CONTAINER),
			`no S1 driver passed its self-test:\n${unavailable.join("\n")}`,
		).toBe(true);
	});
});

for (const driver of drivers) {
	describe(`${SandboxTier[driver.tier]} driver`, () => {
		runSandboxConformance(() => driver);
		runSandboxIsolationProbe(async () => driver, {
			probeImage,
			allowedHost,
			egress: createEgressProxyFactory({ fleetAllow: () => [], log }),
		});
	});
}
