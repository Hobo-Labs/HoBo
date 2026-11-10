// The logical-copy native-transfer port without a server: the statements it
// issues on each side, in order; what it refuses; what it does with the
// connection string; and how it cleans up. Two scripted databases stand in
// for the source and the target, and the Pact file in contracts/pacts is
// replayed against the binding — every interaction issued exactly as
// recorded, every recorded answer read the way the pact means it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertBindingMatchesDeclaration,
	CUSTODY_ROLES,
	createMemoryMigrationJournal,
	DataCoreError,
	evaluateCustodyPath,
	type JsonObject,
	type NativeTransferPort,
	nativeTransferName,
	parseCustodyPath,
	schemaToJson,
	scopeOf,
} from "@hobo/data-core";
import { describe, test } from "vitest";
import { BOOTSTRAP_MARKER } from "../src/engine/statements.js";
import {
	captureObjectNames,
	createPostgresEngine,
	createSubscriptionStatement,
	LOGICAL_COPY_PROFILE,
	NATIVE_MARK,
	NATIVE_REACHED,
	NATIVE_SUBSCRIPTION_STATE,
	nativeSubscriptionName,
	nativeTransferKey,
	PG_DUMP_PROFILE,
	POSTGRES_IMPEDANCE_CODES,
	POSTGRES_MIGRATION_PROFILES,
	PostgresDataError,
	type PostgresEngine,
	type PostgresExecutor,
	type PostgresParameter,
	type PostgresQueryResult,
	type PostgresRow,
	PRESENT_NATIVE_SOURCE,
	parsePostgresNativeTicket,
	postgresEngineDeclaration,
} from "../src/index.js";
import {
	EVERY_TYPE_SCHEMA,
	PGOUTPUT_FIXTURE_NAMESPACE,
} from "./engine-support.js";

const NAMESPACE = PGOUTPUT_FIXTURE_NAMESPACE;
const DATASET = EVERY_TYPE_SCHEMA.name;
const TRANSFER = nativeTransferName("m1");
const KEY = nativeTransferKey(TRANSFER);
const OBJECTS = captureObjectNames("app", NAMESPACE, KEY);
const SUBSCRIPTION = nativeSubscriptionName(NAMESPACE, TRANSFER);
/** A stand-in credential. Recognisable, so any leak of it is findable. */
const SECRET = "host=source.internal user=replicator hunter2-marker";
const REF = {
	profile: LOGICAL_COPY_PROFILE,
	transfer: TRANSFER,
	scope: scopeOf(DATASET),
};

// ── the pact ────────────────────────────────────────────────────────────────

interface PactParameter {
	readonly text?: string;
	readonly secret?: boolean;
}

interface PactRequest {
	readonly sql: string;
	readonly parameters: readonly PactParameter[];
	readonly inTransaction: boolean;
}

interface PactInteraction {
	readonly description: string;
	readonly providerState: string;
	readonly request: { readonly body: PactRequest };
	readonly response: {
		readonly status: number;
		readonly body: {
			readonly rows?: readonly {
				readonly cells: readonly {
					readonly column: string;
					readonly text?: string;
				}[];
			}[];
			readonly rowCount?: number;
			readonly sqlState?: string;
		};
	};
}

interface NativePact {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly interactions: readonly PactInteraction[];
}

// SAFETY: the pact file is this repository's own contract document.
const PACT = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL(
				"../contracts/pacts/postgres-native-transfer.pact.json",
				import.meta.url,
			),
		),
		"utf8",
	),
) as NativePact;

const SOURCE = "source database";
const TARGET = "target database";
const UNREACHABLE = "the target server cannot reach the source";

// ── two scripted databases ──────────────────────────────────────────────────

function sqlError(code: string, message = "server said no"): Error {
	return Object.assign(new Error(message), { code });
}

interface Issued extends PactRequest {
	readonly raw: readonly PostgresParameter[];
}

interface Scripted {
	readonly executor: PostgresExecutor;
	readonly issued: Issued[];
	/** Pact interactions this database answered. */
	readonly exercised: Set<string>;
	state: string;
	/** hobo_data_subscriptions rows. */
	readonly registry: Map<string, PostgresRow>;
	readonly slots: Map<string, { active: boolean }>;
	readonly publications: Set<string>;
	readonly subscriptions: Set<string>;
	tableRows: number;
	/** Statements that fail, by a fragment of their text. */
	readonly failures: Map<string, Error[]>;
}

const rows = (...entries: PostgresRow[]): PostgresQueryResult => ({
	rows: entries,
	rowCount: entries.length,
});

/**
 * A database that answers the way the pact says for the statements the pact
 * covers, and keeps just enough state to answer the rest: the subscription
 * registry, which slots, publications and subscriptions exist, and whether
 * the dataset table is empty.
 */
