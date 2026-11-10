/**
 * Proof of the relay's database fleet on three real PostgreSQL servers.
 *
 * It runs the real relay (bootstrap entry, real stores, real tables) behind
 * the fleet, stops and starts real servers, and asserts eight properties in
 * order. Every plan number in it is a PLACEHOLDER chosen so that a budget
 * signal is easy to trigger; none describes a real product.
 *
 *   HOBO_CI_TEST_FLEET_POSTGRES  three servers, comma-separated connection
 *                                strings, each naming a database the role may
 *                                create databases from
 *   HOBO_CI_TEST_FLEET_CONTROL   JSON array, one {"stop","start"} pair of shell
 *                                commands per server, in the same order
 *
 * The script creates its own databases and drops them. It leaves every server
 * running. It never prints a connection string.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	createHash,
	createHmac,
	generateKeyPairSync,
	randomBytes,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
	addUsage,
	billingPeriod,
	type FleetBackend,
	type FleetReconcileReport,
	parseFleetFinancialModel,
	readCurrentAssignment,
	readDataDigests,
	readSequencePositions,
	readUsage,
	readWatermark,
	replicateSnapshot,
	sqlAssignmentRegister,
	standbyLagMs,
} from "@hobo/data-postgres";
import pg from "pg";
import { z } from "zod";
import { createBootstrapEntry } from "../src/bootstrap-entry.js";
import { createDatabaseFleet } from "../src/database-fleet.js";
import {
	type DatabaseFleetConfig,
	parseDatabaseFleet,
	RELAY_FLEET_LAYOUT,
} from "../src/database-fleet-config.js";
import {
	qualifyBackend,
	RELAY_BACKEND_REQUIREMENTS,
} from "../src/database-fleet-conformance.js";
import { pgExecutor } from "../src/database-fleet-executor.js";

const servers = (process.env.HOBO_CI_TEST_FLEET_POSTGRES ?? "")
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);
if (servers.length !== 3)
	throw new Error("HOBO_CI_TEST_FLEET_POSTGRES must name three servers");
const control = z
	.array(z.object({ stop: z.string().min(1), start: z.string().min(1) }))
	.length(3)
	.parse(JSON.parse(process.env.HOBO_CI_TEST_FLEET_CONTROL ?? "null"));
const run = promisify(execFile);
const shell = (command: string) => run("/bin/sh", ["-c", command]);
const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const LEASE_MS = 2000;

const IDS = ["alpha", "beta", "gamma"] as const;
type Id = (typeof IDS)[number];
const database = `hobo_fleet_proof_${randomBytes(6).toString("hex")}`;
const admins = servers.map(
	(connectionString) => new pg.Pool({ connectionString, max: 1 }),
);
for (const admin of admins) admin.on("error", () => {});
const urls = servers.map((server) => {
	const url = new URL(server);
	url.pathname = `/${database}`;
	return url.toString();
});
for (const admin of admins) await admin.query(`CREATE DATABASE ${database}`);

/** Direct connections the proof itself uses to look, never the relay's. */
const direct = new Map<Id, pg.Pool>();
const backends = new Map<Id, FleetBackend>();
function connect(id: Id) {
	const pool = new pg.Pool({
		connectionString: urls[IDS.indexOf(id)],
		max: 4,
		connectionTimeoutMillis: 2000,
	});
	pool.on("error", () => {});
	direct.set(id, pool);
	backends.set(id, { id, executor: pgExecutor(pool) });
}
for (const id of IDS) connect(id);
const pool = (id: string) => {
	const found = direct.get(
		IDS.find((candidate) => candidate === id) ?? "alpha",
	);
	if (!found) throw new Error(`no connection to ${id}`);
	return found;
};
const backend = (id: string) => {
	const found = backends.get(
		IDS.find((candidate) => candidate === id) ?? "alpha",
	);
	if (!found) throw new Error(`no backend ${id}`);
	return found;
};
async function stop(id: Id) {
	await direct.get(id)?.end();
	await shell(control[IDS.indexOf(id)]?.stop ?? "false");
	console.log(`  [server] ${id} stopped`);
}
async function start(id: Id) {
	await shell(control[IDS.indexOf(id)]?.start ?? "false");
	connect(id);
	console.log(`  [server] ${id} started`);
}

