import { request } from "node:http";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
	createRelayService,
	type RelayServiceLog,
	type RelayServiceOptions,
} from "../src/service.js";
import { harness, queued, reserve, signed } from "./fixtures.js";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const services: ReturnType<typeof createRelayService>[] = [];
const finish: (() => void)[] = [];
afterEach(async () => {
	for (const release of finish.splice(0)) release();
	await Promise.all(services.splice(0).map((service) => service.stop()));
});
function setup(overrides: Partial<RelayServiceOptions> = {}) {
	const h = harness();
	const logs: RelayServiceLog[] = [];
	const history: string[] = [];
	const service = createRelayService({
		relay: h.relay,
		store: {
			all: () => h.store.all(),
			recover: (now) => {
				history.push("recover");
				h.store.recover(now);
			},
			close: () => {
				history.push("close");
				h.store.close();
			},
		},
		port: 0,
		host: "127.0.0.1",
		tickIntervalMs: 15,
		drainTimeoutMs: 1_000,
		readinessProbe: async () => true,
		logger: (entry) => logs.push(entry),
		...overrides,
	});
	services.push(service);
	function base(): string {
		const address = z
			.object({ port: z.number() })
			.parse(service.server.address());
		return `http://127.0.0.1:${address.port}`;
	}
	return { ...h, service, logs, history, base };
}

it("recovers before listening, gates startup and permissions, and caches readiness probes", async () => {
	const gate = deferred();
	finish.push(gate.resolve);
	let probes = 0;
	let permitted = true;
	const h = setup({
		readinessProbe: async () => {
			probes++;
			await gate.promise;
			return permitted;
		},
	});
	await h.service.start();
	expect(h.history).toEqual(["recover"]);
	const initial = await fetch(`${h.base()}/readyz`);
	expect(initial.status).toBe(503);
	expect(await initial.json()).toEqual({
		ready: false,
		engines: { "gh-actions": { ready: false } },
	});
	expect((await fetch(`${h.base()}/healthz`)).status).toBe(200);
	expect(
		(await fetch(`${h.base()}/github/webhooks`, { method: "POST" })).status,
	).toBe(503);
	gate.resolve();
	await expect.poll(() => h.service.ready()).toBe(true);
	expect((await fetch(`${h.base()}/readyz`)).status).toBe(200);
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(probes).toBe(1);
	permitted = false;
	expect(await h.service.checkReadiness()).toBe(false);
	expect((await fetch(`${h.base()}/readyz`)).status).toBe(503);
	expect((await fetch(`${h.base()}/healthz`)).status).toBe(200);
});

it("times out unavailable permissions with an abort signal and leaks no failure details", async () => {
	const gate = deferred();
	finish.push(gate.resolve);
	let aborted = false;
	const h = setup({
		probeTimeoutMs: 15,
		readinessProbe: async (signal) => {
			signal.addEventListener("abort", () => {
				aborted = true;
			});
			await gate.promise;
			throw new Error("Bearer highly-secret-provider-token");
		},
	});
	await h.service.start();
	await expect.poll(() => aborted).toBe(true);
	expect(h.service.ready()).toBe(false);
	expect(h.logs).toContainEqual({ level: "error", event: "readiness.failed" });
	const response = await fetch(`${h.base()}/readyz`);
	expect(await response.text()).toBe(
		'{"ready":false,"engines":{"gh-actions":{"ready":false}}}',
	);
	gate.resolve();
	await Promise.resolve();
	expect(JSON.stringify(h.logs)).not.toContain("secret");
});

it("isolates failed leases, discovers unknown hosts and never overlaps worker ticks", async () => {
	const h = setup();
	const lease = await reserve(h);
	const gate = deferred();
	finish.push(gate.resolve);
	const seen: string[] = [];
	let dispatches = 0;
	let refreshes = 0;
	const service = createRelayService({
		relay: {
			webhook: h.relay.webhook.bind(h.relay),
			claim: h.relay.claim.bind(h.relay),
			now: h.relay.now,
			reconcile: async (id) => {
				seen.push(id);
				if (id === "failed") throw new Error("secret GitHub response");
				await gate.promise;
			},
			discover: async (id) => {
				seen.push(id);
			},
			dispatchPending: async () => {
				dispatches++;
			},
		},
		store: {
			all: () => [
				{ ...lease, id: "failed", state: "running", hostRunId: 10 },
				{ ...lease, id: "discover", state: "uncertain", hostRunId: 0 },
				{ ...lease, id: "waiting", state: "running", hostRunId: 20 },
			],
			recover: () => {},
			close: () => {},
		},
		port: 0,
		tickIntervalMs: 10,
		readinessProbe: async () => true,
		beforeDispatch: async () => {
			refreshes++;
		},
		logger: (entry) => h.logs.push(entry),
	});
	services.push(service);
	await service.start();
	await expect.poll(() => seen).toEqual(["failed", "discover", "waiting"]);
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(refreshes).toBe(1);
	expect(dispatches).toBe(0);
	gate.resolve();
	await expect.poll(() => dispatches).toBeGreaterThan(0);
	expect(h.logs).toContainEqual({
		level: "error",
		event: "worker.lease_failed",
		leaseId: "failed",
	});
	expect(JSON.stringify(h.logs)).not.toContain("secret");
});