function scripted(database: string, state: string): Scripted {
	let depth = 0;
	const self: Scripted = {
		issued: [],
		exercised: new Set(),
		state,
		registry: new Map(),
		slots: new Map(),
		publications: new Set(),
		subscriptions: new Set(),
		tableRows: 0,
		failures: new Map(),
		executor: {
			query: (sql, parameters = []) => answer(sql, parameters),
			async transaction(body) {
				depth += 1;
				try {
					return await body(self.executor);
				} finally {
					depth -= 1;
				}
			},
		},
	};
	const effects = (sql: string, parameters: readonly PostgresParameter[]) => {
		const quotedName = /"(hobo_[a-z]_[0-9a-f_]+)"/u.exec(sql)?.[1] ?? "";
		if (sql.startsWith("CREATE PUBLICATION")) self.publications.add(quotedName);
		if (sql.startsWith("DROP PUBLICATION"))
			self.publications.delete(quotedName);
		if (sql.includes("pg_create_logical_replication_slot")) {
			self.slots.set(parameters[0] ?? "", { active: false });
		}
		if (sql.includes("CREATE SUBSCRIPTION")) {
			self.subscriptions.add(/'(hobo_n_[0-9a-f_]+)'/u.exec(sql)?.[1] ?? "");
		}
		if (sql.startsWith("DROP SUBSCRIPTION")) {
			self.subscriptions.delete(quotedName);
		}
	};
	const answer = async (
		sql: string,
		parameters: readonly PostgresParameter[],
	): Promise<PostgresQueryResult> => {
		const request: PactRequest = {
			sql,
			// A credential is recorded as its marker, never as its text.
			parameters: parameters.map((value) =>
				value === SECRET
					? { secret: true }
					: value === null
						? {}
						: { text: value },
			),
			inTransaction: depth > 0,
		};
		self.issued.push({ ...request, raw: parameters });
		for (const [fragment, queue] of self.failures) {
			const failure = sql.includes(fragment) ? queue.shift() : undefined;
			if (failure !== undefined) throw failure;
		}
		const interaction = PACT.interactions.find(
			(candidate) =>
				candidate.providerState === self.state &&
				JSON.stringify(candidate.request.body) === JSON.stringify(request),
		);
		if (interaction !== undefined) {
			self.exercised.add(interaction.description);
			const { status, body } = interaction.response;
			if (status !== 200) throw sqlError(body.sqlState ?? "");
			effects(sql, parameters);
			return {
				rows: (body.rows ?? []).map((row) =>
					Object.fromEntries(
						row.cells.map((cell) => [cell.column, cell.text ?? null]),
					),
				),
				rowCount: body.rowCount ?? 0,
			};
		}
		effects(sql, parameters);
		if (sql.includes("pg_control_system()")) {
			return rows({ cluster: "7706419566366186209", database });
		}
		if (sql.includes("obj_description")) {
			return rows({ database, marker: BOOTSTRAP_MARKER });
		}
		if (sql.includes(`FROM "${NAMESPACE}"."hobo_data_datasets"`)) {
			return rows({
				schema_json: JSON.stringify(schemaToJson(EVERY_TYPE_SCHEMA)),
			});
		}
		const registry = `"${NAMESPACE}"."hobo_data_subscriptions"`;
		if (sql.startsWith(`INSERT INTO ${registry}`)) {
			self.registry.set(parameters[0] ?? "", {
				dataset: parameters[1] ?? null,
				slot_name: parameters[3] ?? null,
				publication_name: parameters[4] ?? null,
				start_position: parameters[5] ?? null,
			});
			return rows();
		}
		if (sql.startsWith(`DELETE FROM ${registry}`)) {
			self.registry.delete(parameters[0] ?? "");
			return rows();
		}
		if (sql.includes(`FROM ${registry} WHERE subscription = `)) {
			const found = self.registry.get(parameters[0] ?? "");
			return found === undefined ? rows() : rows(found);
		}
		if (sql.includes(`FROM ${registry} WHERE left(`)) {
			return rows(
				...[...self.registry.keys()]
					.filter((key) => key.startsWith(parameters[0] ?? ""))
					.map((subscription) => ({ subscription })),
			);
		}
		if (sql.includes("pg_create_logical_replication_slot")) {
			return rows({ lsn: "0/387C000" });
		}
		if (sql === NATIVE_MARK) return rows({ mark: "0/387C1A8" });
		if (sql.includes("pg_terminate_backend")) {
			const slot = self.slots.get(parameters[0] ?? "");
			if (slot?.active !== true) return rows();
			slot.active = false;
			return rows({ ended: "true" });
		}
		if (sql.includes("pg_drop_replication_slot")) {
			const existed = self.slots.delete(parameters[0] ?? "");
			return existed ? rows({ dropped: "" }) : rows();
		}
		if (sql === NATIVE_REACHED) {
			return self.slots.has(parameters[0] ?? "")
				? rows({ reached: "false" })
				: rows();
		}
		if (sql === NATIVE_SUBSCRIPTION_STATE) {
			return self.subscriptions.has(parameters[0] ?? "")
				? rows({ subscriptions: "1", tables: "1", ready: "0" })
				: rows({ subscriptions: "0", tables: "0", ready: "0" });
		}
		if (sql.includes("FROM pg_subscription s WHERE s.subname = ")) {
			return self.subscriptions.has(parameters[0] ?? "")
				? rows({ name: parameters[0] ?? "" })
				: rows();
		}
		if (sql.includes("FROM pg_subscription s WHERE s.subdbid")) {
			return rows(
				...[...self.subscriptions]
					.filter((name) => name.startsWith(parameters[0] ?? ""))
					.map((name) => ({ name })),
			);
		}
		if (sql.startsWith("SELECT 1::text AS present")) {
			return self.tableRows > 0 ? rows({ present: "1" }) : rows();
		}
		return rows();
	};
	return self;
}

interface Pair {
	readonly source: Scripted;
	readonly target: Scripted;
	readonly sourceBinding: PostgresEngine;
	readonly targetBinding: PostgresEngine;
	readonly sourcePort: NativeTransferPort;
	readonly targetPort: NativeTransferPort;
	/** Milliseconds the port waited, in order. */
	readonly waits: number[];
}

