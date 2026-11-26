import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	loadPactDirectory,
	type ProviderStub,
	verifyPact,
} from "@hobo/contract-harness";
import { must } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import { createProcessKubectlTransport } from "../../src/index.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

/**
 * Provider verification for the kubectl cluster API boundary.
 *
 * The production provider is `createProcessKubectlTransport`.
 * Offline CI verifies identity + non-blocking probe paths.
 * Full apply/port-forward verification requires a live cluster
 * (`HOBO_REQUIRE_KUBECTL=1`).
 */
describe("kubectl-cluster provider verification", () => {
	it("process transport identity matches pact provider name", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const pact = pacts.find((p) => p.provider.name === "KubernetesClusterApi");
		expect(pact).toBeDefined();
		const transport = createProcessKubectlTransport();
		expect(transport.name).toBe(must(pact).provider.name);
	});

	it("process transport serves version + cluster-info without hanging", async () => {
		const transport = createProcessKubectlTransport();
		const version = await transport.handle({
			method: "POST",
			path: "/kubectl/version",
			body: { client: true },
		});
		// 200 when kubectl is installed; 503 when missing — never hang.
		expect([200, 503]).toContain(version.status);
		if (version.status === 200) {
			expect(version.body).toMatchObject({ ok: true });
		}

		const cluster = await transport.handle({
			method: "POST",
			path: "/kubectl/cluster-info",
		});
		expect([200, 503]).toContain(cluster.status);
	});

	it("every pact path is implemented (not 404)", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const pact = pacts.find((p) => p.provider.name === "KubernetesClusterApi");
		expect(pact).toBeDefined();

		const processTransport = createProcessKubectlTransport();
		const provider: ProviderStub = {
			name: "KubernetesClusterApi",
			async handle(request) {
				// Guard long-running paths offline: return structured unavailable
				// instead of spawning port-forward against a missing cluster.
				if (
					process.env.HOBO_REQUIRE_KUBECTL !== "1" &&
					(request.path === "/kubectl/port-forward" ||
						request.path === "/kubectl/http-proxy" ||
						request.path === "/kubectl/apply" ||
						request.path === "/kubectl/rollout-status" ||
						request.path === "/kubectl/namespace/ensure" ||
						request.path === "/kubectl/resources")
				) {
					return {
						status: 503,
						body: {
							ok: false,
							error: "live cluster required (set HOBO_REQUIRE_KUBECTL=1)",
						},
					};
				}
				return processTransport.handle(request);
			},
		};

		for (const interaction of must(pact).interactions) {
			const actual = await provider.handle(interaction.request);
			expect(actual.status, interaction.description).not.toBe(404);
		}

		// Full body verification only when a live cluster is required.
		if (process.env.HOBO_REQUIRE_KUBECTL === "1") {
			const report = await verifyPact(must(pact), {
				name: "KubernetesClusterApi",
				handle: (req) => processTransport.handle(req),
			});
			expect(report.ok, JSON.stringify(report.failures)).toBe(true);
		}
	});
});
