import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DurableObjectResource, Providers } from "@alchemy.run/rivet";
import {
	alchemyTarget,
	createAlchemyIacProvider,
	mapBindleToAlchemy,
} from "@hobo/iac-alchemy";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Bundle from "alchemy/Bundle/Bundle";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createClient } from "rivetkit/client";
import { createRivetBindleTopicBusMappers } from "../src/rivet-http-topic-bus.ts";
import { testStateOwnership } from "./route-fixture.ts";

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
const ports = await Promise.all(Array.from({ length: 3 }, reservePort));
const [enginePort, peerPort, metricsPort] = ports.map(([port]) => port);
for (const [, server] of ports)
	await new Promise((resolve) => server.close(resolve));

const token = "local-test-token";
process.env.HOBO_TEST_TOPIC_EXPIRY = String(Date.now() + 120_000);
const { application, bus, deployed, registry } = await import(
	"./fixtures/rivet-bindle-topic-definition.mjs"
);
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
let runner;
let runnerDone;
let runnerLog = "";
let client;
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
	const main = fileURLToPath(
		new URL("./fixtures/rivet-bindle-topic-main.mjs", import.meta.url),
	);
	const definition = fileURLToPath(
		new URL("./fixtures/rivet-bindle-topic-definition.mjs", import.meta.url),
	);
	const runtime = fileURLToPath(
		new URL(
			"../../runtimes/runtime-rivet/dist/durable-topic-actor.js",
			import.meta.url,
		),
	);
	const journal = fileURLToPath(
		new URL(
			"../../runtimes/runtime-rivet/dist/durable-receipt-journal.js",
			import.meta.url,
		),
	);
	const hashSources = () => {
		const hash = createHash("sha256");
		for (const path of [main, definition, runtime, journal]) {
			const bytes = readFileSync(path);
			hash.update(`${bytes.length}:`);
			hash.update(bytes);
		}
		return `sha256:${hash.digest("hex")}`;
	};
	const sourceDigest = hashSources();
	let poolMain;
	const poolHost = {
		deployExternal: ({ main: selected }) =>
			Effect.sync(() => {
				poolMain = selected;
			}),
		deployCrate: () => Effect.void,
	};
	const mappers = createRivetBindleTopicBusMappers({
		application,
		source: {
			main,
			resourceName: "web",
			kind: "web",
			actorName: "web",
			sourceDigest,
			sourceFence: {
				sourceDigest,
				environmentDigest: bus.semanticDigest,
				proofRef: "host:source",
				verify: () => hashSources() === sourceDigest,
			},
			registry,
			binding: application.http,
			verifySource: (claim) =>
				claim.main === main &&
				claim.registry === registry &&
				claim.binding === application.http &&
				hashSources() === sourceDigest,
		},
		poolDigest: `sha256:${"b".repeat(64)}`,
		isolationDigest: `sha256:${"c".repeat(64)}`,
		poolHost,
		verifyPool: () => true,
	});
	const providers = Layer.effect(
		Providers,
		Provider.collection([DurableObjectResource]),
	).pipe(
		Layer.provide(
			Provider.succeed(DurableObjectResource, {
				reconcile: () =>
					Effect.succeed({
						name: "web",
						pool: "pool",
						endpoint: publicUrl,
						namespace: "test",
						token: undefined,
					}),
				delete: () => Effect.void,
			}),
		),
	);
	const stack = Stack(
		"Topic",
		{ providers, state: inMemoryState() },
		mapBindleToAlchemy(deployed, mappers, {
			assessRequirements: () => ({ status: "supported" }),
		}).pipe(Effect.map(() => ({}))),
	);
	process.env.ALCHEMY_HOME = join(process.cwd(), "auth");
	const provider = createAlchemyIacProvider({
		stateOwnership: testStateOwnership,
		stack,
		runtimeLayer: Alchemist.layer(),
		runtimeDirectory: process.cwd(),
		composite: {
			proofRef: "host:source",
			environmentDigest: `sha256:${"d".repeat(64)}`,
			sourceRequirements: [
				{
					resourceId: "web",
					resourceType: "Rivet.DurableObject",
					bindleName: "shop",
					applicationName: "web",
					sourceKind: "rivet-http",
					sourcePath: main,
				},
			],
			verifyEnvironment: () => true,
			verifyPlan: ({ sourceClaims }) =>
				sourceClaims.length === 1 && sourceClaims[0]?.sourcePath === main,
		},
		target: alchemyTarget({
			targetId: "yard",
			tenantId: "tenant",
			stackName: "Topic",
			stage: "test",
			programResourceId: "topic",
			sourceDigest,
			inventoryEvidenceRef: "inventory:1",
			resources: [
				{
					resourceId: "web",
					resourceType: "Rivet.DurableObject",
					providerId: "rivet",
					providerAccountRef: "account",
					productId: "actor",
				},
			],
		}),
		financial: {
			assess: (inventory) => ({ inventory }),
			admit: async () => {
				throw new Error("unexpected admission");
			},
			revalidate: () => true,
			uncertain: () => {},
		},
	});
	const plan = await provider.preview({
		programId: "topic",
		deploymentId: "d",
		resourceId: "topic",
		provider: "rivet",
		driver: "external",
		action: "apply",
		stackName: "Topic",
	});
	if (plan.changes !== 1 || poolMain !== main)
		throw new Error("Alchemy selected the wrong pool main");

	const bundleDirectory = join(process.cwd(), "pool");
	await mkdir(bundleDirectory);
	await symlink(
		fileURLToPath(new URL("../node_modules", import.meta.url)),
		join(bundleDirectory, "node_modules"),
		process.platform === "win32" ? "junction" : "dir",
	);
	const bundle = (input, entryFileNames) =>
		Effect.runPromise(
			Bundle.build(
				{
					input,
					platform: "node",
					external: ["rivetkit", /^rivetkit\//, /^@rivetkit\/(?!effect(\/|$))/],
					resolve: { conditionNames: [...Bundle.NODE_CONDITION_NAMES] },
					plugins: [],
				},
				{
					dir: bundleDirectory,
					format: "esm",
					entryFileNames,
					codeSplitting: false,
				},
			),
		);
	const runnerEnv = {
		PATH: process.env.PATH,
		NODE_ENV: "test",
		RIVET_ENDPOINT: publicUrl,
		RIVET_TOKEN: token,
		RIVET_POOL: "default",
		HOBO_TEST_TOPIC_EXPIRY: process.env.HOBO_TEST_TOPIC_EXPIRY,
	};
	await bundle(poolMain, "node.mjs");
	runner = spawn(process.execPath, [join(bundleDirectory, "node.mjs")], {
		env: runnerEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});
	runnerDone = once(runner, "exit");
	let announceReady;
	const readySignal = new Promise((resolve) => {
		announceReady = resolve;
	});
	for (const output of [runner.stdout, runner.stderr])
		output.on("data", (chunk) => {
			runnerLog = (runnerLog + chunk).slice(-12000);
			if (runnerLog.includes("rivet-bindle-topic-pool-ready")) announceReady();
		});
	let readyTimer;
	try {
		await Promise.race([
			readySignal,
			runnerDone.then(() => {
				throw new Error("Rivet topic pool exited before readiness");
			}),
			new Promise((_, reject) => {
				readyTimer = setTimeout(
					() => reject(new Error("Rivet topic pool startup timed out")),
					30_000,
				);
			}),
		]);
	} finally {
		clearTimeout(readyTimer);
	}
	client = createClient({
		endpoint: publicUrl,
		token,
		disableMetadataLookup: true,
	});
	const actor = client.web.getOrCreate(["tenant-a"]);
	const call = () => actor.fetch("/", { method: "GET" });
	const firstResponse = await call();
	const first = await firstResponse.json();
	const secondResponse = await call();
	const second = await secondResponse.json();
	const denied = await client.web
		.getOrCreate(["tenant-b"])
		.fetch("/", { method: "GET" });
	if (
		firstResponse.status !== 200 ||
		secondResponse.status !== 200 ||
		denied.status !== 403 ||
		first.tag !== "committed" ||
		first.messageId !== "order-1" ||
		JSON.stringify(second) !== JSON.stringify(first)
	)
		throw new Error(
			`scoped topic application failed: ${JSON.stringify({ first, second, deniedStatus: denied.status })}`,
		);
	process.stdout.write("rivet-bindle-topic-live-ok");
} catch (error) {
	process.stderr.write(
		`Rivet engine log:\n${engineLog}\nRivet pool log:\n${runnerLog}\n`,
	);
	throw error;
} finally {
	if (client) await client.dispose();
	if (runner && runner.exitCode === null && runner.signalCode === null)
		runner.kill("SIGTERM");
	if (runnerDone) {
		const timer = setTimeout(() => runner.kill("SIGKILL"), 5000);
		await runnerDone;
		clearTimeout(timer);
	}
	if (engine.exitCode === null && engine.signalCode === null)
		engine.kill("SIGTERM");
	const timer = setTimeout(() => engine.kill("SIGKILL"), 5000);
	await engineDone;
	clearTimeout(timer);
}
