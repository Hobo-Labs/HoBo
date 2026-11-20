import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { actor, setup } from "rivetkit";
import { setupTest } from "rivetkit/test";

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

const MAX_ATTEMPTS = 3;
const token = "local-test-token";
const counter = actor({
	state: { n: 0 },
	actions: { increment: (context) => ++context.state.n },
});

for (let attempt = 1; ; attempt++) {
	const ports = await Promise.all(Array.from({ length: 4 }, reservePort));
	const [enginePort, peerPort, metricsPort, httpPort] = ports.map(
		([port]) => port,
	);
	for (const [, server] of ports)
		await new Promise((resolve) => server.close(resolve));

	const logDirectory = join(process.cwd(), `engine-log-${attempt}`);
	const objects = join(process.cwd(), `engine-objects-${attempt}`);
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
	let engineLog = "";
	const startEngine = () => {
		const child = spawn(getEnginePath(), ["--config", configFile], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		for (const stream of [child.stdout, child.stderr]) {
			stream.on("data", (chunk) => {
				engineLog = (engineLog + chunk).slice(-12000);
			});
		}
		const done = once(child, "exit");
		return { child, done };
	};
	let engine = startEngine();
	const stopEngine = async () => {
		if (engine.child.exitCode === null && engine.child.signalCode === null)
			engine.child.kill("SIGTERM");
		const timer = setTimeout(() => engine.child.kill("SIGKILL"), 5000);
		await engine.done;
		clearTimeout(timer);
	};
	const callbacks = [];
	const registry = setup({
		use: { counter },
		noWelcome: true,
		endpoint: publicUrl,
		token,
		startEngine: false,
		httpHost: "127.0.0.1",
		httpPort,
		shutdown: { gracePeriodMs: 2000, disableSignalHandlers: true },
	});
	let failure: unknown;
	try {
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
		await stopEngine();
		engine = startEngine();
		const readinessDeadline = Date.now() + 10_000;
		for (;;) {
			try {
				await fetch(publicUrl);
				break;
			} catch (error) {
				if (Date.now() >= readinessDeadline) throw error;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		if ((await handle.increment()) !== 3)
			throw new Error("Rivet actor state did not survive engine restart");
	} catch (error) {
		failure = error;
	} finally {
		for (const callback of callbacks) await callback();
		await registry.shutdown();
		await stopEngine();
	}
	if (failure === undefined) {
		process.stdout.write("rivet3-live-ok");
		break;
	}
	const retryable = String(failure).includes("EADDRINUSE");
	if (!retryable || attempt === MAX_ATTEMPTS) {
		process.stderr.write(`Rivet engine log:\n${engineLog}\n`);
		throw failure;
	}
}
