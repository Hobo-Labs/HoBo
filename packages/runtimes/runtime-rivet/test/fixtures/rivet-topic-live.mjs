import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { createRivetDurableTopicActor } from "../../src/durable-topic-actor.ts";
import {
	createRivetDurableTopicClient,
	createRivetDurableTopicMetadataGrant,
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
const actorBinding = createRivetDurableTopicActor({
	actorName,
	semanticDigest,
	now: Date.now,
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
	// Test-only: this fixture does not prove the gateway's pre-allocation limits.
	verifyIngress: ({
		maxRequestBytes,
		maxChunkBytes,
		maxHeaderBytes,
		maxChunks,
	}) =>
		maxRequestBytes === 131_072 &&
		maxChunkBytes === 65_536 &&
		maxHeaderBytes === 16_384 &&
		maxChunks === 4_096,
});
const registry = setup({
	use: { hoboTopic: actorBinding.actor },
	noWelcome: true,
	endpoint: publicUrl,
	token,
	startEngine: false,
	httpHost: "127.0.0.1",
	httpPort,
	shutdown: { gracePeriodMs: 2000, disableSignalHandlers: true },
});
try {
	const { client } = await setupTest(
		{
			onTestFinished(callback) {
				callbacks.push(callback);
			},
		},
		registry,
	);
	const handle = client.hoboTopic.getOrCreate(actorKey);
	let dropPath = "";
	const fetch = async (path, init) => {
		const response = await handle.fetch(path, init);
		if (path === dropPath) {
			dropPath = "";
			await response.arrayBuffer();
			throw new Error("test dropped reply after actor returned");
		}
		return response;
	};
	const base = {
		actorName,
		actorKey,
		tenant: "tenant-a",
		instance: "orders-instance",
		semanticDigest,
		limits: actorBinding.limits,
		actorCapabilities: actorBinding.capabilities,
	};
	const createClient = (bound) =>
		createRivetDurableTopicClient({
			binding: bound,
			metadataGrant: createRivetDurableTopicMetadataGrant(),
			// Test-only: real deployments need independent gateway and fencing evidence.
			verifyTransport: (claim) =>
				claim.fetch === fetch &&
				claim.maxResponseBytes === 262_144 &&
				claim.maxResponseChunks === 4096,
			authorize: (claim) => ({ "x-hobo-proof": signature(claim) }),
			revalidate: () => true,
			fetch,
		});
	const messaging = createClient(base);
	const expiresAtMs = Date.now() + 60_000;
	let counter = 0;
	const operation = () => ({
		id: `v1.${expiresAtMs}.${String(++counter).padStart(16, "0")}`,
		expiresAtMs,
	});
	const invalidTopic = {
		operation: operation(),
		topic: "poisoned-topic",
		extra: true,
	};
	const deniedTopic = await messaging.ensureTopic(invalidTopic);
	const deniedTopicReplay = await messaging.ensureTopic(invalidTopic);
	if (
		deniedTopic.status !== "rejected" ||
		deniedTopic.code !== "invalid-argument" ||
		deniedTopicReplay.status !== "rejected" ||
		deniedTopicReplay.code !== "invalid-argument"
	)
		throw new Error("malformed topic was not durably rejected");
	const absentTopic = await messaging.readRetainedLog({
		topic: "poisoned-topic",
		afterSequence: 0,
		limit: 1,
	});
	if (absentTopic.status !== "rejected" || absentTopic.code !== "not-found")
		throw new Error("malformed topic created state");
	const topicRequest = { operation: operation(), topic: "orders" };
	dropPath = "/ensure-topic";
	if ((await messaging.ensureTopic(topicRequest)).status !== "unknown")
		throw new Error("lost topic acknowledgement was not unknown");
	const topicConflict = await messaging.ensureTopic({
		...topicRequest,
		extra: true,
	});
	if (
		topicConflict.status !== "rejected" ||
		topicConflict.code !== "operation-conflict"
	)
		throw new Error("malformed topic replay did not conflict");
	const ensured = await messaging.ensureTopic(topicRequest);
	if (ensured.status !== "committed")
		throw new Error("topic receipt did not replay");
	const publish = {
		operation: operation(),
		topic: "orders",
		message: {
			id: "message-1",
			subject: "created",
			payload: new Uint8Array([0, 1, 254, 255]),
			attributes: [{ key: "source", value: "checkout" }],
		},
	};
	dropPath = "/publish";
	if ((await messaging.publish(publish)).status !== "unknown")
		throw new Error("lost reply was not unknown");
	const replay = await messaging.publish(publish);
	if (replay.status !== "committed" || replay.value.sequence !== 1)
		throw new Error("publish receipt did not replay");
	const conflict = await messaging.publish({
		...publish,
		message: { ...publish.message, id: "different" },
	});
	if (conflict.status !== "rejected" || conflict.code !== "operation-conflict")
		throw new Error("fingerprint conflict not retained");
	const invalid = {
		operation: operation(),
		topic: "orders",
		message: {
			id: "malformed",
			subject: "created",
			payload: "AA==",
			attributes: [],
			extra: true,
		},
	};
	const refused = await messaging.publish(invalid);
	const refusedReplay = await messaging.publish(invalid);
	if (
		refused.status !== "rejected" ||
		refused.code !== "invalid-argument" ||
		refusedReplay.status !== "rejected" ||
		refusedReplay.code !== "invalid-argument"
	)
		throw new Error("string payload did not receive a durable invalid receipt");
	const corrected = await messaging.publish({
		...invalid,
		message: { ...invalid.message, payload: new Uint8Array([0]) },
	});
	if (
		corrected.status !== "rejected" ||
		corrected.code !== "operation-conflict"
	)
		throw new Error("distinct invalid request reused a receipt identity");
	const malformedRetry = await messaging.publish({
		...publish,
		message: { ...publish.message, payload: "AA==" },
	});
	if (
		malformedRetry.status !== "rejected" ||
		malformedRetry.code !== "operation-conflict"
	)
		throw new Error("malformed replay overwrote a lost committed receipt");
	const preserved = await messaging.publish(publish);
	if (preserved.status !== "committed" || preserved.value.sequence !== 1)
		throw new Error("malformed replay destroyed the original receipt");
	const page = await messaging.readRetainedLog({
		topic: "orders",
		afterSequence: 0,
		limit: 4,
	});
	if (
		page.status !== "ok" ||
		page.messages.length !== 1 ||
		Buffer.compare(page.messages[0].payload, publish.message.payload) !== 0
	)
		throw new Error("retained log mismatch");
	const subscription = {
		operation: operation(),
		subscription: {
			topic: "orders",
			consumerGroup: "workers",
			deadLetterTopic: "orders-dlq",
			maxDeliveryAttempts: 3,
			startAt: "earliest",
		},
	};
	const unsupported = await messaging.ensureSubscription(subscription);
	const unsupportedReplay = await messaging.ensureSubscription(subscription);
	if (
		messaging.actorCapabilities.consumerGroups ||
		unsupported.status !== "rejected" ||
		unsupported.code !== "unsupported" ||
		unsupportedReplay.status !== "rejected" ||
		unsupportedReplay.code !== "unsupported"
	)
		throw new Error(
			"partial capability or durable unsupported receipt mismatch",
		);
	const spoofed = createClient({
		...base,
		actorKey: ["tenant-b", "orders-instance"],
	});
	if (
		(await spoofed.ensureTopic({ operation: operation(), topic: "forbidden" }))
			.status !== "unknown"
	)
		throw new Error("wrong-key capability accepted");
	if (
		(
			await messaging.readRetainedLog({
				topic: "forbidden",
				afterSequence: 0,
				limit: 1,
			})
		).code !== "not-found"
	)
		throw new Error("wrong-key mutation had an effect");
	const invalidCompact = {
		operation: operation(),
		topic: "orders",
		throughSequence: 1,
		extra: true,
	};
	const deniedCompact = await messaging.compact(invalidCompact);
	const deniedCompactReplay = await messaging.compact(invalidCompact);
	if (
		deniedCompact.status !== "rejected" ||
		deniedCompact.code !== "invalid-argument" ||
		deniedCompactReplay.status !== "rejected" ||
		deniedCompactReplay.code !== "invalid-argument"
	)
		throw new Error("malformed compact was not durably rejected");
	const beforeCompact = await messaging.readRetainedLog({
		topic: "orders",
		afterSequence: 0,
		limit: 4,
	});
	if (beforeCompact.status !== "ok" || beforeCompact.messages.length !== 1)
		throw new Error("malformed compact changed state");
	const compactRequest = {
		operation: operation(),
		topic: "orders",
		throughSequence: 1,
	};
	dropPath = "/compact";
	if ((await messaging.compact(compactRequest)).status !== "unknown")
		throw new Error("lost compact acknowledgement was not unknown");
	const compactConflict = await messaging.compact({
		...compactRequest,
		extra: true,
	});
	if (
		compactConflict.status !== "rejected" ||
		compactConflict.code !== "operation-conflict"
	)
		throw new Error("malformed compact replay did not conflict");
	const compact = await messaging.compact(compactRequest);
	if (compact.status !== "committed" || compact.value.removedMessages !== 1)
		throw new Error("compact receipt did not replay");
	const gap = await messaging.readRetainedLog({
		topic: "orders",
		afterSequence: 0,
		limit: 1,
	});
	if (gap.status !== "gap" || gap.firstAvailableSequence !== 2)
		throw new Error("retention gap was not explicit");
	const events = await messaging.events({ afterSequence: 0, limit: 10 });
	if (events.status !== "ok" || events.events.length !== 3)
		throw new Error("audit sequence mismatch");
	process.stdout.write(
		"rivet-topic-partial-live-ok process-restart=unverified fault-placement=unverified ingress=unverified",
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
