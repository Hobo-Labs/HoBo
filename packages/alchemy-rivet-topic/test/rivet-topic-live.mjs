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
import { alchemyTarget, createAlchemyIacProvider } from "@hobo/iac-alchemy";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Bundle from "alchemy/Bundle/Bundle";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createClient } from "rivetkit/client";
import { rivetDurableTopicResource } from "../src/index.ts";
import { events, registry } from "./fixtures/rivet-topic-definition.mjs";
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
	// The host plans the same standalone main that it will bundle and execute.
	// This test verifier checks only the listed files. A production host must
	// independently fence the complete dependency and artifact closure.
	const main = fileURLToPath(
		new URL("./fixtures/rivet-topic-main.mjs", import.meta.url),
	);
	const definition = fileURLToPath(
		new URL("./fixtures/rivet-topic-definition.mjs", import.meta.url),
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
	// This test host records the entrypoint selected by Alchemy. It does not
	// exercise Alchemy's real PoolHost layer or a provider-deployed pool.
	const poolHost = {
		deployExternal: ({ main: selected }) =>
			Effect.sync(() => {
				poolMain = selected;
			}),
		deployCrate: () => Effect.void,
	};
	const source = {
		main,
		resourceName: "events",
		bindleName: "topic-app",
		sourceDigest,
		sourceFence: {
			sourceDigest,
			environmentDigest: `sha256:${"d".repeat(64)}`,
			proofRef: "host:source",
			verify: () => hashSources() === sourceDigest,
		},
		poolDigest: `sha256:${"b".repeat(64)}`,
		isolationDigest: `sha256:${"c".repeat(64)}`,
		poolHost,
		registry,
		binding: events,
		verifySource: (claim) =>
			claim.main === main &&
			claim.registry === registry &&
			claim.binding === events &&
			hashSources() === sourceDigest,
	};
	const providers = Layer.effect(
		Providers,
		Provider.collection([DurableObjectResource]),
	).pipe(
		Layer.provide(
			Provider.succeed(DurableObjectResource, {
				reconcile: () =>
					Effect.succeed({
						name: "events",
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
		rivetDurableTopicResource(source).pipe(Effect.map(() => ({}))),
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
					resourceId: "events",
					resourceType: "Rivet.DurableObject",
					bindleName: "topic-app",
					applicationName: "events",
					sourceKind: "rivet-async-topic",
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
					resourceId: "events",
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

	// Mirror beta.87's external PoolHost bundle options. The resulting program
	// runs in a separate process against this isolated Rivet engine.
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
			if (runnerLog.includes("rivet-topic-pool-ready")) announceReady();
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
	const actor = client.events.getOrCreate(["tenant-a"]);
	const canonical = (value) => {
		// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: this fixture canonicalizes only its own JSON literals.
		if (value === null || typeof value !== "object")
			return JSON.stringify(value);
		if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	};
	const call = (path, data, authorization = "test") =>
		actor.fetch(`/${path}`, {
			method: "POST",
			headers: { authorization },
			body: canonical(data),
		});
	const expiresAtMs = Date.now() + 60_000;
	const op = (n) => ({
		id: `v1.${expiresAtMs}.${String(n).padStart(16, "0")}`,
		expiresAtMs,
	});
	const created = await call("ensure-topic", {
		operation: op(1),
		topic: "orders",
	});
	const first = await created.json();
	if (
		created.status !== 200 ||
		first.status !== "committed" ||
		first.value.topic !== "orders"
	)
		throw new Error(`topic creation failed: ${JSON.stringify(first)}`);
	const publication = {
		operation: op(2),
		topic: "orders",
		message: { id: "m", subject: "created", payload: "AAH/", attributes: [] },
	};
	const published = await (await call("publish", publication)).json();
	const retried = await (await call("publish", publication)).json();
	if (
		published.status !== "committed" ||
		published.value.sequence !== 1 ||
		JSON.stringify(retried) !== JSON.stringify(published)
	)
		throw new Error("topic publication or durable retry failed");
	const page = await (
		await call("read-log", { topic: "orders", afterSequence: 0, limit: 4 })
	).json();
	if (
		page.status !== "ok" ||
		page.messages.length !== 1 ||
		page.messages[0].payload !== "AAH/"
	)
		throw new Error("topic retained log mismatch");
	const subscription = {
		operation: op(4),
		subscription: {
			topic: "orders",
			consumerGroup: "workers",
			deadLetterTopic: "dlq",
			maxDeliveryAttempts: 2,
			startAt: "earliest",
		},
	};
	const unsupported = await (
		await call("ensure-subscription", subscription)
	).json();
	const unsupportedRetry = await (
		await call("ensure-subscription", subscription)
	).json();
	if (
		unsupported.status !== "rejected" ||
		unsupported.code !== "unsupported" ||
		JSON.stringify(unsupportedRetry) !== JSON.stringify(unsupported)
	)
		throw new Error("unsupported group operation was not durably rejected");
	const denied = await call(
		"ensure-topic",
		{ operation: op(3), topic: "forbidden" },
		"wrong",
	);
	if (
		denied.status !== 503 ||
		(await denied.json()).error !== "authority-unavailable"
	)
		throw new Error("topic authorization failed");
	const forbidden = await (
		await call("read-log", { topic: "forbidden", afterSequence: 0, limit: 1 })
	).json();
	if (forbidden.status !== "rejected" || forbidden.code !== "not-found")
		throw new Error("unauthorized topic mutation took effect");
	process.stdout.write("rivet-topic-live-ok");
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