// The relay's environment: bootstrap mode, three stores under three prefixes.
const origin = "https://ci.example.test";
const operator = "x".repeat(40);
const webhookSecret = "w".repeat(40);
const { privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
	privateKeyEncoding: { type: "pkcs8", format: "pem" },
	publicKeyEncoding: { type: "spki", format: "pem" },
});
const env = {
	HOBO_CI_PUBLIC_URL: origin,
	HOBO_CI_SESSION_KEY: randomBytes(32).toString("base64url"),
	HOBO_CI_BOOTSTRAP_ACCOUNT_ID: "platform",
	HOBO_CI_BOOTSTRAP_TOKEN_SHA256: createHash("sha256")
		.update(operator)
		.digest("hex"),
	CRON_SECRET: "c".repeat(40),
	HOBO_CI_CONFIG_JSON: await readFile(
		new URL(
			"../../ci/data-models/fixtures/valid/configuration.json",
			import.meta.url,
		),
		"utf8",
	),
	HOBO_CI_CONTROL_TOKENS_JSON: JSON.stringify({
		tokens: [
			{
				accountId: "example",
				installationIds: [],
				tokenSha256: createHash("sha256").update("a".repeat(40)).digest("hex"),
				scopes: ["repositories:write", "policy:read"],
			},
		],
	}),
	HOBO_CI_DATABASE_BACKENDS: "alpha=A_,beta=B_,gamma=C_",
	HOBO_CI_DATABASE_LEASE_SECONDS: String(LEASE_MS / 1000),
	HOBO_CI_DATABASE_FAILOVER_AFTER_SECONDS: "2",
	...Object.fromEntries(
		["A_", "B_", "C_"].flatMap((prefix, index) => [
			[`${prefix}DATABASE_URL`, urls[index]],
			[`${prefix}DATABASE_URL_UNPOOLED`, urls[index]],
		]),
	),
};

// GitHub, as far as creating the App goes.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
	const url = String(input);
	if (url === "https://api.github.com/app-manifests/code1/conversions")
		return Response.json({
			id: 42,
			pem: privateKey,
			webhook_secret: webhookSecret,
			client_id: "Iv1.test",
			client_secret: "client-secret",
		});
	if (url === "https://api.github.com/app")
		return Response.json({ id: 42, slug: "hobo-ci" });
	throw new Error("unexpected provider request");
};

// Structured events, captured with the time they were written.
const events: { at: number; event: string; step: string | undefined }[] = [];
const eventLines: string[] = [];
const info = console.info;
console.info = (line: string) => {
	try {
		const parsed = z
			.object({ event: z.string(), step: z.string().optional() })
			.parse(JSON.parse(line));
		events.push({ at: Date.now(), event: parsed.event, step: parsed.step });
		eventLines.push(line);
	} catch {
		info(line);
	}
};
const since = (mark: number, event: string) =>
	events
		.slice(mark)
		.filter((entry) => entry.event === `hobo_ci_database_fleet_${event}`);

/** PLACEHOLDER plan: `operations` a month, then a hard stop. */
function placeholder(id: string, operations: number) {
	return parseFleetFinancialModel({
		backend: id,
		plan: "placeholder",
		fixedMonthlyFeeMicros: 0,
		allowances: [
			{
				unit: "operations",
				included: operations,
				beyond: "hard-stop",
				meteredMicrosPerUnit: undefined,
			},
		],
		evidence: { source: "placeholder for the proof", observedAt: "2026-11-10" },
	});
}
const ROOMY = 1_000_000_000;
function fleetConfig(
	allowances: { [id in Id]: number },
	rpoSeconds?: number,
): DatabaseFleetConfig {
	const config = parseDatabaseFleet(
		rpoSeconds === undefined
			? env
			: { ...env, HOBO_CI_DATABASE_RPO_SECONDS: String(rpoSeconds) },
	);
	if (!config) throw new Error("fleet was not configured");
	return {
		...config,
		policy: { ...config.policy, minDwellMs: 0 },
		backends: config.backends.map((entry) => ({
			...entry,
			model: placeholder(
				entry.id,
				allowances[IDS.find((id) => id === entry.id) ?? "alpha"],
			),
		})),
	};
}
function relay(config: DatabaseFleetConfig) {
	return createDatabaseFleet({
		env,
		config,
		scheduledRepair: async () => {},
		build: async (settings) =>
			createBootstrapEntry({
				env,
				database: settings,
				notify: async () => {},
				continueRepair: async () => {},
				scheduledRepair: async () => {},
			}),
	});
}
type Relay = ReturnType<typeof relay>;

