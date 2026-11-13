import { createMemoryMesh, type MeshNode } from "@hobo/ci/mesh";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	createFleetStatePublisher,
	FLEET_STATE_MAX_AGE_MS,
} from "../src/fleet-state.js";
import type { GithubTransport } from "../src/github.js";

const REPOSITORY = "Hobo-Labs/HoBo";
const TARGET = [{ installationId: 7, repository: REPOSITORY }];
const NOW = Date.parse("2026-11-10T03:00:00Z");
const Written = z.object({ name: z.string(), value: z.string() });

function github(status: { patch?: number; post?: number } = {}) {
	const calls: { path: string; method: string; body: string | undefined }[] =
		[];
	const transport: GithubTransport = {
		async request(_installationId, path, method = "GET", body) {
			calls.push({ path, method, body });
			return new Response(null, {
				status:
					method === "PATCH" ? (status.patch ?? 204) : (status.post ?? 201),
			});
		},
	};
	const values = () =>
		calls.map((call) => Written.parse(JSON.parse(call.body ?? "")).value);
	return { transport, calls, values };
}

const node = (id: string, overrides: Partial<MeshNode> = {}): MeshNode => ({
	id,
	freeSlots: 2,
	totalSlots: 4,
	healthy: true,
	labels: ["hobo"],
	validUntilMs: NOW + 45_000,
	...overrides,
});

function setup(options: {
	self?: Partial<MeshNode>;
	peers?: MeshNode[];
	requireTrusted?: boolean;
	status?: { patch?: number; post?: number };
	boardDown?: () => boolean;
	labels?: string[];
}) {
	const clock = { now: NOW };
	const api = github(options.status);
	const events: { event: string; status?: unknown; labels?: unknown }[] = [];
	const self = {
		current: node("box-a", {
			labels: options.labels ?? ["hobo", "hobo-trunk"],
			...options.self,
		}),
	};
	const peers = { current: options.peers ?? [] };
	const publisher = createFleetStatePublisher({
		github: api.transport,
		board: {
			nodes: async () => {
				if (options.boardDown?.()) throw new Error("NATS not connected");
				// As a real board returns it: this worker's last advertisement too.
				return [self.current, ...peers.current];
			},
		},
		self: () => self.current,
		labels: options.labels ?? ["hobo", "hobo-trunk"],
		requireTrusted: () => options.requireTrusted === true,
		now: () => clock.now,
		log: (event, fields) =>
			events.push({ event, status: fields.status, labels: fields.labels }),
	});
	return { clock, api, events, publisher, self, peers };
}

