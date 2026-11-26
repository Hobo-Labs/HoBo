import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrincipalRef } from "@hobo/core";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	collectStream,
	DEPLOYMENT_PLAN_SCHEMA,
	topologyViewProjection,
} from "../src/index.js";

// E21 TopologyView projection: the app-graph read model beside deployment-view,
// folding the SAME deployment stream into nodes (bindle/resources/yards) and
// edges (bindings/placements). Deterministic golden: a fixed event fixture
// folds to byte-stable JSON; rebuild-from-zero equals the live fold (the log
// is authoritative).

const actor: PrincipalRef = { kind: "user", id: "user/topo-tester" };
const DEPLOYMENT = "topo-1";
const STREAM = `deployment:${DEPLOYMENT}`;
const PROVIDER = "@hobo/provider-cloudflare";

let stores: RuntimeLocalEventStore[] = [];
function freshStore(): RuntimeLocalEventStore {
	const dir = mkdtempSync(join(tmpdir(), "hobo-topology-view-"));
	const store = createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
	stores.push(store);
	return store;
}
afterEach(() => {
	for (const store of stores) store.close();
	stores = [];
});

// A fixed deployment trail: requested -> matched -> planned -> provisioned.
function deploymentTrail() {
	return [
		{
			type: "deployment.Requested",
			data: {
				deploymentId: DEPLOYMENT,
				bindleHash: "sha256:bindle-golden",
				tenant: "tenant-a",
				config: {},
			},
		},
		{
			type: "match.Decided",
			data: {
				deploymentId: DEPLOYMENT,
				resource: "service",
				winner: `${PROVIDER}.compute`,
				providerId: PROVIDER,
				port: "compute",
				region: "us-east-1",
			},
		},
		{
			type: "match.Decided",
			data: {
				deploymentId: DEPLOYMENT,
				resource: "sessions",
				winner: `${PROVIDER}.kv`,
				providerId: PROVIDER,
				port: "kv",
				region: "us-east-1",
			},
		},
		{
			type: "deployment.Planned",
			data: {
				deploymentId: DEPLOYMENT,
				planHash: "sha256:plan-golden",
				plan: {
					schema: DEPLOYMENT_PLAN_SCHEMA,
					resources: [
						{
							name: "service",
							port: "compute",
							provider: PROVIDER,
							deps: ["sessions"],
							region: "us-east-1",
						},
						{
							name: "sessions",
							port: "kv",
							provider: PROVIDER,
							deps: [],
							region: "us-east-1",
						},
					],
					dependencyOrder: ["sessions", "service"],
					objective: "min-cost",
				},
			},
		},
		{
			type: "resource.Provisioning",
			data: {
				deploymentId: DEPLOYMENT,
				resourceId: "sessions",
				execId: "exec-1",
				programHash: "sha256:prog-1",
			},
		},
		{
			type: "resource.Provisioned",
			data: {
				deploymentId: DEPLOYMENT,
				resourceId: "sessions",
				outputs: {},
				execId: "exec-1",
			},
		},
		{
			type: "resource.Provisioned",
			data: {
				deploymentId: DEPLOYMENT,
				resourceId: "service",
				outputs: {},
				execId: "exec-2",
			},
		},
	];
}

async function appendTrail(store: RuntimeLocalEventStore): Promise<void> {
	await store.append(STREAM, deploymentTrail(), {
		expectedSeq: 0,
		actor,
		tenant: "tenant-a",
	});
}

// The byte-stable golden app graph the fixed trail folds to.
const GOLDEN_ROW = {
	deploymentId: DEPLOYMENT,
	nodes: [
		{
			id: `bindle:${DEPLOYMENT}`,
			kind: "bindle",
			label: "sha256:bindle-golden",
		},
		{
			id: "resource:service",
			kind: "resource",
			label: "service",
			providerId: PROVIDER,
			port: "compute",
			region: "us-east-1",
			lifecycle: "provisioned",
		},
		{
			id: "resource:sessions",
			kind: "resource",
			label: "sessions",
			providerId: PROVIDER,
			port: "kv",
			region: "us-east-1",
			lifecycle: "provisioned",
		},
		{
			id: `yard:${PROVIDER}`,
			kind: "yard",
			label: PROVIDER,
		},
	],
	edges: [
		{
			from: "resource:service",
			to: "resource:sessions",
			kind: "binding",
		},
		{
			from: "resource:service",
			to: `yard:${PROVIDER}`,
			kind: "placement",
			region: "us-east-1",
		},
		{
			from: "resource:sessions",
			to: `yard:${PROVIDER}`,
			kind: "placement",
			region: "us-east-1",
		},
	],
	bindleHash: "sha256:bindle-golden",
};

describe("TopologyView projection: app graph folded from the deployment stream", () => {
	it("folds the fixed trail to the byte-stable golden graph", async () => {
		const store = freshStore();
		await appendTrail(store);
		const events = await collectStream(store, STREAM);

		const snapshot = topologyViewProjection.fold(events);
		const row = topologyViewProjection.get(snapshot, DEPLOYMENT);
		expect(row).toEqual(GOLDEN_ROW);

		// Byte-stable: two independent folds serialize identically.
		const again = topologyViewProjection.get(
			topologyViewProjection.fold(events),
			DEPLOYMENT,
		);
		expect(JSON.stringify(again)).toBe(JSON.stringify(row));
	});

	it("rebuilds from zero identically to the live fold (the log is authoritative)", async () => {
		const store = freshStore();
		await appendTrail(store);
		const events = await collectStream(store, STREAM);

		let live = topologyViewProjection.fold(events.slice(0, 1));
		for (let i = 2; i <= events.length; i += 1) {
			live = topologyViewProjection.fold(events.slice(0, i));
		}
		const rebuilt = await topologyViewProjection.rebuildFromZero(store, STREAM);
		expect(JSON.stringify(rebuilt.rows)).toBe(JSON.stringify(live.rows));
	});

	it("tracks resource lifecycle transitions on the graph nodes", async () => {
		const store = freshStore();
		await store.append(
			STREAM,
			[
				...deploymentTrail(),
				{
					type: "resource.Failed",
					data: {
						deploymentId: DEPLOYMENT,
						resourceId: "service",
						reason: "quota",
						classification: "fatal",
						crossedNoGoThreshold: true,
					},
				},
			],
			{ expectedSeq: 0, actor, tenant: "tenant-a" },
		);
		const snapshot = topologyViewProjection.fold(
			await collectStream(store, STREAM),
		);
		const row = topologyViewProjection.get(snapshot, DEPLOYMENT);
		const service = row?.nodes.find((node) => node.id === "resource:service");
		expect(service?.lifecycle).toBe("failed");
	});

	it("materializes an imported estate as provisioned resources under the bindle", async () => {
		const store = freshStore();
		await store.append(
			"deployment:imported-1",
			[
				{
					type: "deployment.Imported",
					data: {
						deploymentId: "imported-1",
						bindleHash: "sha256:imported-bindle",
						resources: ["legacy-db", "legacy-web"],
					},
				},
			],
			{ expectedSeq: 0, actor, tenant: "tenant-a" },
		);
		const snapshot = topologyViewProjection.fold(
			await collectStream(store, "deployment:imported-1"),
		);
		const row = topologyViewProjection.get(snapshot, "imported-1");
		expect(row?.nodes.map((node) => node.id)).toEqual([
			"bindle:imported-1",
			"resource:legacy-db",
			"resource:legacy-web",
		]);
		for (const node of row?.nodes ?? []) {
			if (node.kind === "resource") expect(node.lifecycle).toBe("provisioned");
		}
	});
});
