import { ReconcileStatus } from "@hobo/cd";
import type { JsonObject } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { karmadaRealizer } from "../src/index.js";
import { FakeKarmada } from "./fake-hub.js";
import { credentials, ctx, deployment, karmadaConfig, realizeInput, type ResourceSpec, volume } from "./fixtures.js";

function setup(departure = "DEPARTURE_ACTION_ORPHAN_DATA", fields: readonly string[] = []) {
	const hub = new FakeKarmada();
	const realizer = karmadaRealizer({
		config: karmadaConfig({ "camp-a": "member-a", "camp-b": "member-b" }, departure),
		http: hub.transport,
		credentials: credentials(),
		observeFields: async () => fields,
	});
	return { hub, realizer };
}

async function convergeTwice(hub: FakeKarmada, realizer: ReturnType<typeof karmadaRealizer>, campId: string, resources: readonly ResourceSpec[], options: Parameters<typeof realizeInput>[2] = {}) {
	await realizer.converge(realizeInput(campId, resources, options), ctx);
	hub.schedule();
	return realizer.converge(realizeInput(campId, resources, options), ctx);
}

function specOf(object: JsonObject | undefined): JsonObject {
	// SAFETY: test reads a spec the realizer wrote.
	return (object?.spec ?? {}) as JsonObject;
}