let deliveries = 0;
const acknowledged = new Set<string>();
/** Post one signed GitHub delivery; the relay commits it before answering. */
async function deliver(target: Relay): Promise<{ id: string; status: number }> {
	deliveries += 1;
	const id = `delivery-${deliveries}`;
	const body = JSON.stringify({
		action: "queued",
		workflow_job: { id: deliveries, run_id: deliveries, run_attempt: 1 },
		installation: { id: 1000 + deliveries },
		repository: { id: 1, full_name: "owner/repository" },
	});
	const response = await target.handle(
		new Request(`${origin}/github/webhooks`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-github-event": "workflow_job",
				"x-github-delivery": id,
				"x-hub-signature-256": `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`,
			},
			body,
		}),
	);
	await response.body?.cancel();
	if (response.status === 202) acknowledged.add(id);
	return { id, status: response.status };
}
async function inbox(id: string): Promise<string[]> {
	const result = await pool(id).query(
		"SELECT delivery_id FROM hobo_ci_inbox ORDER BY seq",
	);
	return result.rows.map((row) => row.delivery_id);
}
async function settled(report: FleetReconcileReport | undefined) {
	assert.ok(report, "the reconcile tick threw");
	return report;
}
const current = async () => {
	const resolution = await readCurrentAssignment(
		sqlAssignmentRegister(
			IDS.map((id) => backend(id)),
			RELAY_FLEET_LAYOUT,
		),
	);
	assert.equal(resolution.status, "current");
	if (resolution.status !== "current") throw new Error("unreachable");
	return resolution.assignment;
};
const passed: string[] = [];
function proof(number: number, title: string, evidence: string) {
	passed.push(`${number}. ${title}: ${evidence}`);
	console.log(`PROOF ${number} PASSED  ${title}\n  ${evidence}`);
}

