import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CampConditionRecord,
	CampConditionType,
	type CampInventory,
	CampManagement,
	ConditionStatus,
	ReconcileStatus,
	SignalSource,
} from "@hobo/cd";
import type { JsonObject, TransportRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	clusterProfileInventory,
	parseClusterProfileImport,
} from "../src/index.js";
import { FakeHub } from "./fake-hub.js";
import {
	credentials,
	ctx,
	HUB_TOKEN,
	hub,
	now,
	recordingSink,
} from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
// SAFETY: test fixture file is a ClusterProfileList JSON object.
const LIST = JSON.parse(
	readFileSync(join(here, "fixtures/cluster-profiles.list.json"), "utf8"),
) as { items: JsonObject[] };
const GROUP = "multicluster.x-k8s.io";

const importConfig = (extra: JsonObject = {}) =>
	parseClusterProfileImport({
		schemaVersion: "hobo.cd-kube-fleet.cluster-profiles/v1",
		hub: hub("HUB_KIND_CLUSTER_INVENTORY", "inventory"),
		namespace: "fleet-system",
		yardId: "yard-eu",
		stationId: "station-eu",
		provider: "kubernetes",
		envType: "prod",
		regions: ["eu-west-1"],
		campIdPrefix: "k8s-",
		...extra,
	});

function seeded(): FakeHub {
	const h = new FakeHub();
	for (const item of LIST.items) h.put(GROUP, "clusterprofiles", item);
	return h;
}

function setup(h = seeded(), extra: JsonObject = {}, token = HUB_TOKEN) {
	const sink = recordingSink();
	const creds = credentials(token);
	const inventory = clusterProfileInventory({
		config: importConfig(extra),
		http: h.transport,
		credentials: creds,
		now,
		telemetry: sink,
		delay: async () => {},
	});
	return { h, inventory, sink, creds };
}

