import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
	CrossplaneClusterUnavailableError,
	createCrossplaneIacAdapter,
	createFixtureIacProgram,
	createKubectlCrossplaneCluster,
	KUBECTL_UNAVAILABLE,
	runIacBackendConformance,
} from "../src/index.js";

// HOBO-716: the REAL cluster lane. Gating behavior is tested offline; the
// live conformance smoke runs only where kubectl AND a reachable cluster with
// Crossplane installed exist (the kind/k3d CI lane).

function clusterReachable(): boolean {
	try {
		execFileSync("kubectl", ["get", "namespace", "default", "-o", "name"], {
			stdio: "pipe",
		});
		execFileSync(
			"kubectl",
			["get", "crd", "compositions.apiextensions.crossplane.io", "-o", "name"],
			{ stdio: "pipe" },
		);
		return true;
	} catch {
		return false;
	}
}

describe("createKubectlCrossplaneCluster gating", () => {
	it("fails closed with the typed error when kubectl is missing", () => {
		const cluster = createKubectlCrossplaneCluster({
			kubectlBin: "/nonexistent/kubectl",
		});
		expect(() => cluster.verifyReachable()).toThrowError(
			CrossplaneClusterUnavailableError,
		);
		try {
			cluster.verifyReachable();
		} catch (error) {
			// SAFETY: `expect((error as CrossplaneClusterUnavailableError).code).toBe(` is required at this I/O or test boundary.
			expect((error as CrossplaneClusterUnavailableError).code).toBe(
				KUBECTL_UNAVAILABLE,
			);
		}
	});

	it("adapter operations over an unreachable cluster reject with the typed error", async () => {
		const adapter = createCrossplaneIacAdapter({
			cluster: createKubectlCrossplaneCluster({
				kubectlBin: "/nonexistent/kubectl",
			}),
		});
		await expect(
			adapter.preview(createFixtureIacProgram()),
		).rejects.toBeInstanceOf(CrossplaneClusterUnavailableError);
	});
});

// The live lane: a real kind/k3d cluster with Crossplane installed and the
// platform XRD/Compositions applied (CI installs them; dev machines may not).
describe.runIf(
	process.env.HOBO_RUN_LIVE_CROSSPLANE === "1" && clusterReachable(),
)("real Crossplane cluster conformance", () => {
	it("passes the shared conformance smoke against live claims", async () => {
		const adapter = createCrossplaneIacAdapter({
			cluster: createKubectlCrossplaneCluster(),
			readyPollLimit: 30,
		});
		const result = await runIacBackendConformance({
			adapter,
			program: createFixtureIacProgram(),
		});
		expect(result.passed).toBe(true);
	}, 300_000);
});
