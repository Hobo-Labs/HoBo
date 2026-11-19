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
