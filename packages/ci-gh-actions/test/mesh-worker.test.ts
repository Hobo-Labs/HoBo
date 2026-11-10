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
		});
		expect(
			meshSettingsFromEnv(
				{
					HOBO_CI_NATS_URL: "tls://nats.example:4222",
					HOBO_CI_MESH_NODE_ID: "box_2",
					HOBO_CI_MESH_NAMESPACE: "staging",
					HOBO_CI_NATS_REPLICAS: "3",
					HOBO_CI_MESH_STEP_MS: "5000",
				},
				"box",
			),
		).toMatchObject({
			nodeId: "box_2",
			namespace: "staging",
			replicas: 3,
			stepMs: 5000,
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
				healthy: true,
				labels: ["hobo", "hobo-trunk"],
				validUntilMs: NOW + 45_000,
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