function pair(
	options: {
		readonly connection?: (() => string) | null;
		readonly targetNamespace?: string;
		readonly targetDatabase?: string;
	} = {},
): Pair {
	const source = scripted("app", SOURCE);
	const target = scripted(options.targetDatabase ?? "app_copy", TARGET);
	const waits: number[] = [];
	const nativeWait = async (milliseconds: number): Promise<void> => {
		waits.push(milliseconds);
	};
	const sourceBinding = createPostgresEngine({
		executor: source.executor,
		namespace: NAMESPACE,
		nativeWait,
	});
	const targetBinding = createPostgresEngine({
		executor: target.executor,
		namespace: options.targetNamespace ?? NAMESPACE,
		nativeWait,
		nativePollIntervalMs: 7,
		...(options.connection === null
			? undefined
			: { nativeSourceConnection: options.connection ?? (() => SECRET) }),
	});
	const sourcePort = sourceBinding.nativeTransfer;
	const targetPort = targetBinding.nativeTransfer;
	assert.ok(sourcePort && targetPort);
	return {
		source,
		target,
		sourceBinding,
		targetBinding,
		sourcePort,
		targetPort,
		waits,
	};
}

async function refusal<T>(action: () => Promise<T>): Promise<DataCoreError> {
	try {
		await action();
	} catch (cause) {
		assert.ok(cause instanceof DataCoreError, String(cause));
		return cause;
	}
	throw new Error("expected a refusal");
}

const statements = (database: Scripted): readonly string[] =>
	database.issued.map((entry) => entry.sql);

// ── declaration ─────────────────────────────────────────────────────────────

describe("logical-copy — declaration", () => {
	test("the binding declares exactly the native profile its port runs", () => {
		const { sourceBinding } = pair();
		assertBindingMatchesDeclaration(sourceBinding);
		assert.deepEqual(sourceBinding.declaration.nativeProfiles, [
			{ profile: LOGICAL_COPY_PROFILE, pattern: "snapshot-and-tail" },
		]);
		assert.deepEqual(sourceBinding.nativeTransfer?.profiles, [
			LOGICAL_COPY_PROFILE,
		]);
	});

	test("pg_dump stays a migration profile with argv builders, and is not offered as a native realization", () => {
		// Running pg_dump takes a process runner this package does not have.
		// A declared native profile is one the selector may pick and an
		// executor must then run, so it is not declared.
		assert.ok(POSTGRES_MIGRATION_PROFILES.includes(PG_DUMP_PROFILE));
		for (const capture of [true, false]) {
			assert.ok(
				postgresEngineDeclaration({ capture }).nativeProfiles.every(
					(entry) => entry.profile !== PG_DUMP_PROFILE,
				),
			);
		}
	});

	test("without logical decoding there is no fast path and no port", () => {
		const reduced = createPostgresEngine({
			executor: scripted("app", SOURCE).executor,
			namespace: NAMESPACE,
			capture: false,
		});
		assertBindingMatchesDeclaration(reduced);
		assert.equal(reduced.nativeTransfer, undefined);
		assert.deepEqual(reduced.declaration.nativeProfiles, []);
	});

	test("the limits of the native path are declared impedance", () => {
		for (const code of [
			"POSTGRES_NATIVE_COPY_WHOLE_DATASET_SAME_NAME",
			"POSTGRES_NATIVE_COPY_NO_REVERSE_TAIL",
			"POSTGRES_NATIVE_COPY_TARGET_HOLDS_SOURCE_CONNECTION",
			"POSTGRES_NATIVE_COPY_NEEDS_REPLICATION_CAPACITY",
			"POSTGRES_RETIRE_IS_LOGGED_AS_DELETES",
		] as const) {
			assert.ok(POSTGRES_IMPEDANCE_CODES.includes(code), code);
		}
	});

	test("a poll interval is parsed, not trusted", () => {
		for (const nativePollIntervalMs of [-1, 1.5, 60_001]) {
			assert.throws(
				() =>
					createPostgresEngine({
						executor: scripted("app", SOURCE).executor,
						nativePollIntervalMs,
					}),
				(cause) =>
					cause instanceof PostgresDataError &&
					cause.code === "ENGINE_OPTIONS_INVALID",
			);
		}
	});
});

// ── the statements, in order ────────────────────────────────────────────────

