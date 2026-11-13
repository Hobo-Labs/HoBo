import { createMemoryMesh } from "@hobo/ci/mesh";
import { describe, expect, it } from "vitest";
import { createWorkerMesh, meshSettingsFromEnv } from "../src/mesh-worker.js";

const NOW = Date.parse("2026-11-10T03:00:00Z");

describe("meshSettingsFromEnv", () => {
	it("is off when no NATS server is named", () => {
		expect(meshSettingsFromEnv({}, "box")).toBeUndefined();
		expect(
			meshSettingsFromEnv({ HOBO_CI_NATS_URL: " , " }, "box"),
		).toBeUndefined();
	});

	it("reads servers and defaults the rest from the host name", () => {
		expect(
			meshSettingsFromEnv(
				{ HOBO_CI_NATS_URL: "nats://a:4222, nats://b:4222" },
				"Tyler's Box.local",
			),
		).toEqual({
			servers: ["nats://a:4222", "nats://b:4222"],
			nodeId: "Tyler-s-Box-local",
			namespace: "hobo-ci",
			replicas: 1,
			stepMs: 20_000,
			reliabilityHalfLifeMs: 1_800_000,
		});
		expect(
			meshSettingsFromEnv(
				{
					HOBO_CI_NATS_URL: "tls://nats.example:4222",
					HOBO_CI_MESH_NODE_ID: "box_2",
					HOBO_CI_MESH_NAMESPACE: "staging",
					HOBO_CI_NATS_REPLICAS: "3",
					HOBO_CI_MESH_STEP_MS: "5000",
					HOBO_CI_MESH_RELIABILITY_HALF_LIFE_MS: "600000",
				},
				"box",
			),
		).toMatchObject({
			nodeId: "box_2",
			namespace: "staging",
			replicas: 3,
			stepMs: 5000,
			reliabilityHalfLifeMs: 600_000,
		});
	});

	it("refuses a server URL with credentials or another scheme, and bad numbers", () => {
		for (const env of [
			{ HOBO_CI_NATS_URL: "nats://user:secret@a:4222" },
			{ HOBO_CI_NATS_URL: "https://a:4222" },
			{ HOBO_CI_NATS_URL: "not a url" },
			{ HOBO_CI_NATS_URL: "nats://a:4222", HOBO_CI_MESH_NODE_ID: "has space" },
			{ HOBO_CI_NATS_URL: "nats://a:4222", HOBO_CI_MESH_NAMESPACE: "a/b" },
			{ HOBO_CI_NATS_URL: "nats://a:4222", HOBO_CI_NATS_REPLICAS: "0" },
			{ HOBO_CI_NATS_URL: "nats://a:4222", HOBO_CI_MESH_STEP_MS: "fast" },
			{
				HOBO_CI_NATS_URL: "nats://a:4222",
				HOBO_CI_MESH_RELIABILITY_HALF_LIFE_MS: "5",
			},
		])
			expect(() => meshSettingsFromEnv(env, "box")).toThrow(/HOBO_CI_/);
		// The message never repeats the URL it refused.
		expect(() =>
			meshSettingsFromEnv({ HOBO_CI_NATS_URL: "nats://u:secret@a" }, "box"),
		).toThrow(/^HOBO_CI_NATS_URL must not carry credentials$/);
	});
});