const relays: Relay[] = [];
try {
	// Qualify each backend with HoBo's own PostgreSQL conformance suite.
	for (const id of IDS) {
		const report = await qualifyBackend(
			pool(id),
			{ ...RELAY_BACKEND_REQUIREMENTS, serverVersionMajor: 16 },
			Date.now(),
		);
		assert.equal(report.outcome, "pass");
		console.log(
			`CONFORMANCE ${id}: ${report.outcome}; ran ${report.results
				.map((result) => `${result.caseId}=${result.status}`)
				.join(", ")}; not advertised: ${report.skipped.length} cases`,
		);
	}

	// ── 1 ── Three empty backends: schema, first assignment, relay data.
	const first = relay(fleetConfig({ alpha: ROOMY, beta: ROOMY, gamma: ROOMY }));
	const second = relay(
		fleetConfig({ alpha: ROOMY, beta: ROOMY, gamma: ROOMY }),
	);
	relays.push(first, second);
	let response = await first.handle(
		new Request(`${origin}/v1/app-bootstrap/start`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${operator}`,
				"content-type": "application/json",
				origin,
			},
			body: JSON.stringify({ name: "HoBo CI" }),
		}),
	);
	assert.equal(response.status, 200);
	const cookie = response.headers
		.getSetCookie()
		.find((value) => value.startsWith("__Host-hobo_ci_bootstrap="))
		?.split(";")[0];
	assert.ok(cookie);
	const state = new URL(
		z.object({ action: z.string() }).parse(await response.json()).action,
	).searchParams.get("state");
	response = await first.handle(
		new Request(
			`${origin}/v1/app-bootstrap/callback?state=${state}&code=code1`,
			{
				headers: { cookie, accept: "text/html" },
			},
		),
	);
	assert.equal(response.status, 303);
	assert.equal(first.writer(), "alpha");
	assert.deepEqual(
		{ epoch: (await current()).epoch, active: (await current()).active },
		{ epoch: 1, active: "alpha" },
	);
	for (let count = 0; count < 5; count += 1)
		assert.equal((await deliver(first)).status, 202);
	assert.equal((await inbox("alpha")).length, 5);
	let mark = events.length;
	let report = await settled(await first.reconcile());
	const relayTables = async (id: string) =>
		(
			await pool(id).query(
				"SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'hobo_ci_%' AND tablename NOT LIKE 'hobo_ci_fleet_%'",
			)
		).rows[0].count;
	assert.ok((await relayTables("alpha")) >= 20);
	assert.equal(await relayTables("beta"), await relayTables("alpha"));
	assert.equal(await relayTables("gamma"), await relayTables("alpha"));
	assert.deepEqual(
		report.observations.map((entry) => entry.schemaCurrent),
		[true, true, true],
	);
	proof(
		1,
		"empty backends, schema, first assignment, relay data",
		`assignment epoch 1 active=alpha decided by bootstrap on 3 of 3 logs; ${await relayTables("alpha")} relay tables created on each backend by the relay's own initialisers; 5 webhook deliveries committed on alpha through the real relay`,
	);

	// ── 2 ── Replication: digests, sequences, watermark, lag.
	const writerDigests = await readDataDigests(
		backend("alpha"),
		RELAY_FLEET_LAYOUT,
	);
	for (const id of ["beta", "gamma"]) {
		assert.deepEqual(
			await readDataDigests(backend(id), RELAY_FLEET_LAYOUT),
			writerDigests,
		);
		assert.deepEqual(
			await readSequencePositions(backend(id), RELAY_FLEET_LAYOUT),
			await readSequencePositions(backend("alpha"), RELAY_FLEET_LAYOUT),
		);
	}
	const watermark = await readWatermark(backend("beta"), RELAY_FLEET_LAYOUT);
	assert.ok(watermark);
	assert.equal(watermark.source, "alpha");
	assert.equal(watermark.sourceEpoch, 1);
	assert.deepEqual(watermark.tables, writerDigests);
	const lag = standbyLagMs(watermark, Date.now());
	assert.ok(lag >= 0 && lag < 30_000);
	const sequences = (
		await readSequencePositions(backend("beta"), RELAY_FLEET_LAYOUT)
	).filter((entry) => entry.value !== undefined);
	assert.ok(sequences.some((entry) => entry.table === "hobo_ci_inbox"));
	assert.ok(since(mark, "replication").length >= 2);
	const bootstrapLogs = await Promise.all(
		IDS.map(
			async (id) =>
				(
					await pool(id).query(
						"SELECT epoch::text, active, decided_by FROM hobo_ci_fleet_assignments",
					)
				).rows,
		),
	);
	for (const log of bootstrapLogs)
		assert.deepEqual(log, [
			{ epoch: "1", active: "alpha", decided_by: "bootstrap" },
		]);
	proof(
		2,
		"replication",
		`${writerDigests.length} tables, ${watermark.rowCount} rows: per-table SHA-256 digests equal on alpha, beta and gamma; sequences ${sequences.map((entry) => `${entry.table}.${entry.column}=${entry.value}`).join(", ")} equal on all three; watermark source=alpha epoch=1 digest=${watermark.digest.slice(0, 16)}…; standby lag ${lag} ms`,
	);

	// ── 3 ── Planned switch on a budget signal.
	// PLACEHOLDER: alpha may do 10,000 operations a month and has done 9,990.
	const switching = relay(
		fleetConfig({ alpha: 10_000, beta: ROOMY, gamma: 50_000 }),
	);
	relays.push(switching);
	await addUsage(backend("alpha"), RELAY_FLEET_LAYOUT, {
		period: billingPeriod(Date.now()).id,
		unit: "operations",
		used: 9990,
	});
	assert.equal((await deliver(second)).status, 202);
	assert.equal(second.writer(), "alpha");
	// A second instance keeps taking deliveries while the first one switches.
	const traffic: { at: number; id: string; status: number; writer?: string }[] =
		[];
	let trafficOn = true;
	const stream = (async () => {
		while (trafficOn) {
			const at = Date.now();
			const outcome = await deliver(second);
			const writer = second.writer();
			traffic.push(
				writer === undefined ? { at, ...outcome } : { at, ...outcome, writer },
			);
			await sleep(100);
		}
	})();
	mark = events.length;
	report = await settled(await switching.reconcile());
	await sleep(LEASE_MS);
	trafficOn = false;
	await stream;
	assert.equal(report.decision?.action, "switch");
	assert.equal(report.decision?.target, "beta");
	// Both signals: the projection, and HoBo's budget evaluator refusing the
	// writer's next period against its (placeholder) allowance.
	assert.deepEqual(report.decision?.reasons, [
		"operations-exhaustion-projected",
		"budget-infeasible:budget.policy.constraint",
	]);
	assert.deepEqual(
		report.transitions.map((entry) => [entry.step, entry.status]),
		[
			["seal", "decided"],
			["activate", "decided"],
		],
	);
	const sealedAt = since(mark, "transition").find(
		(entry) => entry.step === "seal",
	)?.at;
	const activatedAt = since(mark, "transition").find(
		(entry) => entry.step === "activate",
	)?.at;
	assert.ok(sealedAt && activatedAt);
	const now3 = await current();
	assert.deepEqual(
		{
			epoch: now3.epoch,
			active: now3.active,
			sealed: now3.sealed,
			loss: now3.lossWindowMs,
		},
		{ epoch: 3, active: "beta", sealed: false, loss: undefined },
	);
	// Zero loss: every delivery any instance acknowledged is on the new writer.
	const onBeta = new Set(await inbox("beta"));
	const missing = [...acknowledged].filter((id) => !onBeta.has(id));
	assert.deepEqual(missing, []);
	// The instance holding the old assignment was refused within one lease of
	// the seal, and nothing it acknowledged after that went to the old writer.
	const refused = traffic.filter((entry) => entry.status === 503);
	const firstRefusal = refused[0];
	assert.ok(firstRefusal, "the second instance was never refused");
	assert.ok(firstRefusal.at - sealedAt <= LEASE_MS + 500);
	const lateOnOld = traffic.filter(
		(entry) =>
			entry.status === 202 &&
			entry.writer === "alpha" &&
			entry.at > sealedAt + LEASE_MS,
	);
	assert.deepEqual(lateOnOld, []);
	const resumed = traffic.filter(
		(entry) => entry.status === 202 && entry.at > activatedAt,
	);
	assert.ok(resumed.length > 0, "the second instance never resumed");
	assert.ok(resumed.every((entry) => entry.writer === "beta"));
	assert.equal(second.writer(), "beta");
	// Inserts on the new writer continue after the copied sequence values.
	const seqs = (
		await pool("beta").query("SELECT seq::text FROM hobo_ci_inbox ORDER BY seq")
	).rows.map((row) => Number(row.seq));
	assert.equal(new Set(seqs).size, seqs.length);
	const copiedMax = Math.max(
		...(
			await pool("alpha").query("SELECT seq::text FROM hobo_ci_inbox")
		).rows.map((row) => Number(row.seq)),
	);
	assert.ok(seqs.some((seq) => seq > copiedMax));
	proof(
		3,
		"planned switch on a budget signal",
		`decision switch→beta (${report.decision?.reasons.join(", ")}); epoch 2 sealed, epoch 3 active=beta, loss_window_ms NULL; ${acknowledged.size} acknowledged deliveries, 0 missing on beta; second instance first refused ${firstRefusal.at - sealedAt} ms after the seal (lease ${LEASE_MS} ms), ${refused.length} requests got 503, then resumed on beta ${resumed[0] ? resumed[0].at - activatedAt : "?"} ms after activation; inbox seq on beta unique, new rows above copied max ${copiedMax}`,
	);

	// ── 5 and 4 ── The writer's server stops.
	report = await settled(await first.reconcile());
	assert.deepEqual(
		report.replications.map((entry) => [
			entry.source,
			entry.target,
			entry.status,
		]),
		[
			["beta", "alpha", "replicated"],
			["beta", "gamma", "replicated"],
		],
	);
	const beforeOutage = new Set(acknowledged);
	const afterLastCopy: string[] = [];
	for (let count = 0; count < 4; count += 1) {
		const outcome = await deliver(second);
		assert.equal(outcome.status, 202);
		afterLastCopy.push(outcome.id);
	}
	await stop("beta");

	// 5: with an objective of one second every standby is too old.
	await sleep(1500);
	const strict = relay(
		fleetConfig({ alpha: ROOMY, beta: ROOMY, gamma: ROOMY }, 1),
	);
	relays.push(strict);
	report = await settled(await strict.reconcile());
	assert.equal(report.decision?.action, "hold");
	assert.deepEqual(report.decision?.reasons, [
		"writer-unreachable",
		"no-standby-within-rpo",
	]);
	assert.deepEqual(report.transitions, []);
	const held = await current();
	assert.deepEqual(
		{ epoch: held.epoch, active: held.active },
		{ epoch: 3, active: "beta" },
	);
	proof(
		5,
		"recovery point guard",
		`writer beta stopped, objective 1 s: decision hold (${report.decision?.reasons.join(", ")}); candidates ${report.decision?.candidates.map((entry) => `${entry.backend}: ${entry.reasons[0]}`).join("; ")}; assignment still epoch 3 active=beta`,
	);

	// 4: with the normal objective the freshest standby is promoted.
	report = await settled(await first.reconcile());
	assert.equal(report.decision?.action, "failover");
	const promoted = report.decision?.target;
	assert.ok(promoted === "alpha" || promoted === "gamma");
	const writerSeen = report.observations.find(
		(entry) => entry.backend === "beta",
	);
	assert.equal(writerSeen?.health, "unreachable");
	assert.ok((writerSeen?.failingForMs ?? 0) >= 2000);
	const lags = report.observations
		.filter((entry) => entry.backend !== "beta")
		.map((entry) => entry.standbyLagMs ?? Number.POSITIVE_INFINITY);
	const promotedLag = report.observations.find(
		(entry) => entry.backend === promoted,
	)?.standbyLagMs;
	assert.equal(promotedLag, Math.min(...lags));
	const after4 = await current();
	assert.equal(after4.epoch, 4);
	assert.equal(after4.active, promoted);
	assert.equal(after4.lossWindowMs, report.decision?.lossWindowMs);
	assert.equal(after4.lossWindowMs, promotedLag);
	assert.equal(after4.reason, "failover:writer-unreachable");
	const onPromoted = new Set(await inbox(promoted));
	const lost = [...acknowledged].filter((id) => !onPromoted.has(id)).sort();
	assert.deepEqual(lost, [...afterLastCopy].sort());
	assert.ok([...beforeOutage].every((id) => onPromoted.has(id)));
	// The relay comes back on the promoted standby without a human.
	await sleep(LEASE_MS);
	let recovered = await deliver(second);
	for (
		let attempt = 0;
		attempt < 20 && recovered.status !== 202;
		attempt += 1
	) {
		await sleep(250);
		recovered = await deliver(second);
	}
	assert.equal(recovered.status, 202);
	assert.equal(second.writer(), promoted);
	proof(
		4,
		"unplanned failover",
		`beta stopped (pg_ctl), failing ${writerSeen?.failingForMs} ms ≥ 2000 ms threshold; promoted ${promoted}, the freshest standby (lags ${lags.join(" and ")} ms); epoch 4 active=${promoted} loss_window_ms=${after4.lossWindowMs} = its lag; ${beforeOutage.size} deliveries from before the last copy all present; lost exactly the ${lost.length} acknowledged after it: ${lost.join(", ")}; relay serving again on ${promoted}`,
	);

	// ── 6 ── The old writer returns.
	await start("beta");
	const beforeRepair = (
		await pool("beta").query(
			"SELECT epoch::text, active FROM hobo_ci_fleet_assignments ORDER BY epoch DESC LIMIT 1",
		)
	).rows[0];
	assert.deepEqual(beforeRepair, { epoch: "3", active: "beta" });
	const stillThere = new Set(await inbox("beta"));
	assert.ok(afterLastCopy.every((id) => stillThere.has(id)));
	// Its own log says it is the writer: a copy into it is refused there.
	const premature = await replicateSnapshot({
		source: backend(promoted),
		target: backend("beta"),
		layout: RELAY_FLEET_LAYOUT,
		assignment: after4,
	});
	assert.deepEqual(
		{
			status: premature.status,
			refusal: premature.status === "refused" ? premature.refusal : "",
		},
		{ status: "refused", refusal: "target-is-writer" },
	);
	// And the real writer cannot be overwritten, whatever a caller claims.
	const forged = await replicateSnapshot({
		source: backend("beta"),
		target: backend(promoted),
		layout: RELAY_FLEET_LAYOUT,
		assignment: { ...after4, active: "beta" },
	});
	assert.deepEqual(
		{
			status: forged.status,
			refusal: forged.status === "refused" ? forged.refusal : "",
		},
		{ status: "refused", refusal: "target-is-writer" },
	);
	report = await settled(await first.reconcile());
	const toBeta = report.replications.find((entry) => entry.target === "beta");
	assert.equal(toBeta?.status, "replicated");
	assert.equal(toBeta?.source, promoted);
	assert.deepEqual(
		await readDataDigests(backend("beta"), RELAY_FLEET_LAYOUT),
		await readDataDigests(backend(promoted), RELAY_FLEET_LAYOUT),
	);
	const overwritten = new Set(await inbox("beta"));
	assert.ok(afterLastCopy.every((id) => !overwritten.has(id)));
	assert.equal((await current()).active, promoted);
	proof(
		6,
		"the old writer returns as a standby",
		`beta came back with its own log at epoch 3 active=beta and the ${afterLastCopy.length} lost deliveries; a copy into it was refused on beta itself (target-is-writer); a forged copy into the writer ${promoted} was refused (target-is-writer); after the next tick repaired its log, beta was overwritten from ${promoted}: digests equal, the lost deliveries gone, writer still ${promoted}`,
	);

	// ── 7 ── Loss of majority.
	const others = IDS.filter((id) => id !== promoted);
	const [down1, down2] = others;
	assert.ok(down1 && down2);
	assert.equal((await deliver(second)).status, 202);
	await stop(down1);
	await stop(down2);
	const lostMajorityAt = Date.now();
	let closedAfter: number | undefined;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const outcome = await deliver(second);
		if (outcome.status === 503) {
			closedAfter = Date.now() - lostMajorityAt;
			break;
		}
		await sleep(100);
	}
	assert.ok(
		closedAfter !== undefined,
		"the relay kept writing without a majority",
	);
	assert.ok(closedAfter <= LEASE_MS + 1500);
	assert.equal(second.assignment(), undefined);
	const blocked = await second.handle(new Request(`${origin}/healthz`));
	assert.equal(blocked.status, 503);
	assert.ok(blocked.headers.get("retry-after"));
	// A tick without a majority changes nothing.
	const stuck = await settled(await first.reconcile());
	assert.equal(stuck.status, "no-majority");
	assert.deepEqual(stuck.transitions, []);
	await start(down1);
	let back = await deliver(second);
	const returnedAt = Date.now();
	for (let attempt = 0; attempt < 60 && back.status !== 202; attempt += 1) {
		await sleep(200);
		back = await deliver(second);
	}
	assert.equal(back.status, 202);
	const recoveredAfter = Date.now() - returnedAt;
	await start(down2);
	proof(
		7,
		"loss of majority",
		`${down1} and ${down2} stopped (2 of 3): the relay answered 503 with Retry-After ${closedAfter} ms later (lease ${LEASE_MS} ms) although its writer ${promoted} was up; a reconcile tick reported no-majority and changed nothing; ${down1} restarted: deliveries accepted again after ${recoveredAfter} ms`,
	);

	// ── 8 ── Two reconcilers at once.
	report = await settled(await first.reconcile());
	assert.equal(report.status, "settled");
	const allowances = { alpha: ROOMY, beta: ROOMY, gamma: ROOMY };
	// PLACEHOLDER: the current writer has all but spent a small allowance.
	allowances[promoted] = 10_000;
	const used = await readUsage(
		backend(promoted),
		RELAY_FLEET_LAYOUT,
		billingPeriod(Date.now()).id,
	);
	await addUsage(backend(promoted), RELAY_FLEET_LAYOUT, {
		period: billingPeriod(Date.now()).id,
		unit: "operations",
		used: Math.max(
			0,
			9990 - (used.find((entry) => entry.unit === "operations")?.used ?? 0),
		),
	});
	const left = relay(fleetConfig(allowances));
	const right = relay(fleetConfig(allowances));
	relays.push(left, right);
	const epochBefore = (await current()).epoch;
	const reports = await Promise.all([left.reconcile(), right.reconcile()]);
	const transitions = reports.flatMap((entry) => entry?.transitions ?? []);
	const decided = transitions.filter((entry) => entry.status === "decided");
	const perEpoch = new Map<number, number>();
	for (const entry of decided)
		if (entry.epoch !== undefined)
			perEpoch.set(entry.epoch, (perEpoch.get(entry.epoch) ?? 0) + 1);
	assert.ok(decided.length >= 1);
	assert.ok([...perEpoch.values()].every((count) => count === 1));
	const logs = await Promise.all(
		IDS.map(
			async (id) =>
				(
					await pool(id).query(
						"SELECT epoch::text, active, sealed, target, reason, decided_by FROM hobo_ci_fleet_assignments ORDER BY epoch",
					)
				).rows,
		),
	);
	assert.deepEqual(logs[1], logs[0]);
	assert.deepEqual(logs[2], logs[0]);
	const final = await current();
	assert.equal(final.sealed, false);
	assert.ok(final.epoch > epochBefore);
	proof(
		8,
		"two reconcilers at once",
		`both ticks wanted to switch off ${promoted}: ${transitions.map((entry) => `${entry.step}@${entry.epoch ?? "-"}=${entry.status}`).join(", ")}; decided entries per epoch ${[...perEpoch.entries()].map(([epoch, count]) => `${epoch}:${count}`).join(" ")}; the three logs are identical (${logs[0]?.length} entries); final epoch ${final.epoch} active=${final.active}`,
	);

	console.log(`\nALL ${passed.length} PROOFS PASSED`);
	for (const line of passed) console.log(line);
	const kinds = new Map<string, number>();
	for (const entry of events)
		kinds.set(entry.event, (kinds.get(entry.event) ?? 0) + 1);
	console.log(
		`structured events: ${[...kinds.entries()].map(([event, count]) => `${event}×${count}`).join(", ")}`,
	);
	for (const line of eventLines) assert.ok(!line.includes("postgres://"));
} finally {
	console.info = info;
	globalThis.fetch = originalFetch;
	for (const instance of relays) await instance.close().catch(() => {});
	// Leave every server running, then remove the proof's databases.
	for (const [index, id] of IDS.entries()) {
		try {
			await direct.get(id)?.end();
			await admins[index]?.query("SELECT 1");
		} catch {
			await shell(control[index]?.start ?? "false").catch(() => {});
		}
	}
	for (const admin of admins) {
		for (let attempt = 0; attempt < 50; attempt += 1) {
			try {
				await admin.query(`DROP DATABASE IF EXISTS ${database}`);
				break;
			} catch {
				await sleep(200);
			}
		}
		await admin.end().catch(() => {});
	}
}
