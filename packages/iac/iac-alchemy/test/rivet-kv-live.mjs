import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { setup } from "rivetkit";
import { createClient } from "rivetkit/client";
import { setupTest } from "rivetkit/test";
import {
	createRivetAsyncKvActor,
	createRivetAsyncKvClient,
} from "../src/rivet-kv.ts";

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
const storage = createRivetAsyncKvActor({
	actorName: "store",
	semanticDigest: `sha256:${"a".repeat(64)}`,

	verifyIngress: ({ actorName }) => actorName === "store",
	authorize: ({ actorKey, headers }) =>
		["tenant-a", "tenant-b"].includes(actorKey[0]) &&
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
	const { client } = await setupTest(
		{
			onTestFinished(callback) {
				callbacks.push(callback);
			},
		},
		registry,
	);

	const withinSetupDeadline = async (promise, deadline) => {
		let timer;
		try {
			return await Promise.race([
				promise,
				new Promise((_, reject) => {
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
	const resolveReady = async (actorKey) => {
		const deadline = Date.now() + 30_000;
		let actorId;
		while (actorId === undefined) {
			try {
				actorId = await withinSetupDeadline(
					client.store.getOrCreate(actorKey).resolve(),
					deadline,
				);
			} catch (error) {
				if (
					error.group !== "depot" ||
					error.code !== "overloaded" ||
					Date.now() >= deadline
				)
					throw error;
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
	const bound = async (tenant, drop) => {
		const actorKey = [tenant, "application"];

		const { actorId, handle } = await resolveReady(actorKey);
		return createRivetAsyncKvClient({
			semanticDigest: `sha256:${"a".repeat(64)}`,
			actorName: "store",
			actorId,
			actorKey,
			verifyTransport: (claim) =>
				claim.actorId === actorId && claim.singleDispatch === true,
			fetch: async (path, init) => {
				const headers = new Headers(init.headers);
				headers.set("authorization", "test");
				const response = await handle.fetch(path, { ...init, headers });
				if (drop && path === "/set") {
					await response.arrayBuffer();
					throw new Error("lost acknowledgement");
				}
				return response;
			},
		});
	};
	const first = await bound("tenant-a", false);
	const second = await bound("tenant-b", false);
	const denied = await bound("tenant-c", false);
	const expect = (condition, message) => {
		if (!condition) throw new Error(message);
	};
	expect(
		(await first.set("key", Uint8Array.of(0, 255, 128))).status === "ok",
		"set failed",
	);
	const firstValue = await first.get("key");
	expect(
		firstValue.status === "ok" &&
			Buffer.from(firstValue.value).equals(Buffer.from([0, 255, 128])),
		"byte read failed",
	);
	const missing = await second.get("key");
	expect(
		missing.status === "ok" && missing.value === undefined,
		"actor isolation failed",
	);
	expect(
		(await second.set("key", Uint8Array.of(7))).status === "ok",
		"second actor set failed",
	);
	expect((await first.exists("key")).value === true, "exists failed");
	expect(
		(await denied.set("key", Uint8Array.of(1))).status === "denied",
		"unauthorized actor wrote",
	);
	const dropped = await bound("tenant-a", true);
	expect(
		(await dropped.set("uncertain", Uint8Array.of(9))).status === "unknown",
		"lost write reply was not unknown",
	);
	const observed = await first.get("uncertain");
	expect(
		observed.status === "ok" &&
			Buffer.from(observed.value).equals(Buffer.from([9])),
		"lost write effect was not durable",
	);

	const { actorId } = await resolveReady(["tenant-a", "application"]);
	let gatewayAttempts = 0;
	const monitored = createClient({
		endpoint: publicUrl,
		token,
		fetch: async (url, init) => {
			gatewayAttempts++;
			expect(init.redirect === "error", "redirect policy was lost");
			const reply = await fetch(url, init);
			await reply.arrayBuffer();
			expect(
				(await first.set("interleaved", Uint8Array.of(2))).status === "ok",
				"competing write failed",
			);
			return Response.json(
				{
					group: "actor",
					code: "dropped_reply",
					message: "simulated lifecycle error",
				},
				{ status: 503 },
			);
		},
	});
	try {
		const handle = monitored.store.getForId(actorId);
		const single = createRivetAsyncKvClient({
			actorName: "store",
			actorId,
			actorKey: ["tenant-a", "application"],
			semanticDigest: `sha256:${"a".repeat(64)}`,
			verifyTransport: (claim) =>
				claim.actorId === actorId && claim.singleDispatch,
			fetch: (path, init) => {
				const headers = new Headers(init.headers);
				headers.set("authorization", "test");
				return handle.fetch(path, { ...init, headers });
			},
		});
		expect(
			(await single.set("interleaved", Uint8Array.of(1))).status === "unknown",
			"dropped reply was not unknown",
		);
		expect(
			gatewayAttempts === 1,
			"fixed-ID request retried after the lost reply",
		);
		const interleaved = await first.get("interleaved");
		expect(
			interleaved.status === "ok" &&
				Buffer.from(interleaved.value).equals(Buffer.from([2])),
			"retry overwrote the competing writer",
		);
	} finally {
		await monitored.dispose();
	}
	expect((await first.delete("key")).status === "ok", "delete failed");
	expect((await first.exists("key")).value === false, "delete was not visible");
	const other = await second.get("key");
	expect(
		other.status === "ok" && Buffer.from(other.value).equals(Buffer.from([7])),
		"actor instances were not isolated",
	);
	process.stdout.write(
		"rivet-kv-live-ok restart=unverified ingress=unverified owner-fence=unverified receipt-auth=unverified host-journal=unverified",
	);
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
