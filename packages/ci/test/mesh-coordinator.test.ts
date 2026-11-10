import { describe, expect, it } from "vitest";
import {
	createMemoryMesh,
	createMeshCoordinator,
	type MeshBoard,
	type MeshClaims,
	type MeshEvent,
	type MeshJob,
	type MeshNode,
} from "../src/mesh/index.js";

const START = 1_800_000_000_000;

const node = (id: string, freeSlots = 2): MeshNode => ({
	id,
	freeSlots,
	healthy: true,
	labels: ["hobo"],
	validUntilMs: START + 3_600_000,
});

const job = (jobId: number): MeshJob => ({
	jobId,
	label: "hobo",
	queuedAtMs: START,
});

const JOBS = Array.from({ length: 600 }, (_, index) => job(50_000 + index));

function mesh(
	nodes: readonly MeshNode[],
	ports: { board: MeshBoard; claims: MeshClaims },
	clock: { now: number },
) {
	const events: { node: string; event: MeshEvent }[] = [];
	const coordinators = new Map(
		nodes.map((self) => [
			self.id,
			createMeshCoordinator({
				self: () => self,
				board: ports.board,
				claims: ports.claims,
				stepMs: 20_000,
				now: () => clock.now,
				log: (event) => events.push({ node: self.id, event }),
			}),
		]),
	);
	return { coordinators, events };
}

/**
 * Each tick, every live node walks the queue in order, one job at a time, as
 * the worker's poller does; the nodes themselves run side by side.
 */
async function run(
	coordinators: ReadonlyMap<string, ReturnType<typeof createMeshCoordinator>>,
	clock: { now: number },
	ticks: number,
	alive: (id: string) => boolean = () => true,
) {
	const started = new Map<number, string[]>();
	for (let tick = 0; tick < ticks; tick += 1) {
		await Promise.all(
			[...coordinators]
				.filter(([id]) => alive(id))
				.map(async ([id, coordinator]) => {
					for (const each of JOBS) {
						if ((started.get(each.jobId) ?? []).includes(id)) continue;
						const decision = await coordinator.shouldStart(each);
						if (decision.start)
							started.set(each.jobId, [...(started.get(each.jobId) ?? []), id]);
					}
				}),
		);
		clock.now += 5_000;
	}
	return started;
}