describe("createWorkerMesh", () => {
	const settings = {
		servers: ["nats://127.0.0.1:4222"],
		namespace: "hobo-ci",
		replicas: 1,
		stepMs: 20_000,
		reliabilityHalfLifeMs: 30 * 60_000,
	};

	function worker(
		nodeId: string,
		ports: ReturnType<typeof createMemoryMesh>,
		state: { free: number; healthy: boolean },
		servesTrunk = false,
	) {
		const events: { event: string; jobId?: unknown; reason?: unknown }[] = [];
		const mesh = createWorkerMesh({
			settings: { ...settings, nodeId },
			board: ports.board,
			claims: ports.claims,
			freeSlots: () => state.free,
			totalSlots: 4,
			healthy: () => state.healthy,
			servesTrunk,
			now: () => NOW,
			log: (event, fields) =>
				events.push({ event, jobId: fields.jobId, reason: fields.reason }),
		});
		return { mesh, events };
	}

	const queued = (jobId: number, label = "hobo") => ({
		jobId,
		runId: 900,
		label,
		createdAt: "2026-11-10T02:59:00Z",
	});

	it("advertises this worker's free slots, health and labels", async () => {
		const ports = createMemoryMesh({ now: () => NOW });
		const state = { free: 3, healthy: true };
		const { mesh } = worker("box-a", ports, state, true);
		expect(await mesh.advertise()).toBe(true);
		expect(await ports.board.nodes()).toEqual([
			{
				id: "box-a",
				freeSlots: 3,
				totalSlots: 4,
				healthy: true,
				labels: ["hobo", "hobo-trunk"],
				validUntilMs: NOW + 45_000,
				reliability: 1,
				// No job taken yet: the score of 1 stands on no samples.
				samples: { delivered: 0, dropped: 0 },
				// Healthy since it started.
				sinceMs: NOW,
			},
		]);
		// A lease count above the slot count never advertises negative capacity.
		state.free = -2;
		state.healthy = false;
		await mesh.advertise();
		expect(await ports.board.nodes()).toMatchObject([
			{ freeSlots: 0, healthy: false },
		]);
	});

	it("advertises the committed labels it is given (plan 0026, R2)", async () => {
		const ports = createMemoryMesh({ now: () => NOW });
		const mesh = createWorkerMesh({
			settings: { ...settings, nodeId: "box-a" },
			board: ports.board,
			claims: ports.claims,
			freeSlots: () => 1,
			totalSlots: 2,
			healthy: () => true,
			servesTrunk: true,
			labels: ["fleet-x", "trunk-x"],
			now: () => NOW,
		});
		await mesh.advertise();
		expect(await ports.board.nodes()).toMatchObject([
			{ labels: ["fleet-x", "trunk-x"] },
		]);
	});

	it("gives a job to the worker it fits, not the one with the most free slots", async () => {
		const ports = createMemoryMesh({ now: () => NOW });
		const logs: { node: string; event: string; lacking?: unknown }[] = [];
		const sized = (nodeId: string, freeSlots: number, memoryMb: number) =>
			createWorkerMesh({
				settings: { ...settings, nodeId },
				board: ports.board,
				claims: ports.claims,
				freeSlots: () => freeSlots,
				totalSlots: 8,
				healthy: () => true,
				servesTrunk: false,
				free: () => ({ memoryMb }),
				platform: { os: "linux", arch: "x64" },
				// The worker sizes a job by its name, as its memory classes do.
				needs: (job) => ({
					memoryMb: job.name.startsWith("Workspace test shard") ? 6_144 : 1_024,
				}),
				now: () => NOW,
				log: (event, fields) =>
					logs.push({ node: nodeId, event, lacking: fields.lacking }),
			});
		// Eight free slots but memory for no heavy job, against one slot with room.
		const wide = sized("wide", 8, 2_000);
		const deep = sized("deep", 1, 8_000);
		await wide.advertise();
		await deep.advertise();
		const advertised = [...(await ports.board.nodes())].sort((a, b) =>
			a.id.localeCompare(b.id),
		);
		expect(advertised).toMatchObject([
			{ id: "deep", free: { memoryMb: 8_000 }, platform: { arch: "x64" } },
			{ id: "wide", free: { memoryMb: 2_000 } },
		]);
		for (let jobId = 1; jobId <= 50; jobId += 1) {
			const heavy = { ...queued(jobId), name: "Workspace test shard 0" };
			expect(await wide.claim(heavy)).toBe(false);
			// Asking again does not log again.
			expect(await wide.claim(heavy)).toBe(false);
			expect(await deep.claim(heavy)).toBe(true);
		}
		expect(
			logs.filter((entry) => entry.event === "hobo_ci_mesh_job_unfit"),
		).toHaveLength(50);
		expect(
			logs.every(
				(entry) =>
					entry.event !== "hobo_ci_mesh_job_unfit" ||
					(entry.node === "wide" && entry.lacking === "memory"),
			),
		).toBe(true);
		// A light job fits both, so the wide worker is back in the running.
		let wideTook = 0;
		for (let jobId = 1000; jobId < 1100; jobId += 1) {
			const light = { ...queued(jobId), name: "Secret scan" };
			const results = [await wide.claim(light), await deep.claim(light)];
			expect(results.filter(Boolean)).toHaveLength(1);
			if (results[0]) wideTook++;
		}
		// Room for two of these on the wide worker, one on the deep one.
		expect(wideTook).toBeGreaterThan(50);
	});

	it("takes a job once across two workers and logs it once", async () => {
		const ports = createMemoryMesh({ now: () => NOW });
		const a = worker("box-a", ports, { free: 2, healthy: true });
		const b = worker("box-b", ports, { free: 2, healthy: true });
		await a.mesh.advertise();
		await b.mesh.advertise();
		let taken = 0;
		for (let jobId = 1; jobId <= 200; jobId += 1) {
			// The job was queued a minute ago, so both workers' turns have come:
			// only the claim separates them.
			const results = [
				await a.mesh.claim(queued(jobId)),
				await b.mesh.claim(queued(jobId)),
			];
			expect(results.filter(Boolean)).toHaveLength(1);
			taken += 1;
		}
		expect(taken).toBe(200);
		// A second poll of a job it holds is still yes, and is not logged again.
		const before = a.events.length + b.events.length;
		expect(
			(await a.mesh.claim(queued(1))) || (await b.mesh.claim(queued(1))),
		).toBe(true);
		expect(a.events.length + b.events.length).toBe(before);
		expect(before).toBe(200);
		expect(a.events[0]).toMatchObject({
			event: "hobo_ci_mesh_job_taken",
			reason: "claimed",
		});
	});

	it("does not take a job when full, draining or for a label it does not serve", async () => {
		const ports = createMemoryMesh({ now: () => NOW });
		const state = { free: 0, healthy: true };
		const { mesh } = worker("box-a", ports, state);
		expect(await mesh.claim(queued(1))).toBe(false);
		state.free = 2;
		state.healthy = false;
		expect(await mesh.claim(queued(2))).toBe(false);
		state.healthy = true;
		expect(await mesh.claim(queued(3, "hobo-trunk"))).toBe(false);
		expect(await mesh.claim(queued(4))).toBe(true);
	});

	it("treats a job with no queue time as queued now", async () => {
		const ports = createMemoryMesh({ now: () => NOW });
		const a = worker("box-a", ports, { free: 2, healthy: true });
		const b = worker("box-b", ports, { free: 2, healthy: true });
		await a.mesh.advertise();
		await b.mesh.advertise();
		let both = 0;
		for (let jobId = 1; jobId <= 100; jobId += 1) {
			const job = { ...queued(jobId), createdAt: undefined };
			const results = [await a.mesh.claim(job), await b.mesh.claim(job)];
			// Just queued: only the first-ranked worker's turn has come.
			expect(results.filter(Boolean)).toHaveLength(1);
			if (results[0] && results[1]) both += 1;
		}
		expect(both).toBe(0);
	});
});

