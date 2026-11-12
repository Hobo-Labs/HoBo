// Consumer side of the three hub boundaries. Each pact pins the exact calls
// this package makes and the recorded response shapes it must interpret:
// OCM ManifestWork (work.open-cluster-management.io/v1), Karmada
// PropagationPolicy + ResourceBinding (policy.karmada.io/v1alpha1,
// work.karmada.io/v1alpha2) and SIG-Multicluster ClusterProfile
// (multicluster.x-k8s.io/v1alpha1).
import { CampManagement, ReconcileStatus } from "@hobo/cd";
import { describe, expect, it } from "vitest";
import { clusterProfileInventory, karmadaRealizer, ocmRealizer, parseClusterProfileImport } from "../../src/index.js";
import { credentials, ctx, deployment, hub, karmadaConfig, now, ocmConfig, realizeInput } from "../../test/fixtures.js";
import { loadPact, pactTransport, state } from "./pact-transport.js";

const web = [deployment("web", "registry.example/shop/web@sha256:6a1f0c9d8e7b5a4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c", 3)];
const input = () => realizeInput("store-paris", web);

describe("OpenClusterManagementHub (consumer side of the pact)", () => {
	const pact = loadPact("cd_kube_fleet_ocm");
	const realizer = (http: ReturnType<typeof pactTransport>) =>
		ocmRealizer({ config: ocmConfig({ "store-paris": "edge-paris-01" }), http, credentials: credentials(), observeFields: async () => ["status.availableReplicas"] });

	it("a first converge lists, then creates one single-cluster ManifestWork, and reports CONVERGING", async () => {
		const http = pactTransport(state(pact, "first-converge"));
		const record = await realizer(http).converge(input(), ctx);
		expect(record.status).toBe(ReconcileStatus.CONVERGING);
		expect(http.served()).toBe(2);
	});

	it.each([
		["converged", ReconcileStatus.CONVERGED, undefined],
		["blocked", ReconcileStatus.BLOCKED, "ocm-work-apply-failed"],
		["converging", ReconcileStatus.CONVERGING, "ocm-work-not-applied"],
	])("interprets the recorded %s work status", async (providerState, status, code) => {
		const http = pactTransport(state(pact, providerState));
		const record = await realizer(http).observe(input(), ctx);
		expect(record.status).toBe(status);
		expect(record.reasons[0]?.code).toBe(code);
		expect(http.served()).toBe(1);
		if (status === ReconcileStatus.CONVERGED) expect(record.resources[0]?.attributes).toEqual({ "status.availableReplicas": "3" });
	});
});

describe("KarmadaControlPlane (consumer side of the pact)", () => {
	const pact = loadPact("cd_kube_fleet_karmada");
	const realizer = (http: ReturnType<typeof pactTransport>) =>
		karmadaRealizer({ config: karmadaConfig({ "store-paris": "edge-paris-01" }), http, credentials: credentials() });

	it("a first converge writes the pinned policy before the template, and reports CONVERGING", async () => {
		const http = pactTransport(state(pact, "first-converge"));
		const record = await realizer(http).converge(input(), ctx);
		expect(record.status).toBe(ReconcileStatus.CONVERGING);
		expect(record.reasons[0]?.code).toBe("karmada-binding-pending");
		expect(http.served()).toBe(5);
	});

	it("a recorded binding applied and Healthy on the one member is CONVERGED", async () => {
		const http = pactTransport(state(pact, "converged"));
		const record = await realizer(http).observe(input(), ctx);
		expect(record.status).toBe(ReconcileStatus.CONVERGED);
		expect(http.served()).toBe(3);
	});

	it("a recorded binding reaching a second member is a pinning violation", async () => {
		const http = pactTransport(state(pact, "pinning-violated"));
		const record = await realizer(http).observe(input(), ctx);
		expect(record.status).toBe(ReconcileStatus.BLOCKED);
		expect(record.reasons[0]?.code).toBe("karmada-pinning-violated");
	});
});

describe("ClusterInventoryApiServer (consumer side of the pact)", () => {
	it("imports the recorded ClusterProfiles as OBSERVE_ONLY Camps and skips the invalid one", async () => {
		const pact = loadPact("cd_kube_fleet_cluster_profiles");
		const http = pactTransport(pact.interactions);
		const inventory = clusterProfileInventory({
			config: parseClusterProfileImport({
				schemaVersion: "hobo.cd-kube-fleet.cluster-profiles/v1",
				hub: { ...hub("HUB_KIND_CLUSTER_INVENTORY", "inventory") },
				namespace: "fleet-system",
				yardId: "yard-eu",
				stationId: "station-eu",
				provider: "kubernetes",
				envType: "prod",
				regions: ["eu-west-1"],
			}),
			http,
			credentials: credentials(),
			now,
		});
		const snapshot = await inventory.list();
		expect(snapshot.resourceVersion).toBe("48211");
		expect(snapshot.camps.map((c) => [c.topology.campId, c.topology.management])).toEqual([
			["fleet-system-edge-lyon-02", CampManagement.OBSERVE_ONLY],
			["fleet-system-edge-paris-01", CampManagement.OBSERVE_ONLY],
		]);
		expect(snapshot.skipped).toHaveLength(1);
		expect(http.served()).toBe(1);
	});
});
