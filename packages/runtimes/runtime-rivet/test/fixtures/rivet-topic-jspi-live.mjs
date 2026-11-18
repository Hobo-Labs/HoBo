import { spawn } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import {
	createDurableMessagingLifecycle,
	createDurableMessagingLimitsGrant,
	createDurableMessagingPortMetadataGrant,
	createDurableMessagingWitHost,
	DURABLE_MESSAGING_JSPI_INTERFACE,
	instantiateDurableMessagingJspi,
} from "../../../../runtime/src/durable-messaging-host.ts";
import {
	createRivetDurableTopicBusActor,
	isRivetDurableTopicBusBinding,
} from "../../src/durable-topic-actor.ts";
import {
	createRivetDurableTopicClient,
	createRivetDurableTopicMetadataGrant,
	isRivetDurableTopicClientBoundTo,
} from "../../src/durable-topic-client.ts";

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
// Test-only signatures prove the fixture's exact request/key binding. The
// fixture does not attest production ingress, crash placement or process fencing.
const actorName = "hoboTopic";
const actorKey = ["tenant-a", "orders-instance"];
const semanticDigest = `sha256:${"a".repeat(64)}`;
const secret = Buffer.from("test-only-rivet-topic-hmac-key");
const signature = (claim) =>
	createHmac("sha256", secret)
		.update(
			JSON.stringify([
				claim.actorName,
				claim.actorKey,
				claim.tenant,
				claim.instance,
				claim.semanticDigest,
				claim.method,
				claim.requestBase64,
			]),
		)
		.digest("hex");
let logicalNow = 1_700_000_000_000;
let sourceFenceActive = true;
let ownerFenceActive = true;
const instanceSecret = Buffer.from("test-only-instance-grant-key");
const instanceSignature = (claim) =>
	createHmac("sha256", instanceSecret)
		.update(`instance:${signature(claim)}`)
		.digest("hex");
const actorBinding = createRivetDurableTopicBusActor({
	actorName,
	semanticDigest,
	now: () => logicalNow,
	resolveScope: ({ actorName: observedName, actorKey: observedKey }) => {
		if (
			observedName !== actorName ||
			JSON.stringify(observedKey) !== JSON.stringify(actorKey)
		)
			throw new Error("wrong actor key");
		return { tenant: "tenant-a", instance: "orders-instance" };
	},
	authorize: (claim) => {
		const actual = claim.headers.get("x-hobo-proof");
		const expected = signature(claim);
		return (
			actual !== null &&
			/^[a-f0-9]{64}$/u.test(actual) &&
			timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))
		);
	},
	authorizeInstanceScope: (claim) => {
		const actual = claim.headers.get("x-hobo-instance-proof");
		const expected = instanceSignature(claim);
		return (
			actual !== null &&
			/^[a-f0-9]{64}$/u.test(actual) &&
			timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))
		);
	},
	// Test-only: this fixture does not prove the gateway's pre-allocation limits.
	verifyIngress: ({
		maxRequestBytes,
		maxChunkBytes,
		maxHeaderBytes,
		maxChunks,
	}) =>
		sourceFenceActive &&
		ownerFenceActive &&
		maxRequestBytes === 131_072 &&
		maxChunkBytes === 65_536 &&
		maxHeaderBytes === 16_384 &&
		maxChunks === 4_096,
});
const makeRegistry = () =>
	setup({
		use: { hoboTopic: actorBinding.actor },
		noWelcome: true,
		endpoint: publicUrl,
		token,
		startEngine: false,
		httpHost: "127.0.0.1",
		httpPort,
		shutdown: { gracePeriodMs: 2000, disableSignalHandlers: true },
	});
let registry;
let handle;
const openRegistry = async () => {
	registry = makeRegistry();
	const { client } = await setupTest(
		{
			onTestFinished(callback) {
				callbacks.push(callback);
			},
		},
		registry,
	);
	handle = client.hoboTopic.getOrCreate(actorKey);
};
const stopRegistry = async () => {
	for (const callback of callbacks.splice(0)) await callback();
	if (registry !== undefined) await registry.shutdown();
	registry = undefined;
};
// The enclosing test generated and transpiled this JCO component into a private
// temporary directory. These checks bind the actual fixture artifacts; they are
// not evidence of an independently enforced production source/ownership fence.
const [outputDirectory, expectedDigest, importsJson] = process.argv.slice(2);
if (!outputDirectory || !expectedDigest || !importsJson)
	throw new Error("missing component artifacts");
