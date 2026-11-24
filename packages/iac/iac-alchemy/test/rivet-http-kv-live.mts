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
import type { TestContext } from "vitest";
import {
	createRivetHttpKvApplication,
	createRivetHttpKvMappers,
} from "../src/rivet-http-kv.ts";
import { createRivetAsyncKvActor } from "../src/rivet-kv.ts";

const require = createRequire(import.meta.url);
const rivetRequire = createRequire(require.resolve("rivetkit"));
const { getEnginePath } = rivetRequire("@rivetkit/engine-cli");

const reservePort = (): Promise<[number, Server]> =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: Node can return a path or null instead of a TCP address. */
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("TCP test port is unavailable"));
				return;
			}
			/* oxlint-enable anti-slop/no-runtime-typeof */
			resolve([address.port, server]);
		});
	});
const ports = await Promise.all([
	reservePort(),
	reservePort(),
	reservePort(),
	reservePort(),
	reservePort(),
]);
const [enginePort, peerPort, metricsPort, httpPort, combinedHttpPort] = [
	ports[0][0],
	ports[1][0],
	ports[2][0],
	ports[3][0],
	ports[4][0],
];
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
const callbacks: Array<Parameters<TestContext["onTestFinished"]>[0]> = [];
// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: RivetKit 3.0.0 setupTest reads only this hook from Vitest's context.
const fixtureContext = {
	onTestFinished(callback: Parameters<TestContext["onTestFinished"]>[0]) {
		callbacks.push(callback);
	},
} as TestContext;
let combinedRegistry: ReturnType<typeof setup> | undefined;
let fixedClient: ReturnType<typeof createClient> | undefined;
const storage = createRivetAsyncKvActor({
	actorName: "store",
	semanticDigest: `sha256:${"a".repeat(64)}`,

	verifyIngress: ({ actorName }) => actorName === "store",
	authorize: ({ actorKey, headers }) =>
		["tenant-a", "tenant-b"].includes(actorKey[0] ?? "") &&
		headers.get("authorization") === "test",
});
const registry = setup({
	use: { store: storage.actor },
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
	const { client } = await setupTest(fixtureContext, registry);

	const withinSetupDeadline = async <T,>(
		promise: PromiseLike<T>,
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
	/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- SAFETY: parse an SDK rejection before retrying its explicit overload response. */
	const isOverloaded = (error: unknown): boolean =>
		typeof error === "object" &&
		error !== null &&
		"group" in error &&
		error.group === "depot" &&
		"code" in error &&
		error.code === "overloaded";
	/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters */
	const resolveReady = async (actorKey: string[]) => {
		const deadline = Date.now() + 30_000;
		let actorId: string | undefined;
		while (actorId === undefined) {
			try {
				actorId = await withinSetupDeadline(
					client.store.getOrCreate(actorKey).resolve(),
					deadline,
				);
			} catch (error) {
				if (!isOverloaded(error) || Date.now() >= deadline) throw error;
				await new Promise((resolve) => setTimeout(resolve, 150));
			}
		}
		const handle = client.store.getForId(actorId);
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

	const actorKey = ["tenant-a", "application"];
	const { actorId } = await resolveReady(actorKey);
	await registry.shutdown();
	const liveClient = createClient({ endpoint: publicUrl, token });
	fixedClient = liveClient;
	const liveStore = liveClient.store;
	if (liveStore === undefined) throw new Error("store client is unavailable");
	const attestations: string[] = [];
	const journal: Array<{ requestId: string; fingerprint: string }> = [];
	let dispatches = 0;
	let scopeActive = true;
	let revokeOnFetch = false;
	const application = createRivetHttpKvApplication({
		actorName: "web",
		storage,
		transport: {
			actorName: "store",
			actorId,
			actorKey,
			semanticDigest: `sha256:${"a".repeat(64)}`,
			verifyTransport: (claim) => {
				attestations.push(claim.phase);
				if (claim.phase === "dispatch")
					journal.push({
						requestId: claim.requestId,
						fingerprint: claim.fingerprint,
					});

				return claim.actorId === actorId && claim.singleDispatch === true;
			},
			fetch: async (path, init) => {
				dispatches++;
				const headers = new Headers(init.headers);
				headers.set("authorization", "test");
				const response = await liveStore
					.getForId(actorId)
					.fetch(path, { ...init, headers });
				if (revokeOnFetch) scopeActive = false;
				return response;
			},
		},
		verifyScope: (claim) =>
			scopeActive &&
			claim.scope.actorId === actorId &&
			claim.scope.actorKey.join("/") === "tenant-a/application",
		authorize: ({ actorKey, request }) =>
			actorKey[0] === "tenant-a" &&
			request.headers.get("authorization") === "http-test",
		application: (kv) => async (request) => {
			const path = new URL(request.url).pathname;
			if (path === "/ready") return new Response("ready");
			if (path === "/write")
				return Response.json(
					await kv.set("greeting", new TextEncoder().encode("hello")),
				);
			const result = await kv.get("greeting");
			return result.status === "ok"
				? Response.json({
						status: "ok",
						value: result.value && new TextDecoder().decode(result.value),
					})
				: Response.json(result);
		},
	});
	combinedRegistry = setup({
		use: { web: application.http.actor, store: storage.actor },
		noWelcome: true,
		endpoint: publicUrl,
		token,
		startEngine: false,
		httpHost: "127.0.0.1",
		httpPort: combinedHttpPort,
		shutdown: { gracePeriodMs: 2000, disableSignalHandlers: true },
	});
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
	const mapper = createRivetHttpKvMappers({
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
	const { client: combined } = await setupTest(
		fixtureContext,
		combinedRegistry,
	);
	const combinedWeb = combined.web;
	if (combinedWeb === undefined) throw new Error("web client is unavailable");
	const deadline = Date.now() + 30_000;
	let webId: string | undefined;
	while (webId === undefined) {
		try {
			webId = await withinSetupDeadline(
				combinedWeb.getOrCreate(["tenant-a"]).resolve(),
				deadline,
			);
		} catch (error) {
			if (!isOverloaded(error) || Date.now() >= deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}
	const web = combinedWeb.getForId(webId);
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
	if (write.status !== 200 || written.status !== "ok")
		throw new Error(`write failed: ${JSON.stringify(written)}`);
	const read = await web.fetch("/read", {
		method: "GET",
		redirect: "error",
		headers: { authorization: "http-test" },
	});
	const value = await read.json();
	if (read.status !== 200 || value.status !== "ok" || value.value !== "hello")
		throw new Error(`read failed: ${JSON.stringify(value)}`);
	if (
		dispatches !== 2 ||
		attestations.join(",") !== "dispatch,receipt,dispatch,receipt"
	)
		throw new Error(`unexpected transport calls ${dispatches} ${attestations}`);
	const denied = await web.fetch("/read", {
		method: "GET",
		redirect: "error",
		headers: { authorization: "other" },
	});
	if (denied.status !== 403 || dispatches !== 2)
		throw new Error("HTTP principal denial reached KV");
	await denied.arrayBuffer();
	revokeOnFetch = true;
	const revoked = await web.fetch("/read", {
		method: "GET",
		redirect: "error",
		headers: { authorization: "http-test" },
	});
	const revokedBody = await revoked.json();
	if (
		revoked.status !== 503 ||
		revokedBody.execution !== "possibly-completed" ||
		Number(dispatches) !== 3
	)
		throw new Error(
			`revoked result was disclosed: ${JSON.stringify(revokedBody)}`,
		);
	/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: the fixture verifies the host recorded the opaque operation correlation. */
	if (
		typeof journal[2]?.requestId !== "string" ||
		typeof journal[2]?.fingerprint !== "string"
	)
		throw new Error("host journal did not retain the operation correlation");
	/* oxlint-enable anti-slop/no-runtime-typeof */
	process.stdout.write(
		"rivet-http-kv-live-ok source-auth=stub pool-host=stub ingress=unverified receipt-auth=unverified host-journal=unverified",
	);
} catch (error) {
	process.stderr.write(`Rivet engine log:\n${engineLog}\n`);
	throw error;
} finally {
	for (const callback of callbacks) await callback(fixtureContext);
	if (fixedClient) await fixedClient.dispose();
	if (combinedRegistry) await combinedRegistry.shutdown();
	await registry.shutdown();
	if (engine.exitCode === null && engine.signalCode === null)
		engine.kill("SIGTERM");
	const timer = setTimeout(() => engine.kill("SIGKILL"), 5000);
	await engineDone;
	clearTimeout(timer);
}
