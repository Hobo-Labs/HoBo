import { ReconcileStatus } from "@hobo/cd";
import type { JsonObject } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { ocmRealizer } from "../src/index.js";
import { isJsonObject, parseJsonText, stringAt } from "../src/json.js";
import { workloadReady } from "../src/ocm/realizer.js";
import { FakeOcmHub } from "./fake-hub.js";
import {
	annotationsOf,
	credentials,
	ctx,
	deployment,
	metaOf,
	nameOf,
	ocmConfig,
	type ResourceSpec,
	realizeInput,
	volume,
} from "./fixtures.js";

type Spec = JsonObject & {
	workload: { manifests: JsonObject[] };
	deleteOption: JsonObject;
	manifestConfigs?: JsonObject[];
};

function specOf(work: JsonObject): Spec {
	// SAFETY: test reads the ManifestWork spec the realizer wrote.
	return work.spec as Spec;
}

function setup(
	departure = "DEPARTURE_ACTION_ORPHAN_DATA",
	camps: Readonly<Record<string, string>> = { "camp-a": "cluster-a" },
	fields: readonly string[] = [],
) {
	const hub = new FakeOcmHub();
	const realizer = ocmRealizer({
		config: ocmConfig(camps, departure),
		http: hub.transport,
		credentials: credentials(),
		observeFields: async () => fields,
	});
	return { hub, realizer };
}

async function convergeTwice(
	hub: FakeOcmHub,
	realizer: ReturnType<typeof ocmRealizer>,
	campId: string,
	resources: readonly ResourceSpec[],
	options: Parameters<typeof realizeInput>[2] = {},
) {
	await realizer.converge(realizeInput(campId, resources, options), ctx);
	hub.agent();
	return realizer.converge(realizeInput(campId, resources, options), ctx);
}

