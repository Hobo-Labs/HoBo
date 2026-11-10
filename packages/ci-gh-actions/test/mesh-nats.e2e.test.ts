/**
 * The mesh against a real NATS server.
 *
 * Runs when a `nats-server` binary is available: `HOBO_CI_NATS_SERVER_BIN`,
 * or `nats-server` on PATH. Skipped otherwise, so the suite does not need
 * the binary; the same behaviour is covered on the in-memory mesh in
 * `@hobo/ci`.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createMeshCoordinator,
	createMeshMonitor,
	type MeshEvent,
	type MeshJob,
	type MeshNode,
} from "@hobo/ci/mesh";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNatsMesh, type NatsMesh } from "../src/mesh-nats.js";

const binary =
	process.env.HOBO_CI_NATS_SERVER_BIN ??
	(spawnSync("nats-server", ["--version"]).status === 0 ? "nats-server" : "");

const START = Date.now();
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

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			// SAFETY: a TCP server listening on a host and port reports an AddressInfo.
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("condition not reached in time");
}

describe.skipIf(!binary)("relay mesh on NATS", () => {
	let server: ChildProcess | undefined;
	let port = 0;
	let store = "";
	const meshes: NatsMesh[] = [];

	async function startServer(): Promise<void> {
		server = spawn(
			binary,
			["-a", "127.0.0.1", "-p", `${port}`, "-js", "-sd", store],
			{ stdio: "ignore" },
		);
		await until(async () => {
			try {
				await new Promise<void>((resolve, reject) => {
					const socket = createServer().listen(port, "127.0.0.1");
					socket.once("error", () => resolve());
					socket.once("listening", () => {
						socket.close();
						reject(new Error("not listening yet"));
					});
				});
				return true;
			} catch {
				return false;
			}
		});
	}

	async function stopServer(): Promise<void> {
		const running = server;
		server = undefined;
		if (!running) return;
		await new Promise<void>((resolve) => {
			running.once("exit", () => resolve());
			running.kill("SIGKILL");
		});
	}

	async function connect(namespace: string, overrides = {}) {
		const mesh = createNatsMesh({
			servers: [`nats://127.0.0.1:${port}`],
			namespace,
			requestTimeoutMs: 1_000,
			...overrides,
		});
		meshes.push(mesh);
		await mesh.ready;
		return mesh;
	}

	beforeAll(async () => {
		port = await freePort();
		store = mkdtempSync(join(tmpdir(), "hobo-ci-nats-"));
		await startServer();
	}, 30_000);

	afterAll(async () => {
		await Promise.all(
			meshes.map((mesh) => mesh.close().catch(() => undefined)),
		);
		await stopServer();
		rmSync(store, { recursive: true, force: true });
	}, 30_000);

	it("shares advertisements between connections and drops unreadable ones", async () => {
		const a = await connect("adverts");
		const b = await connect("adverts");
		await a.board.advertise(node("box-a", 3));
		await b.board.advertise(node("box-b", 5));
		const seen = await a.board.nodes();
		expect(seen.map((each) => each.id).sort()).toEqual(["box-a", "box-b"]);
		expect(seen.find((each) => each.id === "box-b")?.freeSlots).toBe(5);
		// A node's later advertisement replaces its earlier one.
		await b.board.advertise(node("box-b", 0));
		expect(
			(await a.board.nodes()).find((each) => each.id === "box-b")?.freeSlots,
		).toBe(0);
		await expect(
			a.board.advertise({ ...node("bad id with spaces"), id: "bad id" }),
		).rejects.toThrow();
		// What a job is sized against travels with the advertisement, and a
		// node that does not send it is still read.
		await a.board.advertise({
			...node("box-a", 3),
			free: { memoryMb: 12_288 },
			platform: { os: "linux", arch: "x64" },
		});
		const sized = await b.board.nodes();
		expect(sized.find((each) => each.id === "box-a")).toMatchObject({
			free: { memoryMb: 12_288 },
			platform: { os: "linux", arch: "x64" },
		});
		expect(sized.find((each) => each.id === "box-b")?.free).toBeUndefined();
	});

	it("keeps a shared configuration that only its current revision can replace", async () => {
		const a = await connect("config");
		const b = await connect("config");
		expect(await a.config.read()).toBeUndefined();
		const first = await a.config.publish('{"accounts":[]}');
		expect(first).not.toBe("conflict");
		const revision = first === "conflict" ? 0 : first.revision;
		// Another node sees it, and cannot start over with something else.
		expect(await b.config.read()).toEqual({
			value: '{"accounts":[]}',
			revision,
		});
		expect(await b.config.publish('{"accounts":[1]}')).toBe("conflict");
		// Publishing what is already there is agreement, not a conflict.
		expect(await b.config.publish('{"accounts":[]}')).toEqual({ revision });
		const second = await b.config.publish('{"accounts":[1]}', revision);
		expect(second).not.toBe("conflict");
		// "a" still holds the old revision: its write is refused.
		expect(await a.config.publish('{"accounts":[2]}', revision)).toBe(
			"conflict",
		);
		expect((await a.config.read())?.value).toBe('{"accounts":[1]}');
	});

	it("reports a node joining and then being lost when it stops advertising", async () => {
		const a = await connect("monitor", { advertTtlMs: 1_500 });
		const events: string[] = [];
		const monitor = createMeshMonitor({
			selfId: "box-a",
			board: a.board,
			log: (event, fields) => events.push(`${event}:${fields.nodeId ?? ""}`),
		});
		const live = () => ({ validUntilMs: Date.now() + 60_000 });
		await a.board.advertise({ ...node("box-a"), ...live(), totalSlots: 4 });
		expect(await monitor.observe()).toMatchObject({ nodes: 1, totalSlots: 4 });
		await a.board.advertise({ ...node("box-b"), ...live() });
		await monitor.observe();
		expect(events).toContain("hobo_ci_mesh_node_joined:box-b");
		// "box-a" keeps advertising; "box-b" does not, and ages out of the bucket.
		await until(async () => {
			await a.board.advertise({ ...node("box-a"), ...live() });
			await monitor.observe();
			return events.includes("hobo_ci_mesh_node_lost:box-b");
		}, 10_000);
	}, 20_000);

	it("forgets a node that stops advertising", async () => {
		const a = await connect("expiry", { advertTtlMs: 1_000 });
		await a.board.advertise(node("gone"));
		expect((await a.board.nodes()).map((each) => each.id)).toEqual(["gone"]);
		await until(async () => (await a.board.nodes()).length === 0, 8_000);
	}, 15_000);

	it("gives each job to exactly one of several nodes racing for it", async () => {
		const ids = ["box-a", "box-b", "box-c", "box-d"];
		const connections = await Promise.all(ids.map(() => connect("race")));
		const jobs = Array.from({ length: 200 }, (_, index) => 70_000 + index);
		const outcomes = await Promise.all(
			jobs.map(async (jobId) =>
				Promise.all(
					connections.map((mesh, index) =>
						mesh.claims.tryClaim(jobId, ids[index] ?? ""),
					),
				),
			),
		);
		for (const outcome of outcomes)
			expect(outcome.filter((result) => result === "claimed")).toHaveLength(1);
		// The winner asking again still holds it; the losers still do not.
		const [first] = outcomes;
		const winner = first?.indexOf("claimed") ?? 0;
		expect(
			await connections[winner]?.claims.tryClaim(70_000, ids[winner] ?? ""),
		).toBe("claimed");
		expect(
			await connections[(winner + 1) % 4]?.claims.tryClaim(
				70_000,
				ids[(winner + 1) % 4] ?? "",
			),
		).toBe("held");
	}, 30_000);

	it("frees a job for another node when its claim ages out", async () => {
		const a = await connect("ttl", { claimTtlMs: 1_000 });
		const b = await connect("ttl", { claimTtlMs: 1_000 });
		expect(await a.claims.tryClaim(1, "box-a")).toBe("claimed");
		expect(await b.claims.tryClaim(1, "box-b")).toBe("held");
		await until(
			async () => (await b.claims.tryClaim(1, "box-b")) === "claimed",
			8_000,
		);
		expect(await a.claims.tryClaim(1, "box-a")).toBe("held");
	}, 15_000);

	it("runs a mesh: every job once, by capacity, through failover and a NATS outage", async () => {
		const clock = { now: START };
		const nodes = [node("small", 1), node("medium", 2), node("large", 5)];
		const events: { node: string; event: MeshEvent }[] = [];
		const coordinators = new Map(
			await Promise.all(
				nodes.map(async (self) => {
					const mesh = await connect("mesh");
					return [
						self.id,
						createMeshCoordinator({
							self: () => self,
							board: mesh.board,
							claims: mesh.claims,
							stepMs: 20_000,
							viewMaxAgeMs: 0,
							claimsRetryMs: 0,
							now: () => clock.now,
							log: (event) => events.push({ node: self.id, event }),
						}),
					] as const;
				}),
			),
		);
		for (const coordinator of coordinators.values())
			expect(await coordinator.advertise()).toBe(true);

		const started = new Map<number, string[]>();
		async function poll(jobs: readonly MeshJob[], alive: readonly string[]) {
			await Promise.all(
				alive.map(async (id) => {
					for (const each of jobs) {
						if ((started.get(each.jobId) ?? []).includes(id)) continue;
						const decision = await coordinators.get(id)?.shouldStart(each);
						if (decision?.start)
							started.set(each.jobId, [...(started.get(each.jobId) ?? []), id]);
					}
				}),
			);
		}
		const share = (jobs: readonly MeshJob[], id: string) =>
			jobs.filter((each) => started.get(each.jobId)?.[0] === id).length /
			jobs.length;
		const once = (jobs: readonly MeshJob[]) =>
			jobs.every((each) => started.get(each.jobId)?.length === 1);

		// 1. All three nodes up.
		const first = Array.from({ length: 400 }, (_, index) =>
			job(80_000 + index),
		);
		await poll(first, ["small", "medium", "large"]);
		expect(once(first)).toBe(true);
		expect(Math.abs(share(first, "small") - 1 / 8)).toBeLessThan(0.06);
		expect(Math.abs(share(first, "medium") - 2 / 8)).toBeLessThan(0.06);
		expect(Math.abs(share(first, "large") - 5 / 8)).toBeLessThan(0.06);

		// 2. "large" dies without a word. Its advertisement is still on the
		// board, so the others wait for its turn to pass, then take its jobs.
		const second = Array.from({ length: 200 }, (_, index) =>
			job(90_000 + index),
		);
		await poll(second, ["small", "medium"]);
		expect(second.some((each) => !started.has(each.jobId))).toBe(true);
		clock.now += 40_000;
		await poll(second, ["small", "medium"]);
		expect(once(second)).toBe(true);
		expect(share(second, "large")).toBe(0);

		// 3. NATS itself goes away. Nothing is exact any more, and nothing stops.
		await stopServer();
		const third = Array.from({ length: 100 }, (_, index) =>
			job(95_000 + index),
		);
		await poll(third, ["small", "medium"]);
		clock.now += 40_000;
		await poll(third, ["small", "medium"]);
		expect(
			third.every((each) => (started.get(each.jobId)?.length ?? 0) >= 1),
		).toBe(true);
		expect(
			events.some((entry) => entry.event === "hobo_ci_mesh_claims_unreachable"),
		).toBe(true);

		// 4. NATS comes back on the same address; the clients reconnect on
		// their own and claims are exact again.
		await startServer();
		await until(async () => {
			const probe = await coordinators
				.get("small")
				?.shouldStart(job(99_000 + Math.floor(Math.random() * 1_000_000)));
			return probe?.start === true && probe.reason === "claimed";
		}, 20_000);
		await until(
			async () => (await coordinators.get("medium")?.advertise()) === true,
			20_000,
		);
		const fourth = Array.from({ length: 100 }, (_, index) =>
			job(97_000 + index),
		);
		clock.now += 40_000;
		await poll(fourth, ["small", "medium"]);
		clock.now += 40_000;
		await poll(fourth, ["small", "medium"]);
		expect(once(fourth)).toBe(true);
		expect(
			events.some((entry) => entry.event === "hobo_ci_mesh_claims_recovered"),
		).toBe(true);
	}, 120_000);
});
