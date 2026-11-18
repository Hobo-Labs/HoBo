import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import { createRivetDurableTopicBusActor } from "../../src/durable-topic-actor.ts";
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
let logicalNow = Date.now();
const instanceSignature = (claim) =>
	createHmac("sha256", secret)
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
try {
	await openRegistry();
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
	const createClient = (instanceGrant = true) =>
		createRivetDurableTopicClient({
			binding: base,
			metadataGrant: createRivetDurableTopicMetadataGrant(),
			verifyTransport: (claim) =>
				claim.fetch === fetch &&
				claim.maxResponseBytes === 262_144 &&
				claim.maxResponseChunks === 4096,
			authorize: (claim) => ({
				"x-hobo-proof": signature(claim),
				"x-hobo-instance-proof": instanceGrant
					? instanceSignature(claim)
					: "0".repeat(64),
			}),
			revalidate: () => true,
			fetch,
		});
	const messaging = createClient();
	const denied = createClient(false);
	const expiresAtMs = logicalNow + 60_000;
	let counter = 0;
	const operation = () => ({
		id: `v1.${expiresAtMs}.${String(++counter).padStart(16, "0")}`,
		expiresAtMs,
	});
	const committed = (outcome, label) => {
		if (outcome.status !== "committed")
			throw new Error(`${label} did not commit: ${JSON.stringify(outcome)}`);
		return outcome.value;
	};
	const same = (left, right, label) => {
		if (JSON.stringify(left) !== JSON.stringify(right))
			throw new Error(`${label} differs: ${JSON.stringify({ left, right })}`);
	};
	const settle = (delivery) => ({
		topic: delivery.topic,
		consumerGroup: delivery.consumerGroup,
		messageId: delivery.message.id,
		sequence: delivery.sequence,
		leaseId: delivery.leaseId,
	});
	const consume = (topic, consumerGroup) => ({
		operation: operation(),
		topic,
		consumerGroup,
		maxMessages: 1,
		visibilityTimeoutMs: 100,
	});
	const subscription = (
		topic,
		consumerGroup,
		deadLetterTopic,
		maxDeliveryAttempts,
	) => ({
		operation: operation(),
		subscription: {
			topic,
			consumerGroup,
			deadLetterTopic,
			maxDeliveryAttempts,
			startAt: "earliest",
		},
	});
	for (const topic of ["orders", "dlq", "archive"])
		committed(
			await messaging.ensureTopic({ operation: operation(), topic }),
			`topic ${topic}`,
		);
	const beforeDenied = await messaging.events({ afterSequence: 0, limit: 100 });
	const deniedRequest = subscription("orders", "workers", "dlq", 2);
	if ((await denied.ensureSubscription(deniedRequest)).status !== "unknown")
		throw new Error("missing whole-instance grant was accepted");
	same(
		await messaging.events({ afterSequence: 0, limit: 100 }),
		beforeDenied,
		"audit after denied subscription",
	);
	committed(
		await messaging.ensureSubscription(deniedRequest),
		"source subscription",
	);
	committed(
		await messaging.ensureSubscription(
			subscription("dlq", "reader", "archive", 1),
		),
		"DLQ subscription",
	);
	const publish = {
		operation: operation(),
		topic: "orders",
		message: {
			id: "order-1",
			subject: "created",
			payload: new Uint8Array([0, 1, 254, 255]),
			attributes: [{ key: "source", value: "checkout" }],
		},
	};
	dropPath = "/publish";
	if ((await messaging.publish(publish)).status !== "unknown")
		throw new Error("lost publication acknowledgement was not unknown");
	const receipt = committed(
		await messaging.publish(publish),
		"publication replay",
	);
	if (receipt.sequence !== 1 || receipt.messageId !== "order-1")
		throw new Error("wrong publication receipt");
	const firstRequest = consume("orders", "workers");
	const firstOutcome = await messaging.consume(firstRequest);
	const [first] = committed(firstOutcome, "first lease");
	if (
		!first ||
		first.deliveryAttempt !== 1 ||
		first.message.id !== "order-1" ||
		Buffer.compare(first.message.payload, publish.message.payload) !== 0
	)
		throw new Error("wrong first delivery");
	same(
		await messaging.consume(firstRequest),
		firstOutcome,
		"first lease replay",
	);
	const release = committed(
		await messaging.nack({
			operation: operation(),
			...settle(first),
			reason: "retry",
		}),
		"release",
	);
	if (release.disposition !== "released")
		throw new Error("nack did not release");
	const second = committed(
		await messaging.consume(consume("orders", "workers")),
		"second lease",
	)[0];
	if (
		!second ||
		second.deliveryAttempt !== 2 ||
		second.leaseId === first.leaseId
	)
		throw new Error("second attempt did not get a new lease");
	const nack = { operation: operation(), ...settle(second), reason: "fatal" };
	dropPath = "/nack";
	if ((await messaging.nack(nack)).status !== "unknown")
		throw new Error("lost DLQ acknowledgement was not unknown");
	const nackReceipt = committed(await messaging.nack(nack), "nack replay");
	if (nackReceipt.disposition !== "dead-lettered")
		throw new Error("terminal nack did not dead-letter");
	const dead = committed(
		await messaging.consume(consume("dlq", "reader")),
		"DLQ delivery",
	)[0];
	if (
		!dead ||
		dead.message.id !== nackReceipt.deadLetterMessageId ||
		dead.sequence !== nackReceipt.deadLetterSequence ||
		dead.deadLetter?.originalMessageId !== "order-1" ||
		dead.deadLetter.deliveryAttempt !== 2 ||
		dead.deadLetter.cause.kind !== "nack" ||
		dead.deadLetter.cause.reason !== "fatal"
	)
		throw new Error("nack DLQ provenance mismatch");
	committed(
		await messaging.ack({ operation: operation(), ...settle(dead) }),
		"DLQ acknowledgement",
	);
	if (
		committed(await messaging.consume(consume("dlq", "reader")), "empty DLQ")
			.length !== 0
	)
		throw new Error("replayed nack duplicated a dead letter");

	const expiryPublish = {
		...publish,
		operation: operation(),
		message: { ...publish.message, id: "order-2" },
	};
	committed(await messaging.publish(expiryPublish), "expiry publication");
	const expiryRequest = consume("orders", "workers");
	const expiryOutcome = await messaging.consume(expiryRequest);
	const expired = committed(expiryOutcome, "expiry first lease")[0];
	if (!expired || expired.deliveryAttempt !== 1)
		throw new Error("missing expiry lease");
	logicalNow += 101;
	same(
		await messaging.consume(expiryRequest),
		expiryOutcome,
		"expired receipt replay",
	);
	const oldAck = await messaging.ack({
		operation: operation(),
		...settle(expired),
	});
	if (oldAck.status !== "rejected" || oldAck.code !== "lease-lost")
		throw new Error("expired lease acknowledged");
	const redelivery = committed(
		await messaging.consume(consume("orders", "workers")),
		"expiry redelivery",
	)[0];
	if (
		!redelivery ||
		redelivery.deliveryAttempt !== 2 ||
		redelivery.leaseId === expired.leaseId
	)
		throw new Error("expired message was not re-leased");
	logicalNow += 101;
	if (
		committed(
			await messaging.consume(consume("orders", "workers")),
			"expiry transfer",
		).length !== 0
	)
		throw new Error("expired final lease was redelivered");
	const expiredDead = committed(
		await messaging.consume(consume("dlq", "reader")),
		"expired DLQ delivery",
	)[0];
	if (
		!expiredDead ||
		expiredDead.deadLetter?.originalMessageId !== "order-2" ||
		expiredDead.deadLetter.deliveryAttempt !== 2 ||
		expiredDead.deadLetter.cause.kind !== "lease-expired"
	)
		throw new Error("expiry DLQ provenance mismatch");

	await stopRegistry();
	await openRegistry();
	same(
		await messaging.publish(publish),
		{ status: "committed", value: receipt },
		"publication after registry restart",
	);
	same(
		await messaging.nack(nack),
		{ status: "committed", value: nackReceipt },
		"nack after registry restart",
	);
	same(
		await messaging.consume(expiryRequest),
		expiryOutcome,
		"lease receipt after registry restart",
	);
	committed(
		await messaging.ack({ operation: operation(), ...settle(expiredDead) }),
		"expiry DLQ acknowledgement",
	);
	if (
		committed(
			await messaging.consume(consume("dlq", "reader")),
			"empty DLQ after restart",
		).length !== 0
	)
		throw new Error("restart or replay duplicated a dead letter");
	process.stdout.write(
		"rivet-topic-bus-live-ok registry-reopen=observed process-restart=unverified fault-placement=unverified ingress=unverified contention=unverified rollback=unverified old-owner-fence=unverified",
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