describe("logical-copy — the statements each side is sent", () => {
	test("the subscription statement creates no slot, quotes through the server, and hides its failure", () => {
		const statement = createSubscriptionStatement({
			subscription: SUBSCRIPTION,
			publication: OBJECTS.publication,
			slot: OBJECTS.slot,
		});
		// The slot exists already: a subscription creating its own would hang
		// when both databases share a cluster.
		assert.ok(statement.includes("create_slot = false"));
		assert.ok(statement.includes("copy_data = true"));
		assert.ok(statement.includes("slot_name = %L"));
		// The connection string is read from the setting and quoted by format.
		assert.ok(
			statement.includes("CONNECTION %L") &&
				statement.includes("current_setting('hobo.native_source')"),
		);
		// A failure is re-raised with its SQLSTATE and no statement context.
		assert.match(
			statement,
			/EXCEPTION WHEN OTHERS THEN\s+RAISE EXCEPTION '[^']+' USING ERRCODE = SQLSTATE;/u,
		);
		// Only names this package derives are ever placed in the text.
		for (const names of [
			{
				subscription: "x",
				publication: OBJECTS.publication,
				slot: OBJECTS.slot,
			},
			{
				subscription: SUBSCRIPTION,
				publication: "p'); DROP TABLE users; --",
				slot: OBJECTS.slot,
			},
			{
				subscription: SUBSCRIPTION,
				publication: OBJECTS.publication,
				slot: "hobo_s_short",
			},
		]) {
			assert.throws(
				() => createSubscriptionStatement(names),
				(cause) =>
					cause instanceof DataCoreError &&
					cause.code === "NATIVE_TRANSFER_REFUSED",
			);
		}
		// The statement that carries the secret answers a boolean, not the value.
		assert.ok(PRESENT_NATIVE_SOURCE.includes("IS NOT NULL)::text"));
		assert.ok(PRESENT_NATIVE_SOURCE.includes(", true)"), "transaction-local");
	});

	test("the pact names both sides and carries no credential", () => {
		assert.equal(PACT.consumer.name, "hobo-data-postgres-native-transfer");
		assert.equal(PACT.provider.name, "hobo-postgres-executor");
		assert.equal(PACT.interactions.length, 9);
		const text = JSON.stringify(PACT.interactions);
		assert.doesNotMatch(text, /postgres(ql)?:\/\//u);
		assert.doesNotMatch(text, /password|hunter2/iu);
		// The one parameter that is a credential is recorded as a marker.
		const secrets = PACT.interactions.flatMap((interaction) =>
			interaction.request.body.parameters
				.filter((parameter) => parameter.secret === true)
				.map(() => interaction.request.body.sql),
		);
		assert.deepEqual(secrets, [PRESENT_NATIVE_SOURCE]);
	});

	test("the binding issues every request in the pact, on the side the pact says, and reads every answer", async () => {
		const { source, target, sourcePort, targetPort, waits } = pair();

		// publish: the publication, then the slot, then the registry row.
		const ticket = await sourcePort.publish(REF);
		assert.deepEqual(ticket, {
			profile: LOGICAL_COPY_PROFILE,
			publication: OBJECTS.publication,
			slot: OBJECTS.slot,
			namespace: NAMESPACE,
			dataset: DATASET,
			tenant: "",
			origin: parsePostgresNativeTicket(ticket).origin,
		});
		const created = statements(source);
		const publication = created.findIndex((sql) =>
			sql.startsWith("CREATE PUBLICATION"),
		);
		const slot = created.findIndex((sql) =>
			sql.includes("pg_create_logical_replication_slot"),
		);
		const recorded = created.findIndex((sql) => sql.startsWith("INSERT INTO"));
		assert.ok(publication >= 0 && publication < slot && slot < recorded);
		assert.deepEqual(source.registry.get(KEY), {
			dataset: DATASET,
			slot_name: OBJECTS.slot,
			publication_name: OBJECTS.publication,
			start_position: "0/387C000",
		});
		// Publishing again answers the same ticket and creates nothing.
		const before = source.issued.length;
		assert.deepEqual(await sourcePort.publish(REF), ticket);
		assert.ok(
			statements(source)
				.slice(before)
				.every((sql) => !/^(CREATE|DROP|INSERT)/u.test(sql)),
		);

		// subscribe: one transaction — the setting, then the subscription.
		await targetPort.subscribe({ ...REF, ticket });
		const inTransaction = target.issued.filter((entry) => entry.inTransaction);
		assert.deepEqual(
			inTransaction.map((entry) => entry.sql),
			[
				PRESENT_NATIVE_SOURCE,
				createSubscriptionStatement({
					subscription: SUBSCRIPTION,
					publication: OBJECTS.publication,
					slot: OBJECTS.slot,
				}),
			],
		);
		// The target created no slot and no publication of its own.
		assert.ok(
			statements(target).every(
				(sql) =>
					!sql.includes("pg_create_logical_replication_slot") &&
					!sql.startsWith("CREATE PUBLICATION"),
			),
		);
		// Subscribing again finds the subscription and does nothing.
		const settled = target.issued.length;
		await targetPort.subscribe({ ...REF, ticket });
		assert.ok(
			target.issued.slice(settled).every((entry) => !entry.inTransaction),
		);

		// Progress: the target says the copy is done; the source says the
		// mark was reached. Neither waited, because both were ready.
		assert.equal(await targetPort.seeded(REF), true);
		const mark = await sourcePort.mark(REF);
		assert.equal(mark, "0/387C1A8");
		assert.equal(await sourcePort.reached({ ...REF, mark }), true);
		assert.deepEqual(waits, []);

		// stop: the target drops its subscription, the source its publication,
		// its slot and the registry row.
		await targetPort.stop(REF);
		await sourcePort.stop(REF);
		assert.deepEqual([...target.subscriptions], []);
		assert.deepEqual([...source.publications], []);
		assert.deepEqual([...source.slots.keys()], []);
		assert.deepEqual([...source.registry.keys()], []);

		// A refusal: the SQLSTATE alone comes back.
		const failing = pair();
		const again = await failing.sourcePort.publish(REF);
		failing.target.state = UNREACHABLE;
		await assert.rejects(
			async () => failing.targetPort.subscribe({ ...REF, ticket: again }),
			(cause) =>
				cause instanceof PostgresDataError &&
				cause.code === "NATIVE_SUBSCRIBE_FAILED" &&
				cause.detail.sqlState === "08006",
		);

		const exercised = new Set([
			...source.exercised,
			...target.exercised,
			...failing.target.exercised,
		]);
		assert.deepEqual(
			PACT.interactions
				.map((interaction) => interaction.description)
				.filter((description) => !exercised.has(description)),
			[],
			"every interaction in the pact was exercised",
		);
		// And each on the side the pact names.
		for (const interaction of PACT.interactions) {
			const side =
				interaction.providerState === SOURCE ? source.exercised : undefined;
			if (side !== undefined) assert.ok(side.has(interaction.description));
		}
	});
});

