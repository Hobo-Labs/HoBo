import { describe, expect, it } from "vitest";
import {
	createMemoryMesh,
	createMemoryMeshConfig,
	createMeshMonitor,
	type MeshNode,
	meshCapacity,
	meshLeaderId,
} from "../src/mesh/index.js";

const NOW = 1_800_000_000_000;

const node = (id: string, overrides: Partial<MeshNode> = {}): MeshNode => ({
	id,
	freeSlots: 2,
	totalSlots: 4,
	healthy: true,
	labels: ["hobo"],
	validUntilMs: NOW + 45_000,
	...overrides,
});

function watch(selfId: string) {
	const clock = { now: NOW };
	const { board } = createMemoryMesh({ now: () => clock.now });
	const events: { event: string; nodeId?: unknown; freeSlots?: unknown }[] = [];
	const monitor = createMeshMonitor({
		selfId,
		board,
		now: () => clock.now,
		log: (event, fields) =>
			events.push({
				event,
				nodeId: fields.nodeId,
				freeSlots: fields.freeSlots,
			}),
	});
	const names = () => events.map((entry) => entry.event);
	return { board, clock, monitor, events, names };
}

describe("meshCapacity", () => {
	it("counts live, healthy and available nodes and their slots", () => {
		expect(
			meshCapacity(
				[
					node("a", {
						freeSlots: 1,
						totalSlots: 4,
						free: { memoryMb: 6_000, diskMb: 50_000 },
					}),
					node("b", { freeSlots: 0, totalSlots: 2, free: { memoryMb: 2_000 } }),
					// A failed signature: the advertisement is nobody's capacity.
					node("forged", {
						trust: "invalid",
						freeSlots: 64,
						free: { memoryMb: 512_000, diskMb: 900_000 },
					}),
					// Unhealthy: neither its slots nor its memory count.
					node("c", {
						healthy: false,
						freeSlots: 3,
						free: { memoryMb: 9_999 },
					}),
					node("d", { validUntilMs: NOW }),
					// No total advertised: its free slots are all that is known.
					node("e", { freeSlots: 2, totalSlots: undefined }),
				],
				NOW,
			),
		).toEqual({
			nodes: 4,
			healthy: 3,
			available: 2,
			totalSlots: 8,
			freeSlots: 3,
			// Node e reports no memory: it adds nothing rather than a guess.
			freeMemoryMb: 8_000,
			largestFreeMemoryMb: 6_000,
			// Only node a measures its disk.
			freeDiskMb: 50_000,
		});
	});
});