describe("ocmRealizer", () => {
	it("§10 HoBo fan-out over OCM-backed Camps: N single-cluster ManifestWorks, never a ManifestWorkReplicaSet", async () => {
		const camps = Object.fromEntries(
			Array.from({ length: 6 }, (_, i) => [`store-${i}`, `cluster-${i}`]),
		);
		const { hub, realizer } = setup("DEPARTURE_ACTION_ORPHAN_DATA", camps);
		const resources = [deployment("web", "registry.example/web@sha256:aaaa")];
		// Fan-out schedules ordinary per-Camp promotions; each Camp's reconciler converges its own Camp.
		for (const campId of Object.keys(camps))
			await realizer.converge(realizeInput(campId, resources), ctx);
		hub.agent();
		for (const campId of Object.keys(camps)) {
			const record = await realizer.converge(
				realizeInput(campId, resources),
				ctx,
			);
			expect(record.status).toBe(ReconcileStatus.CONVERGED);
		}
		const works = hub.works();
		expect(works).toHaveLength(6);
		for (const [i, [campId, cluster]] of Object.entries(camps).entries()) {
			const inCluster = hub.works(cluster);
			expect(inCluster, `cluster-${i}`).toHaveLength(1);
			expect(nameOf(inCluster[0])).toMatch(
				new RegExp(`^hobo-${campId}-[0-9a-f]{8}$`, "u"),
			);
			expect(annotationsOf(inCluster[0])["hobo.dev/camp-id"]).toBe(campId);
			expect(specOf(inCluster[0] ?? {}).workload.manifests).toHaveLength(1);
		}
		const paths = hub.log.map((l) => l.path);
		expect(
			paths.some((p) =>
				/manifestworkreplicasets|placements|placementdecisions/u.test(p),
			),
		).toBe(false);
		expect(
			paths.every((p) =>
				p.startsWith(
					"/apis/work.open-cluster-management.io/v1/namespaces/cluster-",
				),
			),
		).toBe(true);
	});

	it("names the work hobo-<camp>-<setdigest8> in the Camp's cluster namespace", async () => {
		const { hub, realizer } = setup();
		const input = realizeInput("camp-a", [
			deployment("web", "img@sha256:aaaa"),
		]);
		await realizer.converge(input, ctx);
		const [work] = hub.works("cluster-a");
		expect(nameOf(work)).toBe(
			`hobo-camp-a-${input.desired.contentHash.slice(7, 15)}`,
		);
		expect(stringAt(metaOf(work), "namespace")).toBe("cluster-a");
	});

	it("generates feedback rules from observe_fields and reports the fed-back attributes", async () => {
		const { hub, realizer } = setup(
			"DEPARTURE_ACTION_ORPHAN_DATA",
			{ "camp-a": "cluster-a" },
			["status.observedGeneration", "spec.replicas"],
		);
		const record = await convergeTwice(hub, realizer, "camp-a", [
			deployment("web", "img@sha256:aaaa"),
		]);
		const [work] = hub.works("cluster-a");
		const configs = specOf(work ?? {}).manifestConfigs ?? [];
		expect(configs).toEqual([
			{
				resourceIdentifier: {
					group: "apps",
					resource: "deployments",
					namespace: "shop",
					name: "web",
				},
				feedbackRules: [
					{ type: "WellKnownStatus" },
					{
						type: "JSONPaths",
						jsonPaths: [
							{
								name: "status.observedGeneration",
								path: ".observedGeneration",
							},
						],
					},
				],
			},
		]);
		expect(record.status).toBe(ReconcileStatus.CONVERGED);
		expect(record.resources[0]?.attributes).toEqual({
			"status.observedGeneration": "1",
		});
		expect(record.reasons.map((r) => [r.code, r.message])).toEqual([
			[
				"kube-attribute-unobservable",
				"spec.replicas is not a status field; OCM cannot feed it back",
			],
		]);
	});

	it.each([
		["DEPARTURE_ACTION_DELETE", { propagationPolicy: "Foreground" }],
		["DEPARTURE_ACTION_ORPHAN", { propagationPolicy: "Orphan" }],
		[
			"DEPARTURE_ACTION_ORPHAN_DATA",
			{
				propagationPolicy: "SelectivelyOrphan",
				selectivelyOrphans: {
					orphaningRules: [
						{
							group: "",
							resource: "persistentvolumeclaims",
							namespace: "shop",
							name: "db",
						},
					],
				},
			},
		],
	])("maps %s to the ManifestWork deleteOption", async (action, option) => {
		const { hub, realizer } = setup(action);
		await realizer.converge(
			realizeInput("camp-a", [
				deployment("web", "img@sha256:aaaa"),
				volume("db"),
			]),
			ctx,
		);
		expect(specOf(hub.works("cluster-a")[0] ?? {}).deleteOption).toEqual(
			option,
		);
	});

	it("replaces a Set make-before-break; ORPHAN_DATA removes compute and keeps the volume", async () => {
		const { hub, realizer } = setup();
		const v1 = [
			deployment("web", "img@sha256:aaaa"),
			deployment("worker", "img@sha256:cccc"),
			volume("db"),
		];
		expect((await convergeTwice(hub, realizer, "camp-a", v1)).status).toBe(
			ReconcileStatus.CONVERGED,
		);
		const v2 = [deployment("web", "img@sha256:bbbb")];
		const pending = await realizer.converge(realizeInput("camp-a", v2), ctx);
		expect(pending.status).toBe(ReconcileStatus.CONVERGING);
		expect(hub.works("cluster-a")).toHaveLength(2); // old work kept until the new one applies
		hub.agent();
		// Observed between passes: the new work is applied, the old one still exists.
		const between = await realizer.observe(realizeInput("camp-a", v2), ctx);
		expect(between.status).toBe(ReconcileStatus.CONVERGING);
		expect(between.reasons.map((r) => r.code)).toEqual([
			"ocm-superseded-work-pending",
		]);
		const done = await realizer.converge(realizeInput("camp-a", v2), ctx);
		expect(done.status).toBe(ReconcileStatus.CONVERGED);
		expect(hub.works("cluster-a")).toHaveLength(1);
		expect(hub.present("cluster-a")).toEqual(["apps/Deployment/shop/web"]);
		expect(hub.orphaned).toEqual(["cluster-a:/PersistentVolumeClaim/shop/db"]);
	});

	it("honours the reconciler's keep directive even under DELETE", async () => {
		const { hub, realizer } = setup("DEPARTURE_ACTION_DELETE");
		const v1 = [
			deployment("web", "img@sha256:aaaa"),
			deployment("worker", "img@sha256:cccc"),
		];
		await convergeTwice(hub, realizer, "camp-a", v1);
		const v2 = [deployment("web", "img@sha256:aaaa", 3)];
		await convergeTwice(hub, realizer, "camp-a", v2, { keep: ["worker"] });
		expect(hub.orphaned).toEqual(["cluster-a:apps/Deployment/shop/worker"]);
	});

	it("blocks with the agent's message when a manifest fails to apply", async () => {
		const { hub, realizer } = setup();
		hub.rejects.set(
			"apps/Deployment/shop/web",
			"admission webhook denied: image not signed",
		);
		const record = await convergeTwice(hub, realizer, "camp-a", [
			deployment("web", "img@sha256:aaaa"),
		]);
		expect(record.status).toBe(ReconcileStatus.BLOCKED);
		expect(record.reasons[0]?.code).toBe("ocm-work-apply-failed");
		expect(record.reasons[0]?.message).toContain("image not signed");
	});

	it("keeps converging while the workload reports fewer ready replicas than desired", async () => {
		const { hub, realizer } = setup();
		hub.readyReplicas = 0;
		const record = await convergeTwice(hub, realizer, "camp-a", [
			deployment("web", "img@sha256:aaaa", 3),
		]);
		expect(record.status).toBe(ReconcileStatus.CONVERGING);
		expect(record.reasons.map((r) => r.code)).toEqual([
			"kube-workload-not-ready",
		]);
		expect(record.resources[0]?.healthy).toBe(false);
	});

	it("treats omitted readyReplicas as zero ready, never CONVERGED", async () => {
		const { hub, realizer } = setup();
		hub.readyReplicas = 0;
		const record = await convergeTwice(hub, realizer, "camp-a", [
			deployment("web", "img@sha256:aaaa", 3),
		]);
		const [work] = hub.works("cluster-a");
		expect(JSON.stringify(work)).not.toContain("ReadyReplicas");
		expect(record.status).toBe(ReconcileStatus.CONVERGING);
		expect(record.resources[0]?.healthy).toBe(false);
	});

	it("never reports a workload with no status feedback as CONVERGED", async () => {
		const { hub, realizer } = setup();
		hub.wellKnownOff = true;
		const record = await convergeTwice(hub, realizer, "camp-a", [
			deployment("web", "img@sha256:aaaa"),
		]);
		expect(record.status).toBe(ReconcileStatus.CONVERGING);
		expect(record.reasons.map((r) => r.code)).toEqual(["ocm-feedback-missing"]);
		expect(record.resources[0]?.healthy).toBe(false);
	});

	it("uses the same physical id for a missing work as for an observed one", async () => {
		const { hub, realizer } = setup();
		const resources = [deployment("web", "img@sha256:aaaa")];
		const observed = await convergeTwice(hub, realizer, "camp-a", resources);
		hub.objects.clear();
		const drift = await realizer.observe(
			realizeInput("camp-a", resources),
			ctx,
		);
		expect(drift.resources[0]?.physicalId).toBe(
			observed.resources[0]?.physicalId,
		);
	});

	it("reads Job and Pod well-known feedback; missing values mean not ready", () => {
		expect(workloadReady("Job", { JobSucceeded: "true" })).toBe(true);
		expect(workloadReady("Job", { JobComplete: "true" })).toBe(true);
		expect(workloadReady("Job", { JobComplete: "false" })).toBe(false);
		expect(workloadReady("Job", {})).toBe(false);
		expect(
			workloadReady("Pod", { PodReady: "true", PodPhase: "Running" }),
		).toBe(true);
		expect(workloadReady("Pod", { PodPhase: "Running" })).toBe(false);
		expect(workloadReady("Deployment", { Replicas: "3" })).toBe(false);
		expect(workloadReady("Deployment", {})).toBe(false);
		expect(
			workloadReady("DaemonSet", {
				DesiredNumberScheduled: "2",
				NumberReady: "2",
			}),
		).toBe(true);
		expect(workloadReady("StatefulSet", { Replicas: "0" })).toBe(true);
		expect(workloadReady("ConfigMap", {})).toBe(true);
	});

	it("detects an out-of-band edit of the work as drift and repairs it on converge", async () => {
		const { hub, realizer } = setup();
		const resources = [deployment("web", "img@sha256:aaaa")];
		await convergeTwice(hub, realizer, "camp-a", resources);
		const [work] = hub.works("cluster-a");
		const original = JSON.stringify(work);
		expect(original).toContain('"replicas":2');
		const edited = parseJsonText(
			original.replace('"replicas":2', '"replicas":9'),
		);
		if (!isJsonObject(edited)) throw new Error("the hub holds no work");
		hub.objects.set(
			`work.open-cluster-management.io|manifestworks|cluster-a|${nameOf(work)}`,
			edited,
		);
		const drift = await realizer.observe(
			realizeInput("camp-a", resources),
			ctx,
		);
		expect(drift.status).toBe(ReconcileStatus.DRIFTED);
		expect(drift.reasons.map((r) => r.code)).toEqual(["ocm-work-modified"]);
		expect(drift.resources[0]?.driftKind).toBe("modified");
		const repaired = await convergeTwice(hub, realizer, "camp-a", resources);
		expect(repaired.status).toBe(ReconcileStatus.CONVERGED);
	});

	it("reports a work deleted on the hub as drift", async () => {
		const { hub, realizer } = setup();
		const resources = [deployment("web", "img@sha256:aaaa")];
		await convergeTwice(hub, realizer, "camp-a", resources);
		hub.objects.clear();
		const drift = await realizer.observe(
			realizeInput("camp-a", resources),
			ctx,
		);
		expect(drift.status).toBe(ReconcileStatus.DRIFTED);
		expect(drift.reasons[0]?.code).toBe("ocm-work-missing");
	});

	it("re-stamps the fence after a lease change without changing the manifests", async () => {
		const { hub, realizer } = setup();
		const resources = [deployment("web", "img@sha256:aaaa")];
		await convergeTwice(hub, realizer, "camp-a", resources, { fence: 7n });
		const before = hub.works("cluster-a")[0];
		const record = await realizer.converge(
			realizeInput("camp-a", resources, { fence: 8n }),
			ctx,
		);
		const after = hub.works("cluster-a")[0];
		expect(annotationsOf(after)["hobo.dev/fence"]).toBe("8");
		expect(specOf(after ?? {}).workload).toEqual(specOf(before ?? {}).workload);
		expect(record.status).toBe(ReconcileStatus.CONVERGED);
	});
});
