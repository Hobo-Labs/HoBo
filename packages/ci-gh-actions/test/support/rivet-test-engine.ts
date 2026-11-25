import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";

const require = createRequire(import.meta.url);
const rivetRequire = createRequire(require.resolve("rivetkit"));

interface RivetEngineCliModule {
	readonly getEnginePath: () => string;
}

// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: @rivetkit/engine-cli exports getEnginePath() returning the local rivet-engine binary path.
const { getEnginePath } = rivetRequire(
	"@rivetkit/engine-cli",
) as RivetEngineCliModule;

const BoundAddressSchema = Schema.Struct({
	port: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
const decodeBoundAddress = Schema.decodeUnknownOption(BoundAddressSchema);

function reserveLoopbackPort(): Promise<{
	readonly port: number;
	readonly server: Server;
}> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const parsed = decodeBoundAddress(server.address());
			if (parsed._tag === "None") {
				server.close();
				reject(new Error("failed to bind ephemeral loopback port"));
				return;
			}
			resolve({ port: parsed.value.port, server });
		});
	});
}

export interface LocalRivetTestEngine {
	readonly endpoint: string;
	readonly token: string;
	readonly httpHost: string;
	readonly httpPort: number;
	readonly stop: () => Promise<void>;
}

export async function startLocalRivetTestEngine(): Promise<LocalRivetTestEngine> {
	const dir = await mkdtemp(join(tmpdir(), "hobo-gh-rivet-test-engine-"));
	const reservations = await Promise.all([
		reserveLoopbackPort(),
		reserveLoopbackPort(),
		reserveLoopbackPort(),
		reserveLoopbackPort(),
	]);
	const [engineRes, peerRes, metricsRes, httpRes] = reservations;
	if (!engineRes || !peerRes || !metricsRes || !httpRes) {
		throw new Error("failed to reserve local Rivet engine ports");
	}
	await Promise.all(
		reservations.map(
			({ server }) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
				}),
		),
	);

	const logDirectory = join(dir, "engine-log");
	const objectsDirectory = join(dir, "engine-objects");
	await mkdir(logDirectory, { recursive: true });
	await mkdir(objectsDirectory, { recursive: true });

	const endpoint = `http://127.0.0.1:${engineRes.port}`;
	const loopbackAuth = "ephemeral-loopback-harness";
	const configFile = join(dir, "engine.json");
	await writeFile(
		configFile,
		JSON.stringify({
			auth: { admin_token: loopbackAuth },
			guard: { host: "127.0.0.1", port: engineRes.port },
			api_peer: { host: "127.0.0.1", port: peerRes.port },
			metrics: { host: "127.0.0.1", port: metricsRes.port },
			topology: {
				datacenter_label: 1,
				datacenters: {
					default: {
						datacenter_label: 1,
						is_leader: true,
						public_url: endpoint,
						peer_url: `http://127.0.0.1:${peerRes.port}`,
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
			object_storage: { primary: { file_system: { path: objectsDirectory } } },
			telemetry: { enabled: false },
			runtime: {
				worker_shutdown_duration: 1,
				guard_shutdown_duration: 1,
				force_shutdown_duration: 5,
			},
		}),
	);

	const engineBin = getEnginePath();
	const useTaskset =
		process.platform === "linux" && existsSync("/usr/bin/taskset");
	const child = useTaskset
		? spawn(
				"/usr/bin/taskset",
				["-c", "0", engineBin, "--config", configFile],
				{
					stdio: ["ignore", "pipe", "pipe"],
				},
			)
		: spawn(engineBin, ["--config", configFile], {
				stdio: ["ignore", "pipe", "pipe"],
			});
	const exited = once(child, "exit");

	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			await fetch(endpoint);
			break;
		} catch (error) {
			if (Date.now() >= deadline) {
				child.kill("SIGKILL");
				await exited;
				await rm(dir, { recursive: true, force: true });
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	return {
		endpoint,
		token: loopbackAuth,
		httpHost: "127.0.0.1",
		httpPort: httpRes.port,
		stop: async () => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
			}
			const killer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
				}
			}, 3_000);
			await exited;
			clearTimeout(killer);
			await rm(dir, { recursive: true, force: true });
		},
	};
}