describe("a worker's reliability", () => {
	const MINUTE = 60_000;

	function setup(overrides: { startDeadlineMs?: number } = {}) {
		let at = NOW;
		const ports = createMemoryMesh({ now: () => at });
		const events: {
			event: string;
			jobId?: unknown;
			reason?: unknown;
			reliability?: unknown;
		}[] = [];
		const mesh = createWorkerMesh({
			settings: {
				servers: ["nats://127.0.0.1:4222"],
				namespace: "hobo-ci",
				replicas: 1,
				stepMs: 20_000,
				reliabilityHalfLifeMs: 30 * MINUTE,
				nodeId: "box-a",
			},
			board: ports.board,
			claims: ports.claims,
			freeSlots: () => 4,
			totalSlots: 4,
			healthy: () => true,
			servesTrunk: false,
			now: () => at,
			...overrides,
			log: (event, fields) =>
				events.push({
					event,
					jobId: fields.jobId,
					reason: fields.reason,
					reliability: fields.reliability,
				}),
		});
		const queued = (jobId: number) => ({
			jobId,
			runId: 900,
			label: "hobo",
			createdAt: new Date(at).toISOString(),
		});
		const advertised = async () => {
			await mesh.advertise();
			const [self] = await ports.board.nodes();
			return self?.reliability;
		};
		const drops = () =>
			events
				.filter((entry) => entry.event === "hobo_ci_mesh_job_dropped")
				.map((entry) => `${String(entry.jobId)}:${String(entry.reason)}`);
		return {
			mesh,
			events,
			queued,
			advertised,
			drops,
			advance: (ms: number) => {
				at += ms;
			},
		};
	}

	it("stays at 1 while every job it takes gets a runner", async () => {
		const h = setup();
		for (const jobId of [1, 2, 3]) {
			expect(await h.mesh.claim(h.queued(jobId))).toBe(true);
			h.mesh.record("hobo_ci_job_pickup", { jobId, runId: 900 });
		}
		expect(h.mesh.reliability()).toBe(1);
		expect(await h.advertised()).toBe(1);
		expect(h.drops()).toEqual([]);
	});

	it("counts a job as dropped when its launch is given up, its container is killed for memory, or its runner is lost", async () => {
		const h = setup();
		for (const jobId of [1, 2, 3, 4]) await h.mesh.claim(h.queued(jobId));
		// Job 1: the runner never came up.
		h.mesh.record("hobo_ci_launch_parked", { jobId: 1, attempt: 3 });
		// Jobs 2 and 3 got a runner and lost it; job 4 kept its runner.
		for (const jobId of [2, 3, 4])
			h.mesh.record("hobo_ci_job_pickup", { jobId, runId: 900 });
		h.mesh.record("hobo_ci_container_oom", { jobId: 2, exitCode: 137 });
		h.mesh.record("hobo_ci_orphan_job_confirmed", { jobId: 3, runnerId: 7 });
		expect(h.drops()).toEqual([
			"1:launch-failed",
			"2:out-of-memory",
			"3:runner-lost",
		]);
		// One delivered, three dropped, four imagined deliveries: 5 / 8.
		expect(h.mesh.reliability()).toBeCloseTo(5 / 8, 10);
		expect(await h.advertised()).toBeCloseTo(5 / 8, 10);
		// A second report about a job already counted changes nothing.
		h.mesh.record("hobo_ci_orphan_job_confirmed", { jobId: 2, runnerId: 7 });
		h.mesh.record("hobo_ci_launch_parked", { jobId: 1, attempt: 4 });
		expect(h.drops()).toHaveLength(3);
		expect(h.mesh.reliability()).toBeCloseTo(5 / 8, 10);
	});

	it("ignores what happens to jobs it never took, and events that say nothing about a job", async () => {
		const h = setup();
		h.mesh.record("hobo_ci_container_oom", { jobId: 99, exitCode: 137 });
		h.mesh.record("hobo_ci_job_pickup", { jobId: 98, runId: 1 });
		h.mesh.record("hobo_ci_launch_failed", { jobId: 1, attempt: 1 });
		h.mesh.record("hobo_ci_host_health", { verdict: "critical" });
		h.mesh.record("hobo_ci_container_oom", { jobName: "no id" });
		expect(h.mesh.reliability()).toBe(1);
		expect(h.events).toEqual([]);
	});

	it("counts a job still queued ten minutes after it claimed it, once", async () => {
		const h = setup();
		expect(await h.mesh.claim(h.queued(5))).toBe(true);
		for (let minute = 1; minute <= 9; minute += 1) {
			h.advance(MINUTE);
			await h.mesh.claim(h.queued(5));
			await h.advertised();
		}
		expect(h.drops()).toEqual([]);
		h.advance(MINUTE);
		await h.mesh.claim(h.queued(5));
		expect(h.drops()).toEqual(["5:never-started"]);
		expect(h.mesh.reliability()).toBeCloseTo(4 / 5, 10);
		// It stays queued and is seen again; it is not counted again.
		h.advance(5 * MINUTE);
		await h.mesh.claim(h.queued(5));
		expect(h.drops()).toHaveLength(1);
		// A runner that finally arrives does not undo the drop.
		h.mesh.record("hobo_ci_job_pickup", { jobId: 5, runId: 900 });
		expect(h.mesh.reliability()).toBeLessThan(1);
	});

	it("does not blame itself for a job that left the queue some other way", async () => {
		const h = setup();
		// Claimed, then cancelled before any runner started: never seen again.
		expect(await h.mesh.claim(h.queued(6))).toBe(true);
		for (let minute = 1; minute <= 15; minute += 1) {
			h.advance(MINUTE);
			await h.advertised();
		}
		expect(h.drops()).toEqual([]);
		expect(h.mesh.reliability()).toBe(1);
		// Nor for a late report about it.
		h.mesh.record("hobo_ci_launch_parked", { jobId: 6, attempt: 3 });
		expect(h.drops()).toEqual([]);
	});

	it("recovers without a restart once it stops dropping jobs, faster when it delivers", async () => {
		const h = setup();
		// The disk fills: ten jobs in a row never get a runner.
		for (let jobId = 10; jobId < 20; jobId += 1) {
			await h.mesh.claim(h.queued(jobId));
			h.mesh.record("hobo_ci_launch_parked", { jobId, attempt: 3 });
		}
		expect(await h.advertised()).toBeCloseTo(4 / 14, 10);
		// The disk is fixed. Half an hour later, with nothing delivered yet:
		h.advance(30 * MINUTE);
		expect(await h.advertised()).toBeCloseTo(4 / 9, 10);
		// Ten jobs delivered since: (10 + 4) / (10 + 5 + 4).
		for (let jobId = 20; jobId < 30; jobId += 1) {
			await h.mesh.claim(h.queued(jobId));
			h.mesh.record("hobo_ci_job_pickup", { jobId, runId: 900 });
		}
		expect(await h.advertised()).toBeCloseTo(14 / 19, 10);
		// Left alone for the rest of the day it is trusted again.
		h.advance(8 * 60 * MINUTE);
		expect(await h.advertised()).toBeGreaterThan(0.99);
		// The log says where the score went, in steps, down and back up.
		const reported = h.events
			.filter((entry) => entry.event === "hobo_ci_mesh_reliability")
			.map((entry) => Number(entry.reliability));
		// A line is written each time the score has moved a twentieth.
		expect(Math.min(...reported)).toBeLessThan(0.35);
		expect(reported.at(-1)).toBeGreaterThan(0.99);
	});

	it("takes the job that fits it less often once its record is poor", async () => {
		// Two workers, same capacity, one board. One has dropped ten jobs.
		let at = NOW;
		const ports = createMemoryMesh({ now: () => at });
		const make = (nodeId: string) =>
			createWorkerMesh({
				settings: {
					servers: ["nats://127.0.0.1:4222"],
					namespace: "hobo-ci",
					replicas: 1,
					stepMs: 20_000,
					reliabilityHalfLifeMs: 30 * MINUTE,
					nodeId,
				},
				board: ports.board,
				claims: ports.claims,
				freeSlots: () => 4,
				totalSlots: 4,
				healthy: () => true,
				servesTrunk: false,
				now: () => at,
			});
		const steady = make("steady");
		const flaky = make("flaky");
		const job = (jobId: number) => ({
			jobId,
			runId: 900,
			label: "hobo",
			createdAt: new Date(at).toISOString(),
		});
		for (let jobId = 1; jobId <= 10; jobId += 1) {
			await flaky.claim(job(jobId));
			flaky.record("hobo_ci_launch_parked", { jobId, attempt: 3 });
		}
		await steady.advertise();
		await flaky.advertise();
		// Past the few seconds a worker keeps its last view of the board.
		at += 6000;
		// Fresh jobs, asked of the flaky worker first: how many is it first for?
		let first = 0;
		const jobs = 600;
		for (let jobId = 1000; jobId < 1000 + jobs; jobId += 1)
			if (await flaky.claim(job(jobId))) first += 1;
		// Weight 4 x 4/14 against 4: about 22%, not the half it had before.
		expect(first / jobs).toBeGreaterThan(0.16);
		expect(first / jobs).toBeLessThan(0.29);
	});
});
