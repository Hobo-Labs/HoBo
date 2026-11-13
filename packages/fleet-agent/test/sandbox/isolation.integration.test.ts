/**
 * O10, "Sandboxes hold" (design §10.1): `runSandboxIsolationProbe` against
 * every driver `sandboxDrivers()` returns, with probe programs run inside real
 * sandboxes, plus the logic suite against the same real drivers.
 *
 * An `S1_CONTAINER` driver must be present, with or without `CI`: none fails
 * the outcome. Only drivers whose self-test passed are probed, so an
 * unprovisioned gVisor, Kata or Apple runtime (A11, A12) adds no test.
 *
 * Needs an OCI runtime (`crun` or `runc`), `nsenter`, network access to the
 * probe image's registry and to the allowed host. `HOBO_FLEET_PROBE_IMAGE`
 * names the probe image (the integration lane pins it by digest);
 * `HOBO_FLEET_PROBE_ALLOWED_HOST` the host the egress proxy allows.
 */
import { type FleetLog, type SandboxDriver, SandboxTier } from "@hobo/fleet";
import {
	runSandboxConformance,
	runSandboxIsolationProbe,
} from "@hobo/fleet/testing";
import { describe, expect, it } from "vitest";
import { createEgressProxyFactory } from "../../src/egress/index.js";
import { sandboxDrivers } from "../../src/sandbox/index.js";

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

const drivers: readonly SandboxDriver[] = await sandboxDrivers({ log });

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
