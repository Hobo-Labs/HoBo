/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: Node reports a TCP or Unix socket address at this operating-system boundary. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { setup } from "rivetkit";
import { createClient } from "rivetkit/client";
import { setupTest } from "rivetkit/test";
import {
	createRivetHttpQueueApplication,
	createRivetHttpQueueMappers,
} from "../src/rivet-http-queue.ts";
import { createRivetQueueActor } from "../src/rivet-queue-runtime.ts";

const require = createRequire(import.meta.url);
const rivetRequire = createRequire(require.resolve("rivetkit"));
const { getEnginePath } = rivetRequire("@rivetkit/engine-cli");

const reservePort = () =>
	new Promise<readonly [number, Server]>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("test listener has no TCP address"));
				return;
			}
			resolve([address.port, server]);
		});
	});
const ports = await Promise.all([
	reservePort(),
	reservePort(),
	reservePort(),
	reservePort(),
	reservePort(),
] as const);
const [
	[enginePort],
	[peerPort],
	[metricsPort],
	[httpPort],
	[combinedHttpPort],
] = ports;
for (const [, server] of ports)
	await new Promise((resolve) => server.close(resolve));

const token = "local-test-token";
const logDirectory = join(process.cwd(), "log");
const objects = join(process.cwd(), "objects");
await mkdir(logDirectory);
await mkdir(objects);
const publicUrl = `http://127.0.0.1:${enginePort}`;
const config = {
	auth: { admin_token: token },
	guard: { host: "127.0.0.1", port: enginePort },
	api_peer: { host: "127.0.0.1", port: peerPort },
	metrics: { host: "127.0.0.1", port: metricsPort },
	topology: {
		datacenter_label: 1,
		datacenters: {
			default: {
				datacenter_label: 1,
				is_leader: true,
				public_url: publicUrl,
				peer_url: `http://127.0.0.1:${peerPort}`,
			},
		},
	},
	storage: {
		log_directory: logDirectory,
		auto_provision_partitions: 1,
		balancing: { enabled: false },
		log_shard: {
			max_disk_bytes: 268435456,
			segment_bytes: 16777216,
			preallocate_segments: 1,
		},
		cold_store: { disk_cache_bytes: 0 },
		write_to_cold_after_ms: 500,
		stop_timeout_ms: 1500,
		stop_teardown_ms: 1000,
	},
	object_storage: { primary: { file_system: { path: objects } } },
	telemetry: { enabled: false },
	runtime: {
		worker_shutdown_duration: 1,
		guard_shutdown_duration: 1,
		force_shutdown_duration: 5,
	},
};
const configFile = join(process.cwd(), "engine.json");
await writeFile(configFile, JSON.stringify(config));
const engine = spawn(getEnginePath(), ["--config", configFile], {
	stdio: ["ignore", "pipe", "pipe"],
});
let engineLog = "";
for (const stream of [engine.stdout, engine.stderr]) {
	stream.on("data", (chunk) => {
		engineLog = (engineLog + chunk).slice(-12000);
	});
}
const engineDone = once(engine, "exit");
const callbacks: Array<() => void | Promise<void>> = [];
let combinedRegistry: ReturnType<typeof setup> | undefined;
let fixedClient: { dispose(): Promise<void> } | undefined;
const queue = createRivetQueueActor({
	actorName: "jobs",
	now: () => Date.now(),

	verifyIngress: () => true,
	authorize: ({ actorKey, headers }) =>
		actorKey[0] === "tenant-a" && headers.get("authorization") === "test",
});
const registry = setup({
	use: { jobs: queue.actor },
	noWelcome: true,
	endpoint: publicUrl,
	token,
	startEngine: false,
	httpHost: "127.0.0.1",
	httpPort,
	shutdown: { gracePeriodMs: 2000, disableSignalHandlers: true },
});
try {
	const startupDeadline = Date.now() + 30_000;
	let ready = false;
	while (Date.now() < startupDeadline) {
		if (engine.exitCode !== null || engine.signalCode !== null)
			throw new Error("Rivet engine exited before becoming ready");
		try {
			const response = await fetch(publicUrl, {
				signal: AbortSignal.timeout(500),
			});
			await response.arrayBuffer();
			ready = true;
			break;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	if (!ready)
		throw new Error("Rivet engine did not become ready within 30 seconds");
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: setupTest only uses the provided finished callback in this fixture.
	const { client } = await setupTest(
		{
			onTestFinished(callback: () => void | Promise<void>) {
				callbacks.push(callback);
			},
		} as Parameters<typeof setupTest>[0],
		registry,
	);

	const withinSetupDeadline = async <T,>(
		promise: Promise<T>,
		deadline: number,
	): Promise<T> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Rivet setup timed out")),
						Math.max(0, deadline - Date.now()),
					);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};
	const resolveReady = async (actorKey: string[]) => {
		const deadline = Date.now() + 30_000;
		let actorId: string | undefined;
		while (actorId === undefined) {
			try {
				actorId = await withinSetupDeadline(
					client.jobs.getOrCreate(actorKey).resolve(),
					deadline,
				);
			} catch (error) {
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: only optional public error fields are inspected for this retry.
				const code = error as { group?: string; code?: string };
				if (
					code?.group !== "depot" ||
					code?.code !== "overloaded" ||
					Date.now() >= deadline
				)
					throw error;
				await new Promise((resolve) => setTimeout(resolve, 150));
			}
		}
		const handle = client.jobs.getForId(actorId);
		while (Date.now() < deadline) {
			try {
				const response = await withinSetupDeadline(
					handle.fetch("/health", {
						method: "GET",
						redirect: "error",
						signal: AbortSignal.timeout(1_000),
					}),
					deadline,
				);
				const body = await withinSetupDeadline(response.json(), deadline);
				if (response.status === 404 && body.error === "not-found")
					return { actorId, handle };
			} catch {
				void handle;
			}
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
		throw new Error(
			"Rivet actor was not ready within the bounded setup deadline",
		);
	};

	const actorKey = ["tenant-a", "queue-1"];
	const { actorId } = await resolveReady(actorKey);
	await registry.shutdown();
	const pinnedClient = createClient<typeof registry>({
		endpoint: publicUrl,
		token,
	});
	fixedClient = pinnedClient;
	const attestations: string[] = [];
	let dispatches = 0;
	const dispatchCount = () => dispatches;
	let scopeActive = true;
	let revokeOnFetch = false;
	const application = createRivetHttpQueueApplication({
		actorName: "web",
		queue,
		transport: {
			scope: {
				tenantId: "tenant-a",
				instanceId: "queue-1",
				actorName: "jobs",
				actorKey,
			},
			verifyDispatch: (claim) => {
				attestations.push(claim.phase);
				return (
					claim.scope.actorKey.join("/") === "tenant-a/queue-1" &&
					claim.maxAttempts === 1
				);
			},
			verifyResponseBounds: () => true,
			fetch: async (path, init) => {
				dispatches++;
				const headers = new Headers(init.headers);
				headers.set("authorization", "test");
				const response = await pinnedClient.jobs
					.getForId(actorId)
					.fetch(path, { ...init, headers });
				if (revokeOnFetch) scopeActive = false;
				return response;
			},
		},
		verifyScope: (claim) =>
			scopeActive &&
			claim.queue === queue &&
			claim.scope.actorKey.join("/") === "tenant-a/queue-1",
		authorize: ({ actorKey: key, request }) =>
			key[0] === "tenant-a" &&
			request.headers.get("authorization") === "http-test",
		application: (client) => async (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/ready") return new Response("ready");
			if (path === "/write")
				return Response.json(await client.enqueue("order-1", { amount: 1 }));
			return Response.json(await client.dequeue(1, 60_000));
		},
	});
	const combinedSetup = setup({
		use: { web: application.http.actor, jobs: queue.actor },
		noWelcome: true,
		endpoint: publicUrl,
		token,
		startEngine: false,
		httpHost: "127.0.0.1",
		httpPort: combinedHttpPort,
		shutdown: { gracePeriodMs: 2000, disableSignalHandlers: true },
	});
	combinedRegistry = combinedSetup;
	const source = {
		main: new URL(import.meta.url).pathname,
		resourceName: "web",
		actorName: "web",
		kind: "web" as const,
		sourceDigest: `sha256:${"b".repeat(64)}`,
		sourceFence: {
			sourceDigest: `sha256:${"b".repeat(64)}`,
			environmentDigest: `sha256:${"a".repeat(64)}`,
			proofRef: "test:source",
			verify: () => true,
		},
		registry: combinedRegistry,
		binding: application.http,
		verifySource: () => true,
	};
	const mapper = createRivetHttpQueueMappers({
		application,
		source,
		poolDigest: `sha256:${"c".repeat(64)}`,
		isolationDigest: `sha256:${"d".repeat(64)}`,
		poolHost: {
			deployExternal: () => Effect.void,
			deployCrate: () => Effect.void,
		},
		verifyPool: () => true,
	}).web;
	mapper.validate({
		declaration: {
			name: "web",
			kind: "web",
			stableId: "web:web",
			declaredAllow: [],
			dependsOn: [],
			annotations: [],
		},
		entrypoint: application.http.entrypoint,
		requirements: {},
		bindleName: "app",
		dependencyDeclarations: {},
	});
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: setupTest only uses the provided finished callback in this fixture.
	const { client: combined } = await setupTest(
		{
			onTestFinished(callback: () => void | Promise<void>) {
				callbacks.push(callback);
			},
		} as Parameters<typeof setupTest>[0],
		combinedSetup,
	);
	const deadline = Date.now() + 30_000;
	let webId: string | undefined;
	while (webId === undefined) {
		try {
			webId = await withinSetupDeadline(
				combined.web.getOrCreate(["tenant-a"]).resolve(),
				deadline,
			);
		} catch (error) {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: only optional public error fields are inspected for this retry.
			const code = error as { group?: string; code?: string };
			if (
				code?.group !== "depot" ||
				code?.code !== "overloaded" ||
				Date.now() >= deadline
			)
				throw error;
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}
	const web = combined.web.getForId(webId);
	let webReady = false;
	while (Date.now() < deadline) {
		try {
			const response = await withinSetupDeadline(
				web.fetch("/ready", {
					method: "GET",
					redirect: "error",
					headers: { authorization: "http-test" },
					signal: AbortSignal.timeout(1000),
				}),
				deadline,
			);
			if (response.status === 200 && (await response.text()) === "ready") {
				webReady = true;
				break;
			}
		} catch {
			webReady = false;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	if (!webReady) throw new Error("Rivet HTTP actor did not become ready");
	const write = await web.fetch("/write", {
		method: "POST",
		redirect: "error",
		headers: { authorization: "http-test" },
	});
	const written = await write.json();
	if (
		write.status !== 200 ||
		written.idempotencyKey !== "order-1" ||
		written.deduped !== false
	)
		throw new Error(`queue write failed: ${JSON.stringify(written)}`);
	const read = await web.fetch("/consume", {
		method: "POST",
		redirect: "error",
		headers: { authorization: "http-test" },
	});
	const messages = await read.json();
	if (
		read.status !== 200 ||
		messages.length !== 1 ||
		messages[0].body.amount !== 1
	)
		throw new Error(`queue dequeue failed: ${JSON.stringify(messages)}`);
	if (
		dispatchCount() !== 2 ||
		attestations.join(",") !== "before,after,before,after"
	)
		throw new Error(`unexpected transport calls ${dispatches} ${attestations}`);
	const denied = await web.fetch("/write", {
		method: "POST",
		redirect: "error",
		headers: { authorization: "other" },
	});
	if (denied.status !== 403 || dispatchCount() !== 2)
		throw new Error("principal denial reached queue");
	await denied.arrayBuffer();
	revokeOnFetch = true;
	const revoked = await web.fetch("/consume", {
		method: "POST",
		redirect: "error",
		headers: { authorization: "http-test" },
	});
	const revokedBody = await revoked.json();
	if (
		revoked.status !== 503 ||
		revokedBody.execution !== "possibly-completed" ||
		dispatchCount() !== 3
	)
		throw new Error(`revoked result disclosed: ${JSON.stringify(revokedBody)}`);
	process.stdout.write(
		"rivet-http-queue-live-ok source-auth=stub pool-host=stub ingress=unverified receipt-auth=unverified",
	);
} catch (error) {
	process.stderr.write(`Rivet engine log:\n${engineLog}\n`);
	throw error;
} finally {
	for (const callback of callbacks) await callback();
	if (fixedClient) await fixedClient.dispose();
	if (combinedRegistry) await combinedRegistry.shutdown();
	await registry.shutdown();
	if (engine.exitCode === null && engine.signalCode === null)
		engine.kill("SIGTERM");
	const timer = setTimeout(() => engine.kill("SIGKILL"), 5000);
	await engineDone;
	clearTimeout(timer);
}