describe("createMeshMonitor", () => {
	it("takes its first reading as the baseline and summarises it", async () => {
		const { board, monitor, events } = watch("a");
		await board.advertise(node("a"));
		await board.advertise(node("b"));
		expect(await monitor.observe()).toMatchObject({ nodes: 2, freeSlots: 4 });
		expect(events).toEqual([
			{ event: "hobo_ci_mesh_capacity", nodeId: undefined, freeSlots: 4 },
		]);
	});

	it("reports a node joining, turning unhealthy, recovering and disappearing", async () => {
		const { board, clock, monitor, events, names } = watch("a");
		await board.advertise(node("a"));
		await monitor.observe();
		events.length = 0;

		await board.advertise(node("b"));
		await monitor.observe();
		expect(events[0]).toMatchObject({
			event: "hobo_ci_mesh_node_joined",
			nodeId: "b",
		});

		await board.advertise(node("b", { healthy: false }));
		await monitor.observe();
		await board.advertise(node("b", { healthy: true }));
		await monitor.observe();
		// "b" stops advertising; its entry expires.
		clock.now += 46_000;
		await board.advertise(node("a", { validUntilMs: clock.now + 45_000 }));
		await monitor.observe();
		expect(names().filter((name) => name !== "hobo_ci_mesh_capacity")).toEqual([
			"hobo_ci_mesh_node_joined",
			"hobo_ci_mesh_node_unhealthy",
			"hobo_ci_mesh_node_recovered",
			"hobo_ci_mesh_node_lost",
		]);
		expect(events.at(-2)).toMatchObject({
			event: "hobo_ci_mesh_node_lost",
			nodeId: "b",
		});
	});

	it("says when the mesh has no free slot left, and when it has one again", async () => {
		const { board, monitor, events, names } = watch("a");
		await board.advertise(node("a", { freeSlots: 1 }));
		await board.advertise(node("b", { freeSlots: 1 }));
		await monitor.observe();
		events.length = 0;
		await board.advertise(node("a", { freeSlots: 0 }));
		await monitor.observe();
		// One node still has room: not exhausted.
		expect(names()).not.toContain("hobo_ci_mesh_capacity_exhausted");
		await board.advertise(node("b", { freeSlots: 0 }));
		await monitor.observe();
		await monitor.observe();
		await board.advertise(node("b", { freeSlots: 2 }));
		await monitor.observe();
		expect(
			names().filter((name) => name.startsWith("hobo_ci_mesh_capacity_")),
		).toEqual([
			"hobo_ci_mesh_capacity_exhausted",
			"hobo_ci_mesh_capacity_restored",
		]);
	});

	it("leaves reporting to the lowest live node, and takes over when it dies", async () => {
		const a = watch("a");
		const events: string[] = [];
		const monitorB = createMeshMonitor({
			selfId: "b",
			board: a.board,
			now: () => a.clock.now,
			log: (event) => events.push(event),
		});
		await a.board.advertise(node("a"));
		await a.board.advertise(node("b"));
		await a.monitor.observe();
		await monitorB.observe();
		await a.board.advertise(node("c"));
		await a.monitor.observe();
		await monitorB.observe();
		// "a" is the lowest id: it reports; "b" watches in silence.
		expect(a.names()).toContain("hobo_ci_mesh_node_joined");
		expect(events).toEqual([]);
		// "a" dies. "b" is now the lowest live node and reports the loss.
		a.clock.now += 46_000;
		for (const id of ["b", "c"])
			await a.board.advertise(node(id, { validUntilMs: a.clock.now + 45_000 }));
		await monitorB.observe();
		expect(events).toContain("hobo_ci_mesh_node_lost");
	});

	it("summarises on a schedule when nothing changes, and stays quiet between", async () => {
		const { board, clock, monitor, names } = watch("a");
		await board.advertise(node("a", { validUntilMs: NOW + 300_000 }));
		await monitor.observe();
		await monitor.observe();
		clock.now += 59_000;
		await monitor.observe();
		expect(names()).toEqual(["hobo_ci_mesh_capacity"]);
		clock.now += 1_000;
		await monitor.observe();
		expect(names()).toEqual(["hobo_ci_mesh_capacity", "hobo_ci_mesh_capacity"]);
	});

	it("returns nothing and reports nothing when the board cannot be read", async () => {
		const events: string[] = [];
		const monitor = createMeshMonitor({
			selfId: "a",
			board: {
				advertise: async () => undefined,
				nodes: async () => {
					throw new Error("NATS not connected");
				},
			},
			log: (event) => events.push(event),
		});
		expect(await monitor.observe()).toBeUndefined();
		expect(events).toEqual([]);
	});
});

describe("createMemoryMeshConfig", () => {
	it("stores once, then only replaces the revision it was told about", async () => {
		const config = createMemoryMeshConfig();
		expect(await config.read()).toBeUndefined();
		expect(await config.publish("one")).toEqual({ revision: 1 });
		// A second first-publish of something else loses; of the same thing, agrees.
		expect(await config.publish("other")).toBe("conflict");
		expect(await config.publish("one")).toEqual({ revision: 1 });
		expect(await config.publish("two", 1)).toEqual({ revision: 2 });
		expect(await config.publish("three", 1)).toBe("conflict");
		expect(await config.read()).toEqual({ value: "two", revision: 2 });
	});
});

describe("meshLeaderId", () => {
	it("is the live node with the lowest id, never an expired or forged one", () => {
		expect(meshLeaderId([node("node-b"), node("node-c")], NOW, "node-c")).toBe(
			"node-b",
		);
		expect(
			meshLeaderId(
				[
					node("node-a", { validUntilMs: NOW - 1 }),
					node("node-0", { trust: "invalid" }),
					node("node-c"),
				],
				NOW,
				"node-c",
			),
		).toBe("node-c");
	});

	it("a node that sees no live node leads itself", () => {
		expect(meshLeaderId([], NOW, "solo")).toBe("solo");
	});
});