describe("clusterProfileInventory", () => {
	it("ClusterProfile import yields OBSERVE_ONLY Camps with declared topology only", async () => {
		const { inventory } = setup();
		const snapshot = await inventory.list();
		expect(snapshot.camps.map((c) => c.topology.campId)).toEqual([
			"k8s-fleet-system-edge-lyon-02",
			"k8s-fleet-system-edge-paris-01",
		]);
		for (const camp of snapshot.camps) {
			expect(camp.topology.management).toBe(CampManagement.OBSERVE_ONLY);
			// Regions come from the import declaration, never from a profile claim (I19).
			expect(camp.topology.regions).toEqual(["eu-west-1"]);
			expect(camp.topology).toMatchObject({
				yardId: "yard-eu",
				stationId: "station-eu",
				provider: "kubernetes",
				envType: "prod",
			});
		}
		expect(snapshot.skipped.map((r) => r.code)).toEqual([
			"clusterprofile-invalid",
		]);
		expect(await inventory.topology().camps()).toEqual(
			snapshot.camps.map((c) => c.topology),
		);
		expect(
			(
				await inventory
					.topology()
					.camp(snapshot.camps[1]?.topology.campId ?? ("" as never))
			)?.campId,
		).toBe("k8s-fleet-system-edge-paris-01");
	});

	it("maps properties, labels and the version to claims attributed to the cluster manager", async () => {
		const { inventory } = setup();
		const { camps } = await inventory.list();
		const paris = camps.find((c) => c.topology.campId.endsWith("paris-01"));
		expect(paris?.claims.map((c) => [c.name, c.value, c.reportedBy])).toEqual([
			["label:env", "prod", "service:cluster-manager/open-cluster-management"],
			[
				"region",
				"eu-west-3",
				"service:cluster-manager/open-cluster-management",
			],
			[
				"label:x-k8s.io/cluster-manager",
				"ocm",
				"service:cluster-manager/open-cluster-management",
			],
			[
				"kubernetes.version",
				"1.31.4",
				"service:cluster-manager/open-cluster-management",
			],
			[
				"clusterset.k8s.io",
				"retail-eu",
				"service:cluster-manager/open-cluster-management",
			],
			["cpu", "64", "service:cluster-manager/open-cluster-management"],
		]);
		expect(
			paris?.claims.find((c) => c.name === "clusterset.k8s.io")?.observedAt,
		).toBe("2026-11-12T09:58:00Z");
	});

	it("maps ControlPlaneHealthy to READY from a health source, never a Station signal", async () => {
		const { inventory } = setup();
		const { camps } = await inventory.list();
		const lyon = camps.find((c) => c.topology.campId.endsWith("lyon-02"));
		expect(
			lyon?.conditions.map((c: CampConditionRecord) => [
				c.type,
				c.status,
				c.source,
				c.reason,
			]),
		).toEqual([
			[
				CampConditionType.READY,
				ConditionStatus.FALSE,
				SignalSource.HEALTH_SOURCE,
				"clusterprofile:APIServerUnreachable",
			],
		]);
	});

	it("publishes conditions and claims through CampInventory.observe", async () => {
		const { inventory } = setup();
		await inventory.list();
		const calls: Parameters<CampInventory["observe"]>[0][] = [];
		const fake = {
			async observe(input: Parameters<CampInventory["observe"]>[0]) {
				calls.push(input);
				return { ok: false as const, reasons: [] };
			},
		} as Partial<CampInventory> as CampInventory;
		await inventory.publish(fake, ctx);
		expect(calls.map((c) => [c.campId, c.source])).toEqual([
			["k8s-fleet-system-edge-lyon-02", SignalSource.HEALTH_SOURCE],
			["k8s-fleet-system-edge-paris-01", SignalSource.HEALTH_SOURCE],
		]);
	});

	it("reports an OBSERVED record posture can evaluate, trimmed to observe_fields", async () => {
		const { inventory } = setup();
		await inventory.list();
		const record = await inventory.observation(
			"k8s-fleet-system-edge-paris-01",
			["kubernetes.version", "label.env", "property.cpu", "missing.field"],
			ctx,
		);
		expect(record?.status).toBe(ReconcileStatus.OBSERVED);
		expect(record?.resources).toHaveLength(1);
		const [resource] = record?.resources ?? [];
		// The posture evaluator's input shape (PostureResource): resource, kind, classification, attributes.
		expect({
			resource: resource?.resource,
			kind: resource?.kind,
			classification: resource?.classification,
			attributes: resource?.attributes,
		}).toEqual({
			resource: "cluster",
			kind: "kubernetes-cluster",
			classification: "",
			attributes: {
				"kubernetes.version": "1.31.4",
				"label.env": "prod",
				"property.cpu": "64",
			},
		});
		expect(record?.observedAt).toBe("2026-11-12T10:00:00.000Z");
		expect(
			await inventory.observation("k8s-unknown", ["x"], ctx),
		).toBeUndefined();
	});

	it("resolves access-provider credentials host-side and never records them", async () => {
		const { inventory, sink, creds } = setup(seeded(), {}, HUB_TOKEN);
		const snapshot = await inventory.list();
		const access = await inventory.access(
			"k8s-fleet-system-edge-paris-01",
			ctx,
		);
		expect(access.server).toBe("https://edge-paris-01.example:6443");
		expect(access.headers.authorization).toBe(`Bearer ${HUB_TOKEN}`);
		expect(creds.calls.at(-1)).toEqual([
			"clusterprofile/fleet-system/edge-paris-01/ocm-token-provider",
			"kube-exec:ocm-token-provider",
		]);
		const recorded = JSON.stringify({
			snapshot: snapshot.camps.map((c) => ({
				record: c.record,
				claims: c.claims,
				conditions: c.conditions,
				topology: c.topology,
			})),
			points: sink.points,
		});
		expect(recorded).not.toContain(HUB_TOKEN);
		expect(recorded).not.toContain("certificate-authority-data");
		expect(recorded).not.toContain("edge-paris-01.example");
		expect(
			snapshot.camps.find((c) => c.topology.campId.endsWith("paris-01"))?.record
				.accessProviders,
		).toEqual(["ocm-token-provider"]);
		await expect(
			inventory.access("k8s-fleet-system-edge-lyon-02", ctx),
		).rejects.toMatchObject({ code: "clusterprofile-access-missing" });
		await expect(inventory.access("k8s-nope", ctx)).rejects.toMatchObject({
			code: "clusterprofile-unknown",
		});
	});

	it("refuses an expired exec credential before sending it", async () => {
		const h = seeded();
		const inventory = clusterProfileInventory({
			config: importConfig(),
			http: h.transport,
			credentials: {
				resolve: async () => ({
					token: HUB_TOKEN,
					expirationTimestamp: "2026-11-12T09:00:00Z",
				}),
			},
			now,
		});
		await expect(inventory.list()).rejects.toMatchObject({
			code: "kube-credential-expired",
		});
		expect(h.log).toHaveLength(0);
	});

	it("skips two profiles that map to one Camp id, with a collision reason", async () => {
		const h = new FakeHub();
		h.put(GROUP, "clusterprofiles", {
			kind: "ClusterProfile",
			metadata: { name: "b-c", namespace: "fleet-system" },
		});
		h.put(GROUP, "clusterprofiles", {
			kind: "ClusterProfile",
			metadata: { name: "c", namespace: "fleet-system-b" },
		});
		const { inventory } = setup(h, { namespace: "" });
		const snapshot = await inventory.list();
		expect(snapshot.camps).toHaveLength(1);
		expect(snapshot.skipped.map((r) => r.code)).toEqual([
			"clusterprofile-camp-collision",
		]);
	});

	it("pages with continue tokens and sends the label selector", async () => {
		const requests: string[] = [];
		const items = LIST.items.slice(0, 2);
		const http = async (request: TransportRequest) => {
			const url = new URL(request.url);
			requests.push(url.search);
			const page = url.searchParams.get("continue") === null ? 0 : 1;
			return {
				status: 200,
				headers: {},
				body: JSON.stringify({
					metadata: {
						resourceVersion: "9",
						...(page === 0 ? { continue: "tok-1" } : undefined),
					},
					items: [items[page]],
				}),
			};
		};
		const inventory = clusterProfileInventory({
			config: importConfig({ labelSelector: { env: "prod" } }),
			http,
			credentials: credentials(),
			now,
		});
		const snapshot = await inventory.list();
		expect(snapshot.camps).toHaveLength(2);
		expect(snapshot.resourceVersion).toBe("9");
		expect(requests).toEqual([
			"?labelSelector=env%3Dprod&limit=500",
			"?continue=tok-1&labelSelector=env%3Dprod&limit=500",
		]);
	});

	it("watches from the list resourceVersion, follows bookmarks and re-lists after 410 Gone", async () => {
		const h = seeded();
		const { inventory, sink } = setup(h);
		const snapshot = await inventory.list();
		const paris = LIST.items[0] ?? {};
		const added = {
			kind: "ClusterProfile",
			metadata: {
				name: "edge-nice-03",
				namespace: "fleet-system",
				resourceVersion: "50001",
			},
			status: {},
		};
		h.watchQueue.push({
			status: 200,
			events: [
				{ type: "ADDED", object: added },
				{
					type: "BOOKMARK",
					object: {
						kind: "ClusterProfile",
						metadata: { resourceVersion: "50002" },
					},
				},
				{
					type: "DELETED",
					object: {
						...paris,
						metadata: {
							...(paris.metadata as JsonObject),
							resourceVersion: "50003",
						},
					},
				},
			],
		});
		h.watchQueue.push({ status: 410 });
		const controller = new AbortController();
		const changes: string[] = [];
		for await (const change of inventory.watch({
			signal: controller.signal,
			resourceVersion: snapshot.resourceVersion,
		})) {
			changes.push(`${change.type}:${change.campId}:${change.resync}`);
			if (change.resync) controller.abort();
		}
		expect(changes.slice(0, 2)).toEqual([
			"ADDED:k8s-fleet-system-edge-nice-03:false",
			"DELETED:k8s-fleet-system-edge-paris-01:false",
		]);
		// After 410 the re-list restores the hub's truth: paris is back, nice-03 (never stored on the hub) is gone.
		expect(changes.slice(2)).toEqual([
			"ADDED:k8s-fleet-system-edge-paris-01:true",
			"DELETED:k8s-fleet-system-edge-nice-03:true",
		]);
		const watches = h.log.filter((l) => l.query.includes("watch=1"));
		expect(watches[0]?.query).toContain(
			`resourceVersion=${snapshot.resourceVersion}`,
		);
		expect(watches[0]?.query).toContain("allowWatchBookmarks=true");
		expect(watches[1]?.query).toContain("resourceVersion=50003");
		expect(
			sink.points.some((p) => p.name === "hobo.cd.kube_fleet.watch.relists"),
		).toBe(true);
	});
});