// ── the connection string ───────────────────────────────────────────────────

describe("logical-copy — the connection string is a secret", () => {
	test("it is sent once, as a bind parameter, and appears nowhere else", async () => {
		const { source, target, sourcePort, targetPort } = pair();
		const ticket = await sourcePort.publish(REF);
		await targetPort.subscribe({ ...REF, ticket });
		const carrying = [...source.issued, ...target.issued].filter((entry) =>
			JSON.stringify([entry.sql, entry.raw]).includes("hunter2"),
		);
		assert.deepEqual(
			carrying.map((entry) => [
				entry.sql,
				entry.raw.length,
				entry.inTransaction,
			]),
			[[PRESENT_NATIVE_SOURCE, 1, true]],
		);
		assert.ok(!JSON.stringify(ticket).includes("hunter2"));
		// The source side never sees it at all.
		assert.ok(!JSON.stringify(source.issued).includes("hunter2"));
	});

	test("it is resolved only when a subscription is created, and not for one that exists", async () => {
		let resolved = 0;
		const { sourcePort, targetPort, target } = pair({
			connection: () => {
				resolved += 1;
				return SECRET;
			},
		});
		const ticket = await sourcePort.publish(REF);
		assert.equal(resolved, 0);
		await targetPort.subscribe({ ...REF, ticket });
		assert.equal(resolved, 1);
		await targetPort.subscribe({ ...REF, ticket });
		await targetPort.seeded(REF);
		await targetPort.stop(REF);
		assert.equal(resolved, 1);
		assert.ok(target.issued.length > 0);
	});

	test("whatever the server or the driver says about a failure, none of it is kept", async () => {
		for (const state of ["08006", "42601", "42501", "XX000"]) {
			const { sourcePort, targetPort, target } = pair();
			const ticket = await sourcePort.publish(REF);
			// What a real driver throws: the server's text and its context,
			// which quotes the whole statement — connection string included.
			const thrown = Object.assign(
				new Error(`could not connect to the publisher: ${SECRET}`),
				{
					code: state,
					where: `SQL statement "CREATE SUBSCRIPTION s CONNECTION '${SECRET}'"`,
					detail: SECRET,
				},
			);
			target.failures.set("CREATE SUBSCRIPTION", [thrown]);
			let failure: unknown;
			try {
				await targetPort.subscribe({ ...REF, ticket });
			} catch (cause) {
				failure = cause;
			}
			assert.ok(failure instanceof PostgresDataError, state);
			assert.equal(failure.code, "NATIVE_SUBSCRIBE_FAILED");
			assert.deepEqual(failure.detail, { sqlState: state, transfer: TRANSFER });
			assert.equal(failure.cause, undefined);
			const shown = [
				failure.message,
				failure.stack ?? "",
				JSON.stringify(failure),
				JSON.stringify(failure.detail),
				String(failure),
			].join("\n");
			assert.ok(!shown.includes("hunter2"), state);
			assert.ok(!shown.includes("source.internal"), state);
		}
	});

	test("a resolver that throws, or a failure with no SQLSTATE, is reported without its text", async () => {
		const throwing = pair({
			connection: () => {
				throw new Error(`secret store said: ${SECRET}`);
			},
		});
		const ticket = await throwing.sourcePort.publish(REF);
		await assert.rejects(
			async () => throwing.targetPort.subscribe({ ...REF, ticket }),
			(cause) => {
				assert.ok(cause instanceof PostgresDataError);
				assert.equal(cause.code, "NATIVE_SUBSCRIBE_FAILED");
				assert.equal(cause.detail.sqlState, "unknown");
				assert.equal(cause.cause, undefined);
				assert.ok(!String(cause.stack).includes("hunter2"));
				return true;
			},
		);
		// Nothing was sent to the server for it.
		assert.ok(throwing.target.issued.every((entry) => !entry.inTransaction));
	});

	test("a subscription another caller created first is not an error", async () => {
		const { sourcePort, targetPort, target } = pair();
		const ticket = await sourcePort.publish(REF);
		target.failures.set("CREATE SUBSCRIPTION", [sqlError("42710")]);
		await targetPort.subscribe({ ...REF, ticket });
	});

	test("a run through the executor journals no connection string and no fence token", async () => {
		const { runSnapshotAndTail } = await import("@hobo/data-core");
		const { source, target, sourceBinding, targetBinding } = pair();
		// The scripted target reports its copy as never finishing, so the run
		// holds after `prepare` — which is as far as a run can get without a
		// real server, and is where the ticket is journaled.
		const journal = createMemoryMigrationJournal();
		const result = await runSnapshotAndTail({
			runtime: {
				migrationId: "m1",
				journal,
				clock: () => "2026-11-10T00:00:00.000Z",
				policy: () =>
					evaluateCustodyPath({
						// One point per role: the run holds on a path that leaves out
						// a copy it creates.
						path: parseCustodyPath({
							points: CUSTODY_ROLES.map((role) => ({
								id: role,
								role,
								region: "eu-west-1",
								protections: [],
								...(role === "source" ||
								role === "target" ||
								role === "event-log"
									? undefined
									: { retainUntil: "2099-01-01T00:00:00.000Z" }),
							})),
						}),
						policy: { classification: "public" },
						now: "2026-11-10T00:00:00.000Z",
					}),
			},
			source: sourceBinding,
			target: targetBinding,
			schema: EVERY_TYPE_SCHEMA,
			scope: scopeOf(DATASET),
			maxTailRounds: 3,
			flipAuthority: () => {},
			realization: "native",
			profile: LOGICAL_COPY_PROFILE,
		});
		// The pact's "ready" answer is consumed by this run's first poll, so it
		// reaches converge, where the scripted source never confirms the mark.
		assert.equal(result.status, "held", result.reason);
		assert.equal(result.state.realization, "native");
		const journaled = JSON.stringify(await journal.load("m1"));
		assert.ok(!journaled.includes("hunter2"));
		assert.ok(!journaled.includes("source.internal"));
		assert.doesNotMatch(journaled, /postgres(ql)?:\/\//u);
		const ticket = Object(result.state.checkpoints.prepare?.ticket);
		assert.deepEqual(parsePostgresNativeTicket(ticket).slot, OBJECTS.slot);
		assert.ok(source.issued.length > 0 && target.issued.length > 0);
	});
});

// ── refusals ────────────────────────────────────────────────────────────────

describe("logical-copy — what it will not approximate", () => {
	const reasonOf = async <T>(action: () => Promise<T>): Promise<string> => {
		const refused = await refusal(action);
		assert.equal(refused.code, "NATIVE_TRANSFER_REFUSED");
		assert.equal(refused.detail.profile, LOGICAL_COPY_PROFILE);
		return String(refused.detail.reason);
	};

	test("one tenant of a pooled table is refused on both sides, before any statement", async () => {
		const { source, target, sourcePort, targetPort } = pair();
		const tenant = { ...REF, scope: scopeOf(DATASET, "tenant-a") };
		assert.equal(
			await reasonOf(async () => sourcePort.publish(tenant)),
			"TENANT_SCOPE",
		);
		assert.equal(
			await reasonOf(async () =>
				targetPort.subscribe({ ...tenant, ticket: {} }),
			),
			"TENANT_SCOPE",
		);
		assert.deepEqual(statements(source), []);
		assert.deepEqual(statements(target), []);
	});

	test("another profile, a foreign ticket, another namespace, a renamed dataset", async () => {
		const { sourcePort, targetPort } = pair();
		assert.equal(
			await reasonOf(async () =>
				sourcePort.publish({ ...REF, profile: PG_DUMP_PROFILE }),
			),
			"PROFILE_UNKNOWN",
		);
		const ticket = await sourcePort.publish(REF);
		const invalid: readonly JsonObject[] = [
			{},
			{ ...ticket, profile: PG_DUMP_PROFILE },
			{ ...ticket, slot: "pg_stolen_slot" },
			{ ...ticket, publication: "hobo_p_x" },
			{ ...ticket, origin: "not-a-digest" },
			{ ...ticket, tenant: "tenant-a" },
			{ ...ticket, namespace: 7 },
		];
		for (const candidate of invalid) {
			assert.equal(
				await reasonOf(async () =>
					targetPort.subscribe({ ...REF, ticket: candidate }),
				),
				"TICKET_INVALID",
				JSON.stringify(candidate),
			);
		}
		const elsewhere = pair({ targetNamespace: "another_namespace" });
		assert.equal(
			await reasonOf(async () =>
				elsewhere.targetPort.subscribe({ ...REF, ticket }),
			),
			"NAMESPACE_MISMATCH",
		);
		assert.equal(
			await reasonOf(async () =>
				targetPort.subscribe({
					...REF,
					scope: scopeOf("hobo_renamed_orders"),
					ticket,
				}),
			),
			"SCOPE_MISMATCH",
		);
	});

	test("the source database as its own target, a target with rows, a target with no way back", async () => {
		const same = pair({ targetDatabase: "app" });
		const ticket = await same.sourcePort.publish(REF);
		assert.equal(
			await reasonOf(async () => same.targetPort.subscribe({ ...REF, ticket })),
			"SAME_DATABASE",
		);

		const occupied = pair();
		occupied.target.tableRows = 3;
		assert.equal(
			await reasonOf(async () =>
				occupied.targetPort.subscribe({ ...REF, ticket }),
			),
			"TARGET_NOT_EMPTY",
		);

		const unreachable = pair({ connection: null });
		assert.equal(
			await reasonOf(async () =>
				unreachable.targetPort.subscribe({ ...REF, ticket }),
			),
			"SOURCE_CONNECTION_MISSING",
		);
		// None of the three reached CREATE SUBSCRIPTION.
		for (const refused of [same, occupied, unreachable]) {
			assert.ok(
				statements(refused.target).every(
					(sql) => !sql.includes("CREATE SUBSCRIPTION"),
				),
			);
		}
	});
});

// ── progress and loss ───────────────────────────────────────────────────────

describe("logical-copy — progress is asked, waited for, and never invented", () => {
	test("a copy still running, and a mark not yet reached, wait once and answer false", async () => {
		const { source, target, sourcePort, targetPort, waits } = pair();
		const ticket = await sourcePort.publish(REF);
		await targetPort.subscribe({ ...REF, ticket });
		// Past the pact's canned answers, the scripted databases say "not yet".
		target.state = "still copying";
		source.state = "still applying";
		assert.equal(await targetPort.seeded(REF), false);
		assert.deepEqual(waits, [7], "the target's poll interval");
		assert.equal(
			await sourcePort.reached({ ...REF, mark: "0/387C1A8" }),
			false,
		);
		assert.deepEqual(waits, [7, 50], "then the source's default");
		// A mark is a log position; anything else was not minted here.
		await assert.rejects(
			async () => sourcePort.reached({ ...REF, mark: "41" }),
			(cause) =>
				cause instanceof PostgresDataError &&
				cause.code === "CAPTURE_POSITION_INVALID",
		);
	});

	test("a transfer whose objects are gone is lost, loudly — never 'not yet' for ever", async () => {
		const { source, target, sourcePort, targetPort } = pair();
		const lostCode = async <T>(action: () => Promise<T>) =>
			(await refusal(action)).code;
		// Never started. (Past the pact's canned answers: the scripted
		// databases answer from what exists in them.)
		source.state = "nothing published";
		target.state = "nothing subscribed";
		assert.equal(
			await lostCode(async () => targetPort.seeded(REF)),
			"NATIVE_TRANSFER_LOST",
		);
		assert.equal(
			await lostCode(async () => sourcePort.mark(REF)),
			"NATIVE_TRANSFER_LOST",
		);
		assert.equal(
			await lostCode(async () => sourcePort.reached({ ...REF, mark: "0/1" })),
			"NATIVE_TRANSFER_LOST",
		);
		// Started, then the slot and the subscription vanish underneath it.
		const ticket = await sourcePort.publish(REF);
		await targetPort.subscribe({ ...REF, ticket });
		source.state = "the slot was dropped";
		target.state = "the subscription was dropped";
		source.slots.clear();
		target.subscriptions.clear();
		assert.equal(
			await lostCode(async () => sourcePort.reached({ ...REF, mark: "0/1" })),
			"NATIVE_TRANSFER_LOST",
		);
		assert.equal(
			await lostCode(async () => targetPort.seeded(REF)),
			"NATIVE_TRANSFER_LOST",
		);
	});
});

// ── cleanup ─────────────────────────────────────────────────────────────────

describe("logical-copy — nothing is left behind", () => {
	test("stopping is idempotent, and harmless for a transfer that never started", async () => {
		const { source, target, sourcePort, targetPort } = pair();
		await targetPort.stop(REF);
		await sourcePort.stop(REF);
		assert.ok(
			[...statements(source), ...statements(target)].every(
				(sql) => !sql.startsWith("DROP SUBSCRIPTION"),
			),
		);
		const ticket = await sourcePort.publish(REF);
		await targetPort.subscribe({ ...REF, ticket });
		for (let round = 0; round < 2; round += 1) {
			await targetPort.stop(REF);
			await sourcePort.stop(REF);
		}
		assert.deepEqual([...target.subscriptions], []);
		assert.deepEqual([...source.slots.keys()], []);
		assert.deepEqual([...source.publications], []);
	});

	test("when the source cannot be reached the subscription is detached and dropped locally", async () => {
		const { sourcePort, targetPort, target } = pair();
		const ticket = await sourcePort.publish(REF);
		await targetPort.subscribe({ ...REF, ticket });
		const before = target.issued.length;
		target.failures.set("DROP SUBSCRIPTION", [
			sqlError("08006", `could not connect to the publisher: ${SECRET}`),
		]);
		await targetPort.stop(REF);
		const quoted = `"${SUBSCRIPTION}"`;
		assert.deepEqual(
			statements(target)
				.slice(before)
				.filter((sql) => /^(?:DROP|ALTER) SUBSCRIPTION/u.test(sql)),
			[
				`DROP SUBSCRIPTION IF EXISTS ${quoted}`,
				`ALTER SUBSCRIPTION ${quoted} DISABLE`,
				`ALTER SUBSCRIPTION ${quoted} SET (slot_name = NONE)`,
				`DROP SUBSCRIPTION IF EXISTS ${quoted}`,
			],
		);
		assert.deepEqual([...target.subscriptions], []);
	});

	test("a subscription that cannot be dropped at all fails with a SQLSTATE and no text", async () => {
		const { sourcePort, targetPort, target } = pair();
		const ticket = await sourcePort.publish(REF);
		await targetPort.subscribe({ ...REF, ticket });
		target.failures.set("DROP SUBSCRIPTION", [
			sqlError("08006", SECRET),
			sqlError("55006", SECRET),
		]);
		await assert.rejects(
			async () => targetPort.stop(REF),
			(cause) => {
				assert.ok(cause instanceof PostgresDataError);
				assert.equal(cause.code, "NATIVE_STOP_FAILED");
				assert.deepEqual(cause.detail, { sqlState: "55006" });
				assert.equal(cause.cause, undefined);
				assert.ok(!String(cause.stack).includes("hunter2"));
				return true;
			},
		);
	});

	test("a slot whose sender is still attached is released, then dropped, waiting between attempts", async () => {
		const { source, sourcePort, waits } = pair();
		await sourcePort.publish(REF);
		const slot = source.slots.get(OBJECTS.slot);
		assert.ok(slot);
		slot.active = true;
		// The sender lets go only after the first attempt to drop the slot.
		source.failures.set("pg_drop_replication_slot", [sqlError("55006")]);
		await sourcePort.stop(REF);
		const issued = statements(source);
		const ended = issued.filter((sql) => sql.includes("pg_terminate_backend"));
		assert.equal(ended.length, 2, "asked before each attempt");
		assert.deepEqual(waits, [50]);
		assert.deepEqual([...source.slots.keys()], []);
		assert.deepEqual([...source.publications], []);
		assert.deepEqual([...source.registry.keys()], []);
		// Any other failure is not retried and is not swallowed.
		const other = pair();
		await other.sourcePort.publish(REF);
		const denied = sqlError("42501");
		other.source.failures.set("pg_drop_replication_slot", [denied]);
		await assert.rejects(
			async () => other.sourcePort.stop(REF),
			(cause) => cause === denied,
		);
	});

	test("an ephemeral binding drops every transfer its namespace holds when it closes", async () => {
		const source = scripted("app", SOURCE);
		const target = scripted("app_copy", TARGET);
		const sourceBinding = createPostgresEngine({
			executor: source.executor,
			namespace: NAMESPACE,
			ephemeral: true,
		});
		const targetBinding = createPostgresEngine({
			executor: target.executor,
			namespace: NAMESPACE,
			ephemeral: true,
			nativeSourceConnection: () => SECRET,
		});
		assert.ok(await sourceBinding.datasets.describeDataset(DATASET));
		const ticket = await sourceBinding.nativeTransfer?.publish(REF);
		assert.ok(ticket);
		await targetBinding.nativeTransfer?.subscribe({ ...REF, ticket });
		// A second transfer from the same namespace, published only.
		await sourceBinding.nativeTransfer?.publish({ ...REF, transfer: "other" });
		assert.equal(source.slots.size, 2);
		await targetBinding.close();
		await sourceBinding.close();
		assert.deepEqual([...target.subscriptions], []);
		assert.deepEqual([...source.slots.keys()], []);
		assert.deepEqual([...source.publications], []);
		assert.deepEqual([...source.registry.keys()], []);
	});
});

// ── the CUE constraints, against what the binding really produces ───────────

const CUE_SCHEMA = fileURLToPath(
	new URL("../data-models/postgres_engine.cue", import.meta.url),
);
const CUE_CACHED = fileURLToPath(
	new URL("../../../.tools/cue/v0.14.0/cue", import.meta.url),
);

function findCue(): string | undefined {
	if (existsSync(CUE_CACHED)) return CUE_CACHED;
	const probe = spawnSync("cue", ["version"], { encoding: "utf8" });
	return probe.status === 0 && probe.stdout.includes("0.14.0")
		? "cue"
		: undefined;
}

const cue = findCue();

// Needs the pinned `cue` binary; without it the cases are skipped, not passed.
describe.skipIf(cue === undefined)("logical-copy — CUE constraints", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "hobo-data-postgres-cue-"));
	let counter = 0;
	const vet = (definition: string, record: JsonObject): boolean => {
		counter += 1;
		const file = path.join(dir, `record-${counter}.json`);
		writeFileSync(file, JSON.stringify(record));
		const result = spawnSync(
			cue ?? "cue",
			["vet", "-d", definition, CUE_SCHEMA, file],
			{ encoding: "utf8" },
		);
		return result.status === 0;
	};

	test("every request in the pact is a well-formed executor request, and a credential never travels with its text", () => {
		try {
			for (const interaction of PACT.interactions) {
				assert.ok(
					vet("#PostgresExecutorRequest", {
						...interaction.request.body,
						parameters: interaction.request.body.parameters.map(
							(parameter) => ({ ...parameter }),
						),
					}),
					interaction.description,
				);
			}
			assert.ok(vet("#PostgresExecutorParameter", {}), "SQL NULL");
			assert.ok(vet("#PostgresExecutorParameter", { text: "x" }));
			assert.ok(vet("#PostgresExecutorParameter", { secret: true }));
			assert.ok(
				!vet("#PostgresExecutorParameter", { secret: true, text: "x" }),
				"a credential recorded with its text must be refused",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a ticket the binding issues is accepted; one naming anything else is refused", async () => {
		const scratch = mkdtempSync(path.join(tmpdir(), "hobo-data-postgres-cue-"));
		const check = (definition: string, record: JsonObject): boolean => {
			const file = path.join(
				scratch,
				`${definition.slice(1)}-${counter++}.json`,
			);
			writeFileSync(file, JSON.stringify(record));
			return (
				spawnSync(cue ?? "cue", ["vet", "-d", definition, CUE_SCHEMA, file], {
					encoding: "utf8",
				}).status === 0
			);
		};
		try {
			const { sourcePort } = pair();
			const ticket = await sourcePort.publish(REF);
			assert.ok(check("#PostgresNativeTicket", ticket));
			assert.ok(
				!check("#PostgresNativeTicket", { ...ticket, tenant: "tenant-a" }),
			);
			assert.ok(
				!check("#PostgresNativeTicket", { ...ticket, slot: "pg_other_slot" }),
			);
			assert.ok(
				!check("#PostgresNativeTicket", {
					...ticket,
					connection: "postgres://user:pw@host/db",
				}),
				"a ticket has no field a connection string could ride in",
			);
			// The options record, with and without the fields a guard reads.
			assert.ok(check("#PostgresEngineOptions", { namespace: "app" }));
			assert.ok(
				check("#PostgresEngineOptions", {
					namespace: "t1",
					ephemeral: true,
					nativePollIntervalMs: 20,
				}),
			);
			assert.ok(!check("#PostgresEngineOptions", { ephemeral: true }));
			assert.ok(
				!check("#PostgresEngineOptions", {
					namespace: "public",
					ephemeral: true,
				}),
			);
			assert.ok(
				!check("#PostgresEngineOptions", { nativePollIntervalMs: 60_001 }),
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