describe("mesh coordinator", () => {
	it("starts every job on exactly one node, in proportion to capacity", async () => {
		const clock = { now: START };
		const nodes = [node("small", 1), node("medium", 2), node("large", 5)];
		const ports = createMemoryMesh({ now: () => clock.now });
		const { coordinators } = mesh(nodes, ports, clock);
		for (const coordinator of coordinators.values())
			await coordinator.advertise();
		const started = await run(coordinators, clock, 1);
		expect(started.size).toBe(JOBS.length);
		expect([...started.values()].every((ids) => ids.length === 1)).toBe(true);
		const share = (id: string) =>
			[...started.values()].filter((ids) => ids[0] === id).length / JOBS.length;
		expect(Math.abs(share("small") - 1 / 8)).toBeLessThan(0.05);
		expect(Math.abs(share("medium") - 2 / 8)).toBeLessThan(0.05);
		expect(Math.abs(share("large") - 5 / 8)).toBeLessThan(0.05);
	});

	it("hands a dead node's jobs to the others one step later, still exactly once", async () => {
		const clock = { now: START };
		const nodes = [node("a"), node("b"), node("c")];
		const ports = createMemoryMesh({ now: () => clock.now });
		const { coordinators } = mesh(nodes, ports, clock);
		for (const coordinator of coordinators.values())
			await coordinator.advertise();
		// "b" advertised and then died: it never polls.
		const first = await run(coordinators, clock, 1, (id) => id !== "b");
		expect(first.size).toBeLessThan(JOBS.length);
		const all = await run(coordinators, clock, 5, (id) => id !== "b");
		const everything = new Map([...first, ...all]);
		expect(everything.size).toBe(JOBS.length);
		expect(
			[...everything.values()].every(
				(ids) => ids.length === 1 && ids[0] !== "b",
			),
		).toBe(true);
	});

	it("starts every job by ranking alone when the claim store is down", async () => {
		const clock = { now: START };
		const nodes = [node("a"), node("b"), node("c")];
		const memory = createMemoryMesh({ now: () => clock.now });
		let attempts = 0;
		const { coordinators, events } = mesh(
			nodes,
			{
				board: memory.board,
				claims: {
					tryClaim: async () => {
						attempts += 1;
						throw new Error("NATS not connected");
					},
				},
			},
			clock,
		);
		for (const coordinator of coordinators.values())
			await coordinator.advertise();
		const started = await run(coordinators, clock, 1);
		// Complete views and no store: the ranking alone still picks one node.
		expect(started.size).toBe(JOBS.length);
		expect([...started.values()].every((ids) => ids.length === 1)).toBe(true);
		// One failed attempt per node, then the store is left alone for a while.
		expect(attempts).toBe(3);
		expect(events.map((entry) => entry.event)).toEqual([
			"hobo_ci_mesh_claims_unreachable",
			"hobo_ci_mesh_claims_unreachable",
			"hobo_ci_mesh_claims_unreachable",
		]);
	});

	it("keeps its last view when the board fails and reports the recovery once", async () => {
		const clock = { now: START };
		const memory = createMemoryMesh({ now: () => clock.now });
		let boardUp = true;
		const events: MeshEvent[] = [];
		const self = node("a");
		const coordinator = createMeshCoordinator({
			self: () => self,
			board: {
				advertise: memory.board.advertise,
				nodes: async () => {
					if (!boardUp) throw new Error("timeout");
					return memory.board.nodes();
				},
			},
			claims: memory.claims,
			stepMs: 20_000,
			now: () => clock.now,
			log: (event) => events.push(event),
		});
		await memory.board.advertise(node("b", 64));
		const before = await Promise.all(
			JOBS.slice(0, 50).map((each) => coordinator.shouldStart(each)),
		);
		// "b" has far more capacity, so most jobs are its turn first.
		expect(before.filter((decision) => !decision.start).length).toBeGreaterThan(
			40,
		);
		boardUp = false;
		clock.now += 6_000;
		const during = await Promise.all(
			JOBS.slice(50, 100).map((each) => coordinator.shouldStart(each)),
		);
		// The last view still holds "b": this node keeps deferring to it.
		expect(during.filter((decision) => !decision.start).length).toBeGreaterThan(
			40,
		);
		boardUp = true;
		clock.now += 6_000;
		await coordinator.shouldStart(job(1));
		expect(events).toEqual([
			"hobo_ci_mesh_board_unreachable",
			"hobo_ci_mesh_board_recovered",
		]);
	});

	it("answers a second poll of a job it holds without asking the store again", async () => {
		const clock = { now: START };
		const memory = createMemoryMesh({ now: () => clock.now });
		let asked = 0;
		const self = node("a");
		const coordinator = createMeshCoordinator({
			self: () => self,
			board: memory.board,
			claims: {
				tryClaim: async (jobId, nodeId) => {
					asked += 1;
					return memory.claims.tryClaim(jobId, nodeId);
				},
			},
			now: () => clock.now,
		});
		expect((await coordinator.shouldStart(job(9))).start).toBe(true);
		expect((await coordinator.shouldStart(job(9))).start).toBe(true);
		expect(asked).toBe(1);
	});

	it("frees a claimed job for another node once the claim expires", async () => {
		const clock = { now: START };
		const { claims } = createMemoryMesh({
			now: () => clock.now,
			claimTtlMs: 120_000,
		});
		expect(await claims.tryClaim(1, "a")).toBe("claimed");
		expect(await claims.tryClaim(1, "b")).toBe("held");
		expect(await claims.tryClaim(1, "a")).toBe("claimed");
		clock.now += 120_000;
		expect(await claims.tryClaim(1, "b")).toBe("claimed");
		expect(await claims.tryClaim(1, "a")).toBe("held");
	});

	it("does not advertise or start when the board rejects, and does not throw", async () => {
		const self = node("a");
		const coordinator = createMeshCoordinator({
			self: () => self,
			board: {
				advertise: async () => {
					throw new Error("down");
				},
				nodes: async () => {
					throw new Error("down");
				},
			},
			claims: createMemoryMesh().claims,
			now: () => START,
		});
		expect(await coordinator.advertise()).toBe(false);
		// Knowing no one, it ranks alone and starts.
		expect(await coordinator.shouldStart(job(3))).toMatchObject({
			start: true,
			reason: "claimed",
		});
	});
});
