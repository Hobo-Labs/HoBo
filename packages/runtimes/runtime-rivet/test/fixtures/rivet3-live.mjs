import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import { actor, setup } from "rivetkit";
import { setupTest } from "rivetkit/test";
import {
	createRivetDistributedJournal,
	createRivetDistributedJournalActor,
} from "../../src/distributed-actor.ts";
import {
	createRivetCapabilityVerifier,
	issueRivetCapability,
} from "../../src/distributed-auth.ts";
import {
	initialDistributedJournal,
	transitionDistributedJournal,
} from "../../src/distributed-journal.ts";

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
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const verifier = createRivetCapabilityVerifier({
	issuer: "station",
	audience: "journal",
	publicKey,
	nowMs: Date.now,
	authorize: ({ claims, actorKey }) =>
		claims.subject === "trusted" &&
		actorKey[1] === "tenant" &&
		actorKey[2] === "camp",
});
const issueCapability = (operation) => {
	const issuedAtMs = Date.now();
	return issueRivetCapability(
		{
			...operation,
			issuer: "station",
			audience: "journal",
			subject: "trusted",
			capabilityId: randomUUID(),
			issuedAtMs,
			expiresAtMs: issuedAtMs + 30_000,
		},
		privateKey,
	);
};
const productionJournal = createRivetDistributedJournalActor(verifier);
const journalUnderTest = actor({
	...productionJournal.config,
	actions: {
		...productionJournal.config.actions,
		sleepForTest: (context) => context.sleep(),
		populateForTest: (context) =>
			context.db.transaction(async (tx) => {
				for (let seq = 1; seq <= 1_024; seq++)
					await tx.execute(
						"INSERT INTO hobo_journal_facts(seq,event_id,expected_revision,event_json) VALUES(?,?,?,?)",
						seq,
						`seed-${seq}`,
						seq - 1,
						JSON.stringify({ type: "Seed" }),
					);
				for (let seq = 1; seq <= 4_096; seq++)
					await tx.execute(
						"INSERT INTO hobo_journal_grants(request,holder,token,expires) VALUES(?,?,?,?)",
						`grant-${seq}`,
						"seed",
						seq,
						1,
					);
				await tx.execute(
					"UPDATE hobo_journal_head SET revision=?,epoch=? WHERE id=1",
					1_024,
					4_096,
				);
			}),
	},
});
const registry = setup({
	use: { counter, hoboJournal: journalUnderTest },
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
	const handle = client.counter.getOrCreate(["test"]);
	if ((await handle.increment()) !== 1 || (await handle.increment()) !== 2)
		throw new Error("Rivet actor state did not advance");
	const journal = createRivetDistributedJournal(client.hoboJournal, {
		tenantId: "tenant",
		campId: "camp",
		issueCapability,
	});
	const lease = await journal.acquireWithRequest("orders", {
		holderId: "writer-a",
		requestId: "live-request-a",
	});
	const competing = await Promise.allSettled([
		journal.acquireWithRequest("orders", {
			holderId: "writer-b",
			requestId: "live-request-b",
		}),
		journal.acquireWithRequest("orders", {
			holderId: "writer-c",
			requestId: "live-request-c",
		}),
	]);
	if (competing.some((item) => item.status !== "rejected"))
		throw new Error("Rivet granted overlapping leases");
	const fact = {
		eventId: "order-1",
		expectedRevision: 0,
		event: { type: "OrderCreated", id: "1" },
	};
	const appended = await journal.append("orders", lease, fact);
	const replay = await journal.append("orders", lease, fact);
	if (
		appended.revision !== 1 ||
		appended.duplicate ||
		!replay.duplicate ||
		replay.revision !== 1
	)
		throw new Error("Rivet journal did not deduplicate a replay");
	const observed = await journal.read("orders");
	if (
		observed.revision !== 1 ||
		observed.events[0]?.event.type !== "OrderCreated"
	)
		throw new Error("Rivet did not persist the journal event");
	try {
		await client.hoboJournal
			.getOrCreate(["hobo", "tenant", "camp", "orders"])
			.sleepForTest();
	} catch {
		// Sleeping can close the request before its acknowledgement arrives.
	}
	const afterWake = await journal.read("orders");
	if (
		afterWake.revision !== 1 ||
		afterWake.events[0]?.event.type !== "OrderCreated"
	)
		throw new Error("Rivet did not recover the journal after sleep");
	await lease.revalidate();
	await lease.release();
	const next = await journal.acquireWithRequest("orders", {
		holderId: "writer-b",
		requestId: "live-request-b",
	});
	if (next.fenceToken !== lease.fenceToken + 1n)
		throw new Error("Rivet fence did not advance");
	await next.release();
	const sqlKey = ["hobo", "tenant", "camp", "sql-orders"];
	const sql = client.hoboJournal.getOrCreate(sqlKey);
	const authorized = (actorKey, action, args) => ({
		args,
		capability: issueCapability({ actorKey, action, args }),
	});
	await sql.populateForTest();
	const sqlLease = await sql.acquire(
		authorized(sqlKey, "acquire", {
			holderId: "writer",
			requestId: "sql-request",
		}),
	);
	if (sqlLease.status !== "acquired" || sqlLease.fenceToken !== 4_097)
		throw new Error("SQL journal lease failed above the former capacity");
	const sqlInput = {
		holderId: "writer",
		requestId: "sql-request",
		fenceToken: 4_097,
		eventId: "after-cap",
		expectedRevision: 1_024,
		event: { type: "Saved", text: "é".repeat(16_000) },
	};
	const sqlAppend = await sql.append(authorized(sqlKey, "append", sqlInput));
	const sqlReplay = await sql.append(authorized(sqlKey, "append", sqlInput));
	if (
		sqlAppend.status !== "appended" ||
		sqlAppend.revision !== 1_025 ||
		!sqlReplay.duplicate
	)
		throw new Error("SQL journal failed above the former capacity");
	const tampered = authorized(sqlKey, "read", {
		afterRevision: 1_024,
		limit: 1,
	});
	tampered.args.afterRevision = 0;
	if ((await sql.read(tampered)).code !== "UNAUTHORIZED")
		throw new Error("modified signed arguments were accepted");
	const wrongKey = authorized(["hobo", "tenant", "camp", "other"], "read", {
		afterRevision: 0,
		limit: 1,
	});
	if ((await sql.read(wrongKey)).code !== "UNAUTHORIZED")
		throw new Error("cross-actor capability was accepted");
	try {
		await sql.sleepForTest();
	} catch {
		/* sleep can lose its acknowledgement */
	}
	const sqlPage = await sql.read(
		authorized(sqlKey, "read", { afterRevision: 1_024, limit: 1 }),
	);
	if (
		sqlPage.status !== "ok" ||
		sqlPage.revision !== 1_025 ||
		sqlPage.events[0]?.event.type !== "Saved"
	)
		throw new Error("SQL journal did not recover after sleep");
	const firstPage = await journal.read("sql-orders", { limit: 2 });
	const secondPage = await journal.read("sql-orders", {
		afterRevision: firstPage.nextRevision,
		throughRevision: firstPage.revision,
		limit: 2,
	});
	if (
		!firstPage.hasMore ||
		secondPage.nextRevision !== 4 ||
		secondPage.revision !== 1_025
	)
		throw new Error("pinned journal pagination failed");
	const modelKey = ["hobo", "tenant", "camp", "model"];
	const modelActor = client.hoboJournal.getOrCreate(modelKey);
	let model = initialDistributedJournal();
	const commands = [
		["acquire", { holderId: "a", requestId: "one" }],
		["acquire", { holderId: "b", requestId: "two" }],
		[
			"append",
			{
				holderId: "a",
				requestId: "one",
				fenceToken: 1,
				expectedRevision: 0,
				eventId: "e",
				event: { type: "Saved" },
			},
		],
		[
			"append",
			{
				holderId: "a",
				requestId: "one",
				fenceToken: 1,
				expectedRevision: 0,
				eventId: "e",
				event: { type: "Saved" },
			},
		],
		[
			"append",
			{
				holderId: "a",
				requestId: "one",
				fenceToken: 1,
				expectedRevision: 0,
				eventId: "other",
				event: { type: "Saved" },
			},
		],
		["release", { holderId: "a", requestId: "one", fenceToken: 1 }],
		["acquire", { holderId: "b", requestId: "two" }],
		["check", { holderId: "a", requestId: "one", fenceToken: 1 }],
	];
	for (const [action, args] of commands) {
		const expected = transitionDistributedJournal(model, {
			kind: action,
			...args,
			nowMs: Date.now(),
		});
		model = expected.state;
		const actual = await modelActor[action](authorized(modelKey, action, args));
		for (const key of ["status", "code", "fenceToken", "revision", "duplicate"])
			if (expected.result[key] !== actual[key])
				throw new Error(
					`SQL/model mismatch for ${action}: ${JSON.stringify({ expected: expected.result, actual })}`,
				);
	}
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
