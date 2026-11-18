import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { actor, setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { createRivetHttpActor } from "../src/rivet-runtime.ts";

const require = createRequire(import.meta.url);
const rivetRequire = createRequire(require.resolve("rivetkit"));
const { getEnginePath } = rivetRequire("@rivetkit/engine-cli");

const reservePort = () =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () =>
			resolve([server.address().port, server]),
		);
	});
const ports = await Promise.all(Array.from({ length: 4 }, reservePort));
const [enginePort, peerPort, metricsPort, httpPort] = ports.map(
	([port]) => port,
);
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
const callbacks = [];
const counter = actor({
	state: { n: 0 },
	actions: { increment: (context) => ++context.state.n },
});
const app = createRivetHttpActor({
	actorName: "web",
	entrypoint: () => {
		let requests = 0;
		return async (request) => {
			const body = request.method === "POST" ? `:${await request.text()}` : "";
			return new Response(
				`app:${new URL(request.url).pathname}:${++requests}${body}`,
			);
		};
	},
	authorize: ({ actorKey }) => actorKey[0] !== "tenant-b",
});
const registry = setup({
	use: { counter, web: app.actor },
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
	const { client } = await setupTest(
		{
			onTestFinished(callback) {
				callbacks.push(callback);
			},
		},
		registry,
	);
	const handle = client.counter.getOrCreate(["test"]);
	if ((await handle.increment()) !== 1 || (await handle.increment()) !== 2)
		throw new Error("Rivet actor state did not advance");
	const ok = await client.web.getOrCreate(["tenant-a"]).fetch("/hello");
	if (ok.status !== 200 || (await ok.text()) !== "app:/hello:1")
		throw new Error("Rivet did not invoke the bound application");
	const again = await client.web.getOrCreate(["tenant-a"]).fetch("/hello");
	if (again.status !== 200 || (await again.text()) !== "app:/hello:2")
		throw new Error(
			"Rivet did not preserve the application for the same actor",
		);
	const posted = await client.web.getOrCreate(["tenant-a"]).fetch("/post", {
		method: "POST",
		body: "streamed request body",
	});
	if (
		posted.status !== 200 ||
		(await posted.text()) !== "app:/post:3:streamed request body"
	)
		throw new Error("Rivet did not deliver the transferred request body");
	const other = await client.web.getOrCreate(["tenant-c"]).fetch("/hello");
	if (other.status !== 200 || (await other.text()) !== "app:/hello:1")
		throw new Error("Rivet shared the application between actors");
	const forbidden = await client.web.getOrCreate(["tenant-b"]).fetch("/hello");
	if (forbidden.status !== 403)
		throw new Error("Rivet actor authorization was bypassed");
	process.stdout.write("rivet3-live-ok");
} catch (error) {
	process.stderr.write(`Rivet engine log:\n${engineLog}\n`);
	throw error;
} finally {
	for (const callback of callbacks) await callback();
	await registry.shutdown();
	if (engine.exitCode === null && engine.signalCode === null)
		engine.kill("SIGTERM");
	const timer = setTimeout(() => engine.kill("SIGKILL"), 5000);
	await engineDone;
	clearTimeout(timer);
}