const imports = JSON.parse(importsJson);
const componentBytes = await readFile(
	join(outputDirectory, "..", "probe.wasm"),
);
const actualDigest = `sha256:${createHash("sha256").update(componentBytes).digest("hex")}`;
if (
	actualDigest !== expectedDigest ||
	JSON.stringify(imports) !== JSON.stringify([DURABLE_MESSAGING_JSPI_INTERFACE])
)
	throw new Error("component metadata mismatch");
const generatedPath = join(outputDirectory, "probe.js");
const generatedSource = await readFile(generatedPath, "utf8");
const coreSnapshots = new Map();
for (const file of await readdir(outputDirectory))
	if (file.endsWith(".wasm"))
		coreSnapshots.set(file, await readFile(join(outputDirectory, file)));
if (coreSnapshots.size === 0) throw new Error("missing compiled core modules");
const digestArtifacts = () => {
	const hash = createHash("sha256").update(generatedSource);
	for (const [file, contents] of [...coreSnapshots].sort(([a], [b]) =>
		a.localeCompare(b),
	))
		hash.update(file).update(contents);
	return hash.digest("hex");
};
const frozenArtifactDigest = digestArtifacts();
// Import the exact snapshotted generated bytes, rather than rereading a path.
const { instantiate } = await import(
	`data:text/javascript;base64,${Buffer.from(generatedSource).toString("base64")}`
);
const factory = (hostImports) =>
	instantiate((name) => {
		const bytes = coreSnapshots.get(name);
		if (bytes === undefined) throw new Error(`unexpected core module ${name}`);
		return WebAssembly.compile(bytes);
	}, hostImports);