describe("karmadaRealizer", () => {
	it("pins the output to exactly one member cluster (Duplicated, no OverridePolicy, no failover)", async () => {
		const { hub, realizer } = setup();
		const record = await convergeTwice(hub, realizer, "camp-a", [deployment("web", "img@sha256:aaaa")]);
		expect(record.status).toBe(ReconcileStatus.CONVERGED);
		const [policy] = hub.policies();
		expect(hub.policies()).toHaveLength(1);
		expect(specOf(policy)).toEqual({
			resourceSelectors: [{ apiVersion: "apps/v1", kind: "Deployment", namespace: "shop", name: "web" }],
			placement: {
				clusterAffinity: { clusterNames: ["member-a"] },
				replicaScheduling: { replicaSchedulingType: "Duplicated" },
			},
			preserveResourcesOnDeletion: false,
			conflictResolution: "Abort",
			propagateDeps: false,
		});
		const bindings = hub.bindings();
		expect(bindings).toHaveLength(1);
		expect(specOf(bindings[0]).clusters).toEqual([{ name: "member-a" }]);
		const paths = hub.log.map((l) => l.path);
		expect(paths.some((p) => /overridepolicies|clusterpropagationpolicies/u.test(p))).toBe(false);
		expect(hub.log.filter((l) => l.method !== "GET").every((l) => !/failover|spreadConstraints|clusterTolerations/u.test(JSON.stringify(l.body ?? {})))).toBe(true);
	});

	it("blocks when a binding reaches any cluster other than the Camp's member", async () => {
		const { hub, realizer } = setup();
		hub.extraCluster = "member-z";
		const record = await convergeTwice(hub, realizer, "camp-a", [deployment("web", "img@sha256:aaaa")]);
		expect(record.status).toBe(ReconcileStatus.BLOCKED);
		expect(record.reasons[0]?.code).toBe("karmada-pinning-violated");
		expect(record.reasons[0]?.message).toContain("member-z");
	});

	it("reports drift when the policy is re-targeted out of band", async () => {
		const { hub, realizer } = setup();
		const resources = [deployment("web", "img@sha256:aaaa")];
		await convergeTwice(hub, realizer, "camp-a", resources);
		const [policy] = hub.policies();
		const edited = JSON.parse(JSON.stringify(policy)) as JsonObject;
		((specOf(edited).placement as JsonObject).clusterAffinity as { clusterNames: string[] }).clusterNames = ["member-a", "member-x"];
		hub.objects.set("policy.karmada.io|propagationpolicies|shop|hobo-camp-a", edited);
		const observed = await realizer.observe(realizeInput("camp-a", resources), ctx);
		expect(observed.status).toBe(ReconcileStatus.DRIFTED);
		expect(observed.reasons.map((r) => r.code)).toContain("karmada-pinning-violated");
	});

	it("refuses a template that belongs to another Camp, before any write", async () => {
		const { hub, realizer } = setup();
		await convergeTwice(hub, realizer, "camp-b", [deployment("web", "img@sha256:aaaa")]);
		const before = hub.mutatingCalls().length;
		const record = await realizer.converge(realizeInput("camp-a", [deployment("web", "img@sha256:aaaa")]), ctx);
		expect(record.status).toBe(ReconcileStatus.BLOCKED);
		expect(record.reasons[0]?.code).toBe("karmada-template-conflict");
		expect(hub.mutatingCalls().length).toBe(before);
	});

	it("refuses cluster-scoped objects with a typed reason", async () => {
		const { hub, realizer } = setup();
		const ns = { name: "ns", params: { manifest: { apiVersion: "v1", kind: "Namespace", metadata: { name: "shop" } } } };
		const record = await realizer.converge(realizeInput("camp-a", [ns]), ctx);
		expect(record.status).toBe(ReconcileStatus.BLOCKED);
		expect(record.reasons[0]?.code).toBe("karmada-cluster-scoped-unsupported");
		expect(hub.log).toHaveLength(0);
	});

	it("ORPHAN_DATA: removed compute is deleted from the member, the removed volume is preserved", async () => {
		const { hub, realizer } = setup();
		await convergeTwice(hub, realizer, "camp-a", [deployment("web", "img@sha256:aaaa"), deployment("worker", "img@sha256:cccc"), volume("db")]);
		expect(hub.policies().map((p) => (p.metadata as JsonObject).name).sort()).toEqual(["hobo-camp-a", "hobo-camp-a-data"]);
		const record = await convergeTwice(hub, realizer, "camp-a", [deployment("web", "img@sha256:bbbb")]);
		expect(record.status).toBe(ReconcileStatus.CONVERGED);
		expect(hub.preserved).toEqual(["shop/db"]);
		expect(hub.templates().map((t) => (t.metadata as JsonObject).name)).toEqual(["web"]);
		expect(hub.policies().map((p) => (p.metadata as JsonObject).name)).toEqual(["hobo-camp-a"]);
	});

	it("leaves a kept template in place when its policy would not preserve it", async () => {
		const { hub, realizer } = setup("DEPARTURE_ACTION_ORPHAN_DATA");
		await convergeTwice(hub, realizer, "camp-a", [deployment("web", "img@sha256:aaaa"), deployment("worker", "img@sha256:cccc")]);
		const record = await convergeTwice(hub, realizer, "camp-a", [deployment("web", "img@sha256:aaaa")], { keep: ["worker"] });
		expect(record.reasons.map((r) => r.code)).toContain("karmada-keep-retained");
		expect(hub.templates().map((t) => (t.metadata as JsonObject).name).sort()).toEqual(["web", "worker"]);
	});

	it("keeps converging while the member reports the resource unhealthy", async () => {
		const { hub, realizer } = setup();
		hub.health = "Unhealthy";
		const record = await convergeTwice(hub, realizer, "camp-a", [deployment("web", "img@sha256:aaaa")]);
		expect(record.status).toBe(ReconcileStatus.CONVERGING);
		expect(record.reasons[0]?.code).toBe("karmada-member-unhealthy");
	});

	it("reads observe_fields from the member status and the template", async () => {
		const { hub, realizer } = setup("DEPARTURE_ACTION_ORPHAN_DATA", ["status.readyReplicas", "spec.replicas", "status.absent"]);
		const record = await convergeTwice(hub, realizer, "camp-a", [deployment("web", "img@sha256:aaaa", 3)]);
		expect(record.resources[0]?.attributes).toEqual({ "status.readyReplicas": "3", "spec.replicas": "3" });
	});

	it("binds at the current template revision only: a stale binding keeps the Camp converging", async () => {
		const { hub, realizer } = setup();
		await convergeTwice(hub, realizer, "camp-a", [deployment("web", "img@sha256:aaaa")]);
		const record = await realizer.converge(realizeInput("camp-a", [deployment("web", "img@sha256:bbbb")]), ctx);
		expect(record.status).toBe(ReconcileStatus.CONVERGING);
		expect(record.reasons[0]?.code).toBe("karmada-binding-pending");
	});
});
