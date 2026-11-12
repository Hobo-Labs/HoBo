import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ConfigurationSchema } from "@hobo/ci";
import { SqliteCiStore } from "@hobo/ci/sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { relayInstallAssets } from "../src/assets.js";
import type { GithubAppTransport } from "../src/github.js";
import {
	createRelayHandler,
	type HostedRelayApplication,
} from "../src/http-handler.js";
import { createRelayHost } from "../src/relay-host.js";
import {
	admitWhenReady,
	createRelayService,
	type RelayServiceLog,
	type RelayServiceOptions,
} from "../src/service.js";
import { config, job, NOW, queued, SECRET, signed } from "./fixtures.js";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const services: { stop(): Promise<{ drained: boolean }> }[] = [];
const finish: (() => void)[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const release of finish.splice(0)) release();
	await Promise.all(services.splice(0).map((service) => service.stop()));
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function address(service: ReturnType<typeof createRelayService>): string {
	const { port } = z
		.object({ port: z.number() })
		.parse(service.server.address());
	return `http://127.0.0.1:${port}`;
}
/** The service around the shared handler, with the relay behind it replaced. */
function setup(
	overrides: Partial<RelayServiceOptions> = {},
	application: Partial<HostedRelayApplication> = {},
) {
	const logs: RelayServiceLog[] = [];
	const history: string[] = [];
	const service = createRelayService({
		origin: "https://relay.example",
		handle: (ready) =>
			createRelayHandler({
				application: admitWhenReady(
					{
						ingestWebhook: async () => "accepted",
						claim: async () => Response.json({ encodedJitConfig: "dGVzdA==" }),
						control: async () => undefined,
						ready: async () => true,
						...application,
					},
					ready,
				),
				webhookSecret: SECRET,
			}),
		tick: async () => {},
		close: () => {
			history.push("close");
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
	return { service, logs, history, base: () => address(service) };
}
function delivery(id = 1) {
	const payload = signed(queued(id));
	return {
		method: "POST",
		headers: {
			"x-github-event": "workflow_job",
			"x-github-delivery": `delivery-${id}`,
			"x-hub-signature-256": payload.signature,
		},
		body: payload.body,
	};
}

it("gates startup and permissions, and caches readiness probes", async () => {
	const gate = deferred();
	finish.push(gate.resolve);
	let probes = 0;
	let permitted = true;
	let admitted = 0;
	const h = setup(
		{
			readinessProbe: async () => {
				probes++;
				await gate.promise;
				return permitted;
			},
		},
		{
			ingestWebhook: async () => {
				admitted++;
				return "accepted";
			},
		},
	);
	await h.service.start();
	const initial = await fetch(`${h.base()}/readyz`);
	expect(initial.status).toBe(503);
	expect(await initial.json()).toEqual({
		ready: false,
		engines: { "gh-actions": { ready: false } },
	});
	expect((await fetch(`${h.base()}/healthz`)).status).toBe(200);
	// An authentic delivery is refused, for GitHub to redeliver, until the probe passes.
	expect((await fetch(`${h.base()}/github/webhooks`, delivery())).status).toBe(
		503,
	);
	expect(admitted).toBe(0);
	gate.resolve();
	await expect.poll(() => h.service.ready()).toBe(true);
	expect((await fetch(`${h.base()}/readyz`)).status).toBe(200);
	expect((await fetch(`${h.base()}/github/webhooks`, delivery())).status).toBe(
		202,
	);
	expect(admitted).toBe(1);
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
	const directory = mkdtempSync(join(tmpdir(), "hobo-ci-service-"));
	directories.push(directory);
	const store = new SqliteCiStore(join(directory, "relay.sqlite"));
	const configuration = config();
	const account = configuration.accounts[0];
	const offer = account?.offers[0];
	if (!account || !offer) throw new Error("fixture account missing");
	offer.concurrency = 3;
	offer.freeMinutes = 30;
	await store.configure(configuration, 0, NOW);
	// The worker visits leases in id order; give each position its role.
	const leases: string[] = [];
	for (const id of [1, 2, 3]) {
		const lease = await store.reserve(account, job(id), NOW);
		if (!lease) throw new Error("fixture lease not reserved");
		leases.push(lease.id);
	}
	leases.sort();
	const hosts = [
		{ state: "running", hostRunId: 10 },
		{ state: "uncertain", hostRunId: 0 },
		{ state: "running", hostRunId: 20 },
	];
	for (const [index, host] of hosts.entries()) {
		const id = leases[index];
		if (!id) throw new Error("fixture lease missing");
		await store.transition(
			id,
			["reserved"],
			(entry) => {
				entry.state = host.state;
				entry.hostRunId = host.hostRunId;
			},
			"ci.FixtureHost",
			NOW,
		);
	}
	const gate = deferred();
	finish.push(gate.resolve);
	const seen: string[] = [];
	const github: GithubAppTransport = {
		async appRequest() {
			throw new Error("unexpected App request");
		},
		async request(_installation, path) {
			if (path.endsWith("/actions/runs/10")) {
				seen.push("reconcile:10");
				throw new Error("secret GitHub response");
			}
			if (path.includes("/actions/workflows/host.yml/runs?")) {
				seen.push("discover");
				return Response.json({ workflow_runs: [] });
			}
			if (path.endsWith("/actions/runs/20")) {
				seen.push("reconcile:20");
				await gate.promise;
				throw new Error("host completion not established");
			}
			throw new Error(`unexpected GitHub read: ${path}`);
		},
	};
	const pending = vi.spyOn(store, "pendingJobs");
	const logs: RelayServiceLog[] = [];
	const { service } = createRelayHost({
		store,
		github,
		identity: {
			verify: async () => {
				throw new Error("unexpected runner identity request");
			},
		},
		webhookSecret: SECRET,
		authenticate: () => undefined,
		publicOrigin: "https://relay.example",
		assets: relayInstallAssets(),
		port: 0,
		tickIntervalMs: 10,
		logger: (entry) => logs.push(entry),
		now: () => NOW,
	});
	services.push(service);
	await service.start();
	await expect
		.poll(() => seen)
		.toEqual(["reconcile:10", "discover", "reconcile:20"]);
	// Later timer ticks do not start a second pass over the leases, and the
	// outbox is not drained before the pass over known leases has finished.
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(seen).toHaveLength(3);
	expect(pending).not.toHaveBeenCalled();
	gate.resolve();
	await expect.poll(() => pending.mock.calls.length).toBeGreaterThan(0);
	expect(logs).toContainEqual({
		level: "error",
		event: "worker.lease_failed",
		leaseId: leases[0],
	});
	expect(logs).toContainEqual({
		level: "error",
		event: "worker.lease_failed",
		leaseId: leases[2],
	});
	expect(logs.filter((entry) => entry.leaseId === leases[1])).toEqual([]);
	expect(JSON.stringify(logs)).not.toContain("secret");
});

it("keeps control-plane setup available while provider readiness fails", async () => {
	let claims = 0;
	const h = setup(
		{ readinessProbe: async () => false },
		{
			control: async (request) =>
				new URL(request.url).pathname === "/v1/accounts/self/configuration"
					? new Response(null, { status: 204 })
					: undefined,
			claim: async () => {
				claims++;
				return Response.json({ encodedJitConfig: "dGVzdA==" });
			},
		},
	);
	await h.service.start();
	expect(
		(
			await fetch(`${h.base()}/v1/accounts/self/configuration`, {
				method: "PUT",
			})
		).status,
	).toBe(204);
	const claim = await fetch(
		`${h.base()}/v1/leases/00000000-0000-0000-0000-000000000000/jit`,
		{ method: "POST", headers: { authorization: "Bearer identity-token" } },
	);
	expect(claim.status).toBe(403);
	expect(await claim.json()).toEqual({ error: "claim rejected" });
	expect(claims).toBe(0);
});

it("expires cached readiness while a long worker tick is still active", async () => {
	const gate = deferred();
	const entered = deferred();
	finish.push(gate.resolve);
	const h = setup({
		probeIntervalMs: 30,
		tick: async () => {
			entered.resolve();
			await gate.promise;
		},
	});
	await h.service.start();
	await entered.promise;
	expect(h.service.ready()).toBe(true);
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(h.service.ready()).toBe(false);
	expect((await fetch(`${h.base()}/readyz`)).status).toBe(503);
});

it("drains an accepted webhook through durable commit before closing the store", async () => {
	const gate = deferred();
	const entered = deferred();
	finish.push(gate.resolve);
	const history: string[] = [];
	const h = setup(
		{
			close: () => {
				history.push("close");
			},
		},
		{
			ingestWebhook: async () => {
				entered.resolve();
				await gate.promise;
				history.push("committed");
				return "accepted";
			},
		},
	);
	await h.service.start();
	await expect.poll(() => h.service.ready()).toBe(true);
	const response = fetch(`${h.base()}/github/webhooks`, delivery());
	await entered.promise;
	const stopping = h.service.stop();
	expect(h.service.ready()).toBe(false);
	expect(history).toEqual([]);
	gate.resolve();
	expect((await response).status).toBe(202);
	expect(await stopping).toEqual({ drained: true });
	expect(history).toEqual(["committed", "close"]);
	expect(await h.service.stop()).toEqual({ drained: true });
});

it("bounds shutdown after a disconnected webhook without closing its live store", async () => {
	const gate = deferred();
	const entered = deferred();
	finish.push(gate.resolve);
	const history: string[] = [];
	const h = setup(
		{
			drainTimeoutMs: 25,
			close: () => {
				history.push("close");
			},
		},
		{
			ingestWebhook: async () => {
				entered.resolve();
				await gate.promise;
				history.push("committed");
				return "accepted";
			},
		},
	);
	await h.service.start();
	await expect.poll(() => h.service.ready()).toBe(true);
	const { headers, body } = delivery();
	const client = request(`${h.base()}/github/webhooks`, {
		method: "POST",
		headers,
	});
	client.on("error", () => {});
	client.end(body);
	await entered.promise;
	client.destroy();
	expect(await h.service.stop()).toEqual({ drained: false });
	expect(history).toEqual([]);
	expect(h.logs).toContainEqual({
		level: "error",
		event: "service.drain_timeout",
	});
	gate.resolve();
	await expect.poll(() => history).toEqual(["committed", "close"]);
});

it("waits for an active worker during stop and starts no subsequent tick", async () => {
	const gate = deferred();
	const entered = deferred();
	finish.push(gate.resolve);
	let ticks = 0;
	const h = setup({
		tick: async () => {
			ticks++;
			entered.resolve();
			await gate.promise;
		},
	});
	await h.service.start();
	await entered.promise;
	const stopping = h.service.stop();
	expect(h.history).toEqual([]);
	gate.resolve();
	expect(await stopping).toEqual({ drained: true });
	expect(ticks).toBe(1);
	expect(h.history).toEqual(["close"]);
});

it("logs a failed tick, runs the next one, and never logs exception content", async () => {
	let ticks = 0;
	const h = setup({
		tick: async () => {
			ticks++;
			if (ticks === 1) throw new Error("private config and token");
		},
	});
	await h.service.start();
	await expect.poll(() => ticks).toBeGreaterThan(1);
	expect(h.service.ready()).toBe(true);
	expect(h.logs).toContainEqual({
		level: "error",
		event: "worker.tick_failed",
	});
	expect(JSON.stringify(h.logs)).not.toContain("private");
});

it("answers 503 and logs when the handler itself throws, without the reason", async () => {
	const h = setup({
		handle: () => async () => {
			throw new Error("private stack detail");
		},
	});
	await h.service.start();
	const response = await fetch(`${h.base()}/healthz`);
	expect(response.status).toBe(503);
	expect(await response.text()).toBe('{"error":"service unavailable"}');
	expect(h.logs).toContainEqual({
		level: "error",
		event: "service.http_failed",
	});
	expect(JSON.stringify(h.logs)).not.toContain("private");
});

it("starts from an empty configuration and reports the engine map", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-ci-service-"));
	directories.push(directory);
	const store = new SqliteCiStore(join(directory, "relay.sqlite"));
	await store.configure(create(ConfigurationSchema), 0, NOW);
	const { service } = createRelayHost({
		store,
		github: {
			appRequest: async () => new Response(null, { status: 500 }),
			request: async () => new Response(null, { status: 500 }),
		},
		identity: {
			verify: async () => {
				throw new Error("unexpected runner identity request");
			},
		},
		webhookSecret: SECRET,
		authenticate: () => undefined,
		publicOrigin: "https://relay.example",
		assets: relayInstallAssets(),
		port: 0,
		stubEngines: { vercel: { ready: () => true } },
	});
	services.push(service);
	await service.start();
	expect(await service.checkReadiness()).toBe(true);
	const ready = await fetch(`${address(service)}/readyz`);
	expect(ready.status).toBe(200);
	expect(await ready.json()).toEqual({
		ready: true,
		engines: { "gh-actions": { ready: true }, vercel: { ready: true } },
	});
});

it("runs the optional agent beside the worker: never overlapping, never delaying a tick, and drained on stop", async () => {
	const gate = deferred();
	finish.push(gate.resolve);
	let ticks = 0;
	let passes = 0;
	let active = 0;
	let overlapped = false;
	const h = setup({
		tick: async () => {
			ticks++;
		},
		agentIntervalMs: 10,
		agentTick: async () => {
			passes++;
			active++;
			overlapped ||= active > 1;
			if (passes === 1) await gate.promise;
			active--;
			if (passes === 2) throw new Error("model said: secret repository text");
		},
	});
	await h.service.start();
	await vi.waitFor(() => expect(passes).toBe(1));
	// The first pass is still waiting on its model; the relay keeps ticking.
	const before = ticks;
	await vi.waitFor(() => expect(ticks).toBeGreaterThan(before + 3));
	expect(passes).toBe(1);
	gate.resolve();
	await vi.waitFor(() => expect(passes).toBeGreaterThanOrEqual(3));
	expect(overlapped).toBe(false);
	// A failed pass is logged without its reason, and the next one still ran.
	expect(h.logs.filter((entry) => entry.event === "agent.tick_failed")).toEqual(
		[{ level: "error", event: "agent.tick_failed" }],
	);
	expect(h.logs.some((entry) => entry.event === "worker.tick_failed")).toBe(
		false,
	);

	const slow = deferred();
	finish.push(slow.resolve);
	let finished = false;
	const draining = setup({
		agentIntervalMs: 5,
		agentTick: async () => {
			await slow.promise;
			finished = true;
		},
	});
	await draining.service.start();
	await vi.waitFor(() => expect(draining.service.ready()).toBe(true));
	await new Promise((resolve) => setTimeout(resolve, 30));
	const stopped = draining.service.stop();
	expect(draining.history).toEqual([]);
	slow.resolve();
	expect(await stopped).toEqual({ drained: true });
	expect(finished).toBe(true);
	expect(draining.history).toEqual(["close"]);
});

it("does not schedule an agent that was not configured, and does not run one before readiness", async () => {
	let passes = 0;
	const h = setup({
		agentIntervalMs: 5,
		agentTick: async () => {
			passes++;
		},
		readinessProbe: async () => false,
	});
	await h.service.start();
	await new Promise((resolve) => setTimeout(resolve, 60));
	expect(passes).toBe(0);
	expect(() => setup({ agentIntervalMs: 0 })).toThrow("invalid agent interval");
});
