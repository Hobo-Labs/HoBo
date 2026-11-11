import { createMemoryMesh, type MeshNode } from "@hobo/ci/mesh";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	FLEET_STATE_MAX_AGE_SECONDS,
	fleetStateRefusal,
	parseFleetState,
} from "../../../scripts/ci/route-runner.mts";
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
	validUntilMs: NOW + 3_600_000,
	...overrides,
});

function setup(options: {
	self?: Partial<MeshNode>;
	peers?: MeshNode[];
	requireTrusted?: boolean;
	status?: { patch?: number; post?: number };
	boardDown?: () => boolean;
}) {
	const clock = { now: NOW };
	const api = github(options.status);
	const events: { event: string; status?: unknown }[] = [];
	const self = { current: node("box-a", options.self) };
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
		labels: ["hobo", "hobo-trunk"],
		requireTrusted: () => options.requireTrusted === true,
		now: () => clock.now,
		log: (event, fields) => events.push({ event, status: fields.status }),
	});
	return { clock, api, events, publisher, self, peers };
}

describe("fleet state publisher", () => {
	it("writes, per label, the nodes this worker ranks and their free slots", async () => {
		const h = setup({
			self: { labels: ["hobo", "hobo-trunk"], freeSlots: 1 },
			peers: [
				node("box-b", { freeSlots: 3, trust: "trusted" }),
				node("box-c", { freeSlots: 2, trust: "unverified" }),
				node("forged", { freeSlots: 64, trust: "invalid" }),
				node("draining", { healthy: false, trust: "trusted" }),
				node("relay-a", { labels: [], freeSlots: 0, totalSlots: 0 }),
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
				// This worker counts itself as trusted: it needs no signature for that.
				hobo: { nodes: 3, trustedNodes: 2, freeSlots: 6 },
				"hobo-trunk": { nodes: 1, trustedNodes: 1, freeSlots: 1 },
			},
		});
		// Small, and nothing in it names a node, a key or an address.
		expect((value ?? "").length).toBeLessThan(300);
		expect(value).not.toMatch(/box-|relay-|publicKey|nats/);
	});

	it("counts only trusted nodes once the mesh requires trust", async () => {
		const h = setup({
			requireTrusted: true,
			peers: [
				node("box-b", { freeSlots: 3, trust: "trusted" }),
				node("box-c", { freeSlots: 2, trust: "unverified" }),
			],
		});
		await h.publisher.publish(TARGET);
		expect(JSON.parse(h.api.values()[0] ?? "").labels.hobo).toEqual({
			nodes: 2,
			trustedNodes: 2,
			freeSlots: 5,
		});
	});

	it("lists a label nobody serves with zeros, so routing reads it as refusing", async () => {
		const h = setup({ self: { freeSlots: 0 } });
		await h.publisher.publish(TARGET);
		const [value] = h.api.values();
		expect(JSON.parse(value ?? "").labels).toEqual({
			hobo: { nodes: 1, trustedNodes: 1, freeSlots: 0 },
			"hobo-trunk": { nodes: 0, trustedNodes: 0, freeSlots: 0 },
		});
		// What the routing job makes of exactly this value.
		const read = parseFleetState(value, NOW + 30_000);
		expect(fleetStateRefusal(read, "hobo", "refusing")).toContain(
			"no free slot",
		);
		expect(fleetStateRefusal(read, "hobo-trunk", "refusing")).toContain(
			"no live node",
		);
	});

	it("spaces changes out, and rewrites an unchanged snapshot before it goes stale", async () => {
		const h = setup({});
		expect(await h.publisher.publish(TARGET)).toBe(1);
		// Unchanged a beat later: nothing to write.
		h.clock.now += 10_000;
		expect(await h.publisher.publish(TARGET)).toBe(0);
		// Changed, but the last write was seconds ago: wait.
		h.self.current = node("box-a", { freeSlots: 0 });
		expect(await h.publisher.publish(TARGET)).toBe(0);
		h.clock.now += 20_000;
		expect(await h.publisher.publish(TARGET)).toBe(1);
		// Unchanged for two minutes: written again, with a new timestamp.
		h.clock.now += 119_000;
		expect(await h.publisher.publish(TARGET)).toBe(0);
		h.clock.now += 1_000;
		expect(await h.publisher.publish(TARGET)).toBe(1);
		const stamps = h.api
			.values()
			.map((value) => String(JSON.parse(value).publishedAt));
		expect(stamps).toEqual([
			"2026-11-10T03:00:00.000Z",
			"2026-11-10T03:00:30.000Z",
			"2026-11-10T03:02:30.000Z",
		]);
		// The refresh keeps a live worker's snapshot well inside what routing accepts.
		expect(120_000).toBeLessThan(FLEET_STATE_MAX_AGE_MS);
		expect(FLEET_STATE_MAX_AGE_MS).toBe(FLEET_STATE_MAX_AGE_SECONDS * 1000);
	});

	it("writes at once when asked to, as a worker does when it starts to drain", async () => {
		const h = setup({});
		await h.publisher.publish(TARGET);
		h.clock.now += 1_000;
		h.self.current = node("box-a", { healthy: false });
		expect(await h.publisher.publish(TARGET)).toBe(0);
		expect(await h.publisher.publish(TARGET, { now: true })).toBe(1);
		expect(JSON.parse(h.api.values()[1] ?? "").labels.hobo).toEqual({
			nodes: 0,
			trustedNodes: 0,
			freeSlots: 0,
		});
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
			{ event: "hobo_ci_fleet_state_error", status: 403 },
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