describe("fleet state publisher", () => {
	it("lists only the fleet labels this worker serves, counting every node that would take a job", async () => {
		const h = setup({
			self: { freeSlots: 1 },
			peers: [
				node("box-b", { freeSlots: 3, trust: "trusted" }),
				node("box-c", { freeSlots: 2, trust: "unverified" }),
				node("forged", { freeSlots: 64, trust: "invalid" }),
				node("forever", {
					freeSlots: 64,
					trust: "trusted",
					validUntilMs: NOW + 365 * 24 * 3_600_000,
				}),
				node("draining", { healthy: false, trust: "trusted" }),
				node("relay-a", { labels: [], freeSlots: 0, totalSlots: 0 }),
				// Somebody's laptop running jobs for another repository.
				node("local-dev", {
					labels: ["hobo-local-host"],
					freeSlots: 0,
					totalSlots: 1,
				}),
			],
		});
		expect(await h.publisher.publish(TARGET)).toBe(1);
		expect(h.api.calls).toEqual([
			{
				path: `/repos/${REPOSITORY}/actions/variables/HOBO_CI_FLEET_STATE`,
				method: "PATCH",
				body: expect.any(String),
			},
		]);
		const [value] = h.api.values();
		expect(JSON.parse(value ?? "")).toEqual({
			publishedAt: "2026-11-10T03:00:00.000Z",
			labels: {
				// An unlisted worker still picks up jobs: it counts.
				hobo: { nodes: 3, trustedNodes: 2, freeSlots: 6 },
				"hobo-trunk": { nodes: 1, trustedNodes: 1, freeSlots: 1 },
			},
		});
		// Never the local-host label: one repository's laptop is not another's.
		expect(value).not.toContain("hobo-local-host");
		expect((value ?? "").length).toBeLessThan(300);
		expect(value).not.toMatch(/box-|relay-|local-dev|publicKey|nats/);
		// The log says what routing reads, not the value.
		expect(h.events).toEqual([
			{
				event: "hobo_ci_fleet_state_published",
				status: undefined,
				labels: "hobo=open,hobo-trunk=open",
			},
		]);
	});

	it("does not filter the counts by trust, even when the mesh requires it", async () => {
		const h = setup({
			requireTrusted: true,
			peers: [
				node("box-b", { freeSlots: 3, trust: "trusted" }),
				node("box-c", { freeSlots: 2, trust: "unverified" }),
			],
		});
		await h.publisher.publish(TARGET);
		expect(JSON.parse(h.api.values()[0] ?? "").labels.hobo).toEqual({
			nodes: 3,
			trustedNodes: 2,
			freeSlots: 7,
		});
	});

	it("lists a fleet label nobody serves with zeros, dated", async () => {
		const h = setup({ self: { freeSlots: 0, labels: ["hobo"] } });
		await h.publisher.publish(TARGET);
		const [value] = h.api.values();
		expect(JSON.parse(value ?? "").labels).toEqual({
			hobo: { nodes: 1, trustedNodes: 1, freeSlots: 0 },
			"hobo-trunk": { nodes: 0, trustedNodes: 0, freeSlots: 0 },
		});
		// Runner routing no longer reads this variable (ADR-0180); the snapshot
		// is still dated, so anything that does can tell how old it is.
		expect(Date.parse(JSON.parse(value ?? "").publishedAt)).toBe(NOW);
	});

	it("writes when what routing reads changes, and otherwise only as a heartbeat", async () => {
		const h = setup({ self: { freeSlots: 3 } });
		expect(await h.publisher.publish(TARGET)).toBe(1);
		// Free slots move, but every label still has a node and a slot: no write.
		for (const freeSlots of [2, 1, 2]) {
			h.clock.now += 30_000;
			h.self.current = node("box-a", {
				labels: ["hobo", "hobo-trunk"],
				freeSlots,
			});
			expect(await h.publisher.publish(TARGET)).toBe(0);
		}
		// The worker fills up: routing would read "full" now. Written, once the
		// last write is 30 s behind.
		h.clock.now += 10_000;
		h.self.current = node("box-a", {
			labels: ["hobo", "hobo-trunk"],
			freeSlots: 0,
		});
		expect(await h.publisher.publish(TARGET)).toBe(1);
		h.clock.now += 10_000;
		expect(await h.publisher.publish(TARGET)).toBe(0);
		// Unchanged for two minutes: written again, with a new timestamp.
		h.clock.now += 109_000;
		expect(await h.publisher.publish(TARGET)).toBe(0);
		h.clock.now += 1_000;
		expect(await h.publisher.publish(TARGET)).toBe(1);
		const stamps = h.api
			.values()
			.map((value) => String(JSON.parse(value).publishedAt));
		expect(stamps).toEqual([
			"2026-11-10T03:00:00.000Z",
			"2026-11-10T03:01:40.000Z",
			"2026-11-10T03:03:40.000Z",
		]);
		// The heartbeat keeps a live mesh's snapshot well inside what routing accepts.
		expect(120_000).toBeLessThan(FLEET_STATE_MAX_AGE_MS);
		expect(FLEET_STATE_MAX_AGE_MS).toBe(5 * 60_000);
	});

	it("has one worker write for the mesh: the lowest id that serves a fleet label", async () => {
		const clock = { now: NOW };
		const advertised = new Map<string, MeshNode>();
		const board = { nodes: async () => [...advertised.values()] };
		// Each worker writes through its own transport, so who wrote is known.
		const workers = ["box-b", "box-a"].map((id) => {
			advertised.set(id, node(id, { freeSlots: 1 }));
			const api = github();
			return {
				id,
				api,
				publisher: createFleetStatePublisher({
					github: api.transport,
					board,
					self: () => advertised.get(id) ?? node(id),
					labels: ["hobo"],
					now: () => clock.now,
				}),
			};
		});
		// A relay and a laptop with lower ids serve no fleet label: not candidates.
		advertised.set("aaa-relay", node("aaa-relay", { labels: [] }));
		advertised.set(
			"aab-laptop",
			node("aab-laptop", { labels: ["hobo-local-host"] }),
		);
		// Each beat, every live worker re-advertises and may publish.
		const beat = async (live: typeof workers) => {
			clock.now += 40_000;
			for (const worker of live) {
				advertised.set(
					worker.id,
					node(worker.id, { freeSlots: 1, validUntilMs: clock.now + 45_000 }),
				);
				await worker.publisher.publish(TARGET);
			}
		};
		for (let count = 0; count < 6; count += 1) await beat(workers);
		const [boxB, boxA] = workers;
		if (!boxA || !boxB) throw new Error("two workers");
		// box-a, the lowest, wrote (once, then a heartbeat); box-b never did.
		expect(boxA.api.values()).toHaveLength(2);
		expect(boxB.api.calls).toEqual([]);
		// box-a stops advertising: box-b takes over on its next beat.
		advertised.delete("box-a");
		await beat([boxB]);
		expect(boxB.api.values()).toHaveLength(1);
		expect(boxA.api.values()).toHaveLength(2);
	});

	it("writes at once as the publisher starts to drain, though it is no longer a candidate", async () => {
		const h = setup({});
		await h.publisher.publish(TARGET);
		h.clock.now += 1_000;
		h.self.current = node("box-a", {
			labels: ["hobo", "hobo-trunk"],
			healthy: false,
		});
		expect(await h.publisher.publish(TARGET)).toBe(0);
		expect(await h.publisher.publish(TARGET, { now: true })).toBe(1);
		expect(JSON.parse(h.api.values()[1] ?? "").labels.hobo).toEqual({
			nodes: 0,
			trustedNodes: 0,
			freeSlots: 0,
		});
		// A worker that was never elected writes nothing, even on its drain.
		const quiet = setup({ self: { id: "box-z" }, peers: [node("box-a")] });
		expect(await quiet.publisher.publish(TARGET, { now: true })).toBe(0);
	});

	it("creates the variable when it does not exist yet", async () => {
		const h = setup({ status: { patch: 404 } });
		expect(await h.publisher.publish(TARGET)).toBe(1);
		expect(h.api.calls.map((call) => [call.method, call.path])).toEqual([
			["PATCH", `/repos/${REPOSITORY}/actions/variables/HOBO_CI_FLEET_STATE`],
			["POST", `/repos/${REPOSITORY}/actions/variables`],
		]);
	});

	it("says nothing when it cannot read the board, so the last snapshot ages out", async () => {
		let down = true;
		const h = setup({ boardDown: () => down });
		expect(await h.publisher.publish(TARGET)).toBe(0);
		expect(h.api.calls).toEqual([]);
		down = false;
		expect(await h.publisher.publish(TARGET)).toBe(1);
	});

	it("backs off after a refused write and never throws", async () => {
		const h = setup({ status: { patch: 403 } });
		expect(await h.publisher.publish(TARGET)).toBe(0);
		expect(h.events).toEqual([
			{ event: "hobo_ci_fleet_state_error", status: 403, labels: undefined },
		]);
		h.clock.now += 5 * 60_000;
		await h.publisher.publish(TARGET);
		expect(h.api.calls).toHaveLength(1);
		h.clock.now += 5 * 60_000;
		await h.publisher.publish(TARGET);
		expect(h.api.calls).toHaveLength(2);

		const failing = createFleetStatePublisher({
			github: {
				request: async () => {
					throw new Error("socket hang up");
				},
			},
			board: createMemoryMesh().board,
			self: () => node("box-a"),
			labels: ["hobo"],
			now: () => NOW,
		});
		expect(await failing.publish(TARGET)).toBe(0);
	});
});