it("keeps control-plane setup available while provider readiness fails", async () => {
	const h = setup({
		readinessProbe: async () => false,
		controlHandler: async (request, response) => {
			if (request.url !== "/v1/accounts/self/configuration") return false;
			response.writeHead(204).end();
			return true;
		},
	});
	await h.service.start();
	expect(
		(
			await fetch(`${h.base()}/v1/accounts/self/configuration`, {
				method: "PUT",
			})
		).status,
	).toBe(204);
	expect(
		(
			await fetch(
				`${h.base()}/v1/leases/00000000-0000-0000-0000-000000000000/jit`,
				{
					method: "POST",
				},
			)
		).status,
	).toBe(503);
});

it("expires cached readiness while a long reconciliation tick is still active", async () => {
	const h = setup({ probeIntervalMs: 30 });
	const lease = await reserve(h);
	h.store.transition(
		lease.id,
		["reserved"],
		(entry) => {
			entry.state = "dispatched";
			entry.hostRunId = 22;
		},
		"ci.LeaseDispatched",
		h.relay.now(),
	);
	const gate = deferred();
	const entered = deferred();
	finish.push(gate.resolve);
	h.relay.reconcile = async () => {
		entered.resolve();
		await gate.promise;
	};
	await h.service.start();
	await entered.promise;
	expect(h.service.ready()).toBe(true);
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(h.service.ready()).toBe(false);
	expect((await fetch(`${h.base()}/readyz`)).status).toBe(503);
});

it("drains an accepted webhook through durable commit before closing the store", async () => {
	const h = setup();
	const gate = deferred();
	const entered = deferred();
	finish.push(gate.resolve);
	const original = h.relay.webhook.bind(h.relay);
	h.relay.webhook = async (...args) => {
		entered.resolve();
		await gate.promise;
		const result = await original(...args);
		h.history.push("committed");
		return result;
	};
	await h.service.start();
	await expect.poll(() => h.service.ready()).toBe(true);
	const payload = signed(queued());
	const response = fetch(`${h.base()}/github/webhooks`, {
		method: "POST",
		headers: {
			"x-github-event": "workflow_job",
			"x-hub-signature-256": payload.signature,
		},
		body: payload.body,
	});
	await entered.promise;
	const stopping = h.service.stop();
	expect(h.service.ready()).toBe(false);
	expect(h.history).toEqual(["recover"]);
	gate.resolve();
	expect((await response).status).toBe(202);
	expect(await stopping).toEqual({ drained: true });
	expect(h.history).toEqual(["recover", "committed", "close"]);
	expect(await h.service.stop()).toEqual({ drained: true });
});

it("bounds shutdown after a disconnected webhook without closing its live store", async () => {
	const h = setup({ drainTimeoutMs: 25 });
	const gate = deferred();
	const entered = deferred();
	finish.push(gate.resolve);
	const original = h.relay.webhook.bind(h.relay);
	h.relay.webhook = async (...args) => {
		entered.resolve();
		await gate.promise;
		const result = await original(...args);
		h.history.push("committed");
		return result;
	};
	await h.service.start();
	await expect.poll(() => h.service.ready()).toBe(true);
	const payload = signed(queued());
	const client = request(`${h.base()}/github/webhooks`, {
		method: "POST",
		headers: {
			"x-github-event": "workflow_job",
			"x-hub-signature-256": payload.signature,
		},
	});
	client.on("error", () => {});
	client.end(payload.body);
	await entered.promise;
	client.destroy();
	expect(await h.service.stop()).toEqual({ drained: false });
	expect(h.history).toEqual(["recover"]);
	expect(h.logs).toContainEqual({
		level: "error",
		event: "service.drain_timeout",
	});
	gate.resolve();
	await expect.poll(() => h.history).toEqual(["recover", "committed", "close"]);
});

it("waits for an active worker during stop and starts no subsequent dispatch", async () => {
	const h = setup();
	const lease = await reserve(h);
	h.store.transition(
		lease.id,
		["reserved"],
		(entry) => {
			entry.state = "dispatched";
			entry.hostRunId = 22;
		},
		"ci.LeaseDispatched",
		h.relay.now(),
	);
	const gate = deferred();
	const entered = deferred();
	finish.push(gate.resolve);
	h.relay.reconcile = async () => {
		entered.resolve();
		await gate.promise;
	};
	let dispatches = 0;
	h.relay.dispatchPending = async () => {
		dispatches++;
	};
	await h.service.start();
	await entered.promise;
	const stopping = h.service.stop();
	expect(h.history).toEqual(["recover"]);
	gate.resolve();
	expect(await stopping).toEqual({ drained: true });
	expect(dispatches).toBe(0);
	expect(h.history).toEqual(["recover", "close"]);
});

it("logs a failed refresh, recovers on the next probe, and never logs exception content", async () => {
	let refreshes = 0;
	const h = setup({
		probeIntervalMs: 10,
		beforeDispatch: async () => {
			refreshes++;
			if (refreshes === 1) throw new Error("private config and token");
		},
	});
	await h.service.start();
	await expect.poll(() => h.service.ready()).toBe(true);
	expect(h.logs).toContainEqual({
		level: "error",
		event: "worker.tick_failed",
	});
	expect(JSON.stringify(h.logs)).not.toContain("private");
});