const componentGrantActive = true;
const hostGrantActive = true;
let dispatches = 0;
let disclosures = 0;
let forbiddenDispatches = 0;
try {
	await openRegistry();
	if (!isRivetDurableTopicBusBinding(actorBinding))
		throw new Error("actor brand mismatch");
	const drops = new Set(["/publish", "/nack"]);
	const seenPaths = [];
	const seenBodies = [];
	const fetch = async (path, init) => {
		seenPaths.push(path);
		seenBodies.push(init.body);
		const response = await handle.fetch(path, init);
		if (drops.delete(path)) {
			await response.arrayBuffer();
			throw new Error("test dropped reply after commit");
		}
		return response;
	};
	const providerMetadataGrant = createRivetDurableTopicMetadataGrant();
	const clientOptions = {
		binding: {
			actorName,
			actorKey,
			tenant: "tenant-a",
			instance: "orders-instance",
			semanticDigest,
			limits: actorBinding.limits,
			actorCapabilities: actorBinding.capabilities,
		},
		metadataGrant: providerMetadataGrant,
		verifyTransport: (claim) =>
			claim.fetch === fetch &&
			claim.maxResponseBytes === 262_144 &&
			claim.maxResponseChunks === 4096,
		authorize: (claim) => ({
			"x-hobo-proof": signature(claim),
			"x-hobo-instance-proof": instanceSignature(claim),
		}),
		revalidate: () => true,
		fetch,
	};
	const messaging = createRivetDurableTopicClient(clientOptions);
	const bridgeMetadataGrant = createDurableMessagingPortMetadataGrant({
		port: messaging,
		limits: actorBinding.limits,
		verify: (claim) =>
			claim.port === messaging &&
			isRivetDurableTopicClientBoundTo(messaging, clientOptions) &&
			Object.keys(actorBinding.limits).every(
				(key) => claim.limits[key] === actorBinding.limits[key],
			),
	});
	const allowedTopics = new Set(["orders", "dlq", "archive"]);
	const host = createDurableMessagingWitHost(messaging, {
		limitsGrant: createDurableMessagingLimitsGrant(),
		portMetadataGrant: bridgeMetadataGrant,
		lifecycle: createDurableMessagingLifecycle(),
		authorize: (claim) => {
			if (claim.phase === "dispatch") dispatches++;
			else disclosures++;
			if (claim.topic === "forbidden") {
				forbiddenDispatches++;
				return false;
			}
			return (
				hostGrantActive &&
				(claim.topic === undefined || allowedTopics.has(claim.topic)) &&
				(claim.deadLetterTopic === undefined ||
					allowedTopics.has(claim.deadLetterTopic)) &&
				(claim.consumerGroup === undefined ||
					["workers", "reader"].includes(claim.consumerGroup))
			);
		},
	});
	const component = Object.freeze({
		digest: expectedDigest,
		imports: Object.freeze(imports),
		instantiate: factory,
	});
	const started = await instantiateDurableMessagingJspi(host, {
		component,
		verify: (candidate, boundHost) =>
			componentGrantActive &&
			boundHost === host &&
			candidate.digest === actualDigest &&
			candidate.instantiate === factory &&
			candidate.imports.length === 1 &&
			candidate.imports[0] === DURABLE_MESSAGING_JSPI_INTERFACE &&
			frozenArtifactDigest === digestArtifacts(),
	});
	if (started.status !== "started") throw new Error("component did not start");
	const first = await started.value.run();
	if (first !== "guest-run-ok")
		throw new Error(`unexpected component run: ${first}`);
	if (
		forbiddenDispatches !== 1 ||
		seenBodies.some((body) => String(body).includes('"forbidden"'))
	)
		throw new Error("component scope denial was bypassed");
	if (drops.size !== 0)
		throw new Error("lost response paths were not exercised");
	logicalNow += 101;
	const second = await started.value.expireCheck();
	if (second !== "guest-expiry-ok")
		throw new Error(`unexpected component expiry run: ${second}`);
	const scopedProbe = {
		operation: {
			id: "v1.1700000060000.0000000000000019",
			expiresAtMs: 1_700_000_060_000,
		},
		topic: "orders",
	};
	sourceFenceActive = false;
	if ((await messaging.ensureTopic(scopedProbe)).status !== "unknown")
		throw new Error("revoked fixture source fence accepted");
	sourceFenceActive = true;
	if ((await messaging.ensureTopic(scopedProbe)).status !== "committed")
		throw new Error("source fence recovery failed");
	const ownerProbe = {
		...scopedProbe,
		operation: {
			...scopedProbe.operation,
			id: "v1.1700000060000.0000000000000020",
		},
	};
	ownerFenceActive = false;
	if ((await messaging.ensureTopic(ownerProbe)).status !== "unknown")
		throw new Error("revoked fixture owner fence accepted");
	ownerFenceActive = true;
	if ((await messaging.ensureTopic(ownerProbe)).status !== "committed")
		throw new Error("owner fence recovery failed");
	providerMetadataGrant.revoke();
	let revokedLimits = false;
	try {
		host.limits();
	} catch {
		revokedLimits = true;
	}
	if (!revokedLimits)
		throw new Error("revoked provider metadata remained visible");
	const revoked = await host.ensureTopic({
		operation: {
			id: "v1.1700000060000.0000000000000021",
			expiresAtMs: 1_700_000_060_000n,
		},
		topic: "orders",
	});
	if (revoked.tag !== "unknown")
		throw new Error("revoked provider metadata allowed a host mutation");
	if (dispatches <= 0 || disclosures <= 0)
		throw new Error("component host checks not observed");
	if (
		!seenPaths.includes("/publish") ||
		!seenPaths.includes("/nack") ||
		!seenPaths.includes("/consume")
	)
		throw new Error("Rivet client not exercised");
	process.stdout.write(
		"rivet-jspi-bus-live-ok component=observed actor=observed host-grants=fixture source-fence=unverified owner-fence=unverified ingress=unverified process-restart=unverified fault-placement=unverified",
	);
} catch (error) {
	process.stderr.write(`Rivet engine log:\n${engineLog}\n`);
	throw error;
} finally {
	await stopRegistry();
	if (engine.exitCode === null && engine.signalCode === null)
		engine.kill("SIGTERM");
	const timer = setTimeout(() => engine.kill("SIGKILL"), 5000);
	await engineDone;
	clearTimeout(timer);
}
