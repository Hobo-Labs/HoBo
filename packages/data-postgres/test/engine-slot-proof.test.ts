// A replication slot is proven to decode before its position is handed to
// anyone — without a server. A scripted executor plays PostgreSQL: it reports
// transactions still open, and it fails the decoding probe the way a real
// server does for a slot that was created at a bad moment.
//
// The live reproduction of that failure is in `engine-hardening-live.test.ts`;
// this file pins what the binding does about it, statement by statement.
import assert from "node:assert/strict";
import {
	CapturePositionError,
	DataCoreError,
	deleteMutation,
	schemaToJson,
	scopeOf,
} from "@hobo/data-core";
import { describe, test } from "vitest";
import { BOOTSTRAP_MARKER } from "../src/engine/statements.js";
import {
	createPostgresEngine,
	isUndecodableSlotError,
	PostgresDataError,
	type PostgresEngine,
	type PostgresParameter,
	type PostgresQueryResult,
	type PostgresRow,
	SLOT_HORIZON,
	SLOT_PROBE,
	SLOT_SETTLED,
} from "../src/index.js";
import { EVERY_TYPE_SCHEMA } from "./engine-support.js";

const NAMESPACE = "hobo_slot_proof";
const DATASET = EVERY_TYPE_SCHEMA.name;
const SCOPE = scopeOf(DATASET);

/** What the server raises when a slot cannot map a change to a table. */
function unmapped(): Error {
	return Object.assign(
		new Error('could not map filenumber "base/5/311262" to relation OID'),
		{ code: "XX000" },
	);
}

interface Script {
	/** Answers to "have the open transactions ended": one per poll, then true. */
	settled: boolean[];
	/** What each decoding probe does, in order; then it succeeds. */
	probes: (Error | "ok")[];
	/** The registry row for the subscription, when it already exists. */
	subscription?: PostgresRow;
	/** What a read's decoding call raises. */
	peek?: Error;
	/** The end of the log, for an acknowledgement to be compared with. */
	head?: string;
}

interface Scripted {
	readonly engine: PostgresEngine;
	readonly statements: string[];
	readonly waits: number[];
	/** Statements of the slot proof and what surrounds it, by short name. */
	steps(): string[];
}

function scripted(script: Script): Scripted {
	const statements: string[] = [];
	const waits: number[] = [];
	let created = 0;
	const rows = (...entries: PostgresRow[]): PostgresQueryResult => ({
		rows: entries,
		rowCount: entries.length,
	});
	const answer = async (
		sql: string,
		_parameters: readonly PostgresParameter[],
	): Promise<PostgresQueryResult> => {
		statements.push(sql);
		if (sql.includes("obj_description")) {
			return rows({ database: "app", marker: BOOTSTRAP_MARKER });
		}
		if (sql.includes(`FROM "${NAMESPACE}"."hobo_data_datasets"`)) {
			return rows({
				schema_json: JSON.stringify(schemaToJson(EVERY_TYPE_SCHEMA)),
			});
		}
		if (sql.includes(`FROM "${NAMESPACE}"."hobo_data_subscriptions"`)) {
			return script.subscription === undefined
				? rows()
				: rows(script.subscription);
		}
		if (sql.includes("pg_create_logical_replication_slot")) {
			created += 1;
			return rows({ lsn: `0/${created}000` });
		}
		if (sql === SLOT_HORIZON) return rows({ horizon: "741" });
		if (sql === SLOT_SETTLED) {
			return rows({ settled: String(script.settled.shift() ?? true) });
		}
		if (sql === SLOT_PROBE) {
			const outcome = script.probes.shift() ?? "ok";
			if (outcome !== "ok") throw outcome;
			return rows({ decoded: "0" });
		}
		if (sql.includes("confirmed_flush_lsn::text AS confirmed")) {
			return rows({ confirmed: "0/0", flushed: "0/9000", inserted: "0/9000" });
		}
		if (sql.includes("pg_logical_slot_peek_binary_changes")) {
			if (script.peek !== undefined) throw script.peek;
			return rows();
		}
		if (sql.includes("AS ahead")) {
			return rows({ ahead: String(script.head === "behind") });
		}
		return rows();
	};
	const executor = {
		query: (sql: string, parameters: readonly PostgresParameter[] = []) =>
			answer(sql, parameters),
		transaction: <T>(body: (tx: typeof executor) => Promise<T>): Promise<T> =>
			body(executor),
	};
	const engine = createPostgresEngine({
		executor,
		namespace: NAMESPACE,
		nativePollIntervalMs: 7,
		nativeWait: async (milliseconds) => {
			waits.push(milliseconds);
		},
	});
	const named = (sql: string): string | undefined => {
		if (sql.includes("pg_create_logical_replication_slot")) return "create";
		if (sql.includes("pg_drop_replication_slot")) return "drop-slot";
		if (sql.startsWith("DROP PUBLICATION")) return "drop-publication";
		if (sql.startsWith("CREATE PUBLICATION")) return "publish";
		if (sql === SLOT_HORIZON) return "horizon";
		if (sql === SLOT_SETTLED) return "settled?";
		if (sql === SLOT_PROBE) return "probe";
		if (sql.startsWith(`INSERT INTO "${NAMESPACE}"."hobo_data_subscriptions"`))
			return "record";
		if (sql.includes("pg_replication_slot_advance")) return "advance";
		return undefined;
	};
	return {
		engine,
		statements,
		waits,
		steps: () =>
			statements.flatMap((sql) => {
				const name = named(sql);
				return name === undefined ? [] : [name];
			}),
	};
}

function captureOf(engine: PostgresEngine) {
	const capture = engine.capture;
	if (capture === undefined) throw new Error("capture port missing");
	return capture;
}

describe("a replication slot is proven before its position is handed out", () => {
	test("only the server's unmapped-relation failure counts as a slot created at a bad moment", () => {
		assert.equal(isUndecodableSlotError(unmapped()), true);
		// PostgreSQL 15 and earlier word it with "filenode".
		assert.equal(
			isUndecodableSlotError(
				Object.assign(
					new Error('could not map filenode "base/5/1" to relation OID'),
					{
						code: "XX000",
					},
				),
			),
			true,
		);
		// The same SQLSTATE with any other text is an internal error like any
		// other, and so is the same text without the SQLSTATE.
		assert.equal(
			isUndecodableSlotError(
				Object.assign(new Error("unexpected chunk number"), { code: "XX000" }),
			),
			false,
		);
		assert.equal(
			isUndecodableSlotError(
				Object.assign(new Error("could not map filenumber"), { code: "55006" }),
			),
			false,
		);
		assert.equal(
			isUndecodableSlotError(new Error("could not map filenumber")),
			false,
		);
	});

	test("a clean start: create, wait for open transactions, decode once, then record", async () => {
		const server = scripted({ settled: [], probes: [] });
		const position = await captureOf(server.engine).start({
			scope: SCOPE,
			subscription: "tail",
		});
		assert.equal(position, "0/1000");
		assert.deepEqual(server.steps(), [
			// Leftovers of a start that died before it recorded itself.
			"drop-slot",
			"drop-publication",
			"publish",
			"create",
			"horizon",
			"settled?",
			"probe",
			"record",
		]);
		assert.deepEqual(server.waits, []);
	});

	test("transactions open when the slot became consistent are waited for, at the poll interval", async () => {
		const server = scripted({ settled: [false, false, false], probes: [] });
		await captureOf(server.engine).start({
			scope: SCOPE,
			subscription: "tail",
		});
		assert.deepEqual(server.waits, [7, 7, 7]);
		// The probe comes only after they have ended: until a transaction has
		// committed, a decoding pass cannot meet it.
		const steps = server.steps();
		assert.ok(steps.lastIndexOf("settled?") < steps.indexOf("probe"));
		assert.equal(steps.filter((step) => step === "settled?").length, 4);
	});

	test("a slot that cannot decode is dropped and created again, and the new slot's position is the one answered", async () => {
		const server = scripted({ settled: [], probes: [unmapped()] });
		const position = await captureOf(server.engine).start({
			scope: SCOPE,
			subscription: "tail",
		});
		assert.equal(position, "0/2000", "the second slot's position");
		assert.deepEqual(server.steps().slice(2), [
			"publish",
			"create",
			"horizon",
			"settled?",
			"probe",
			"drop-slot",
			"create",
			"horizon",
			"settled?",
			"probe",
			"record",
		]);
	});

	test("any other failure of the probe is thrown as it came, once: nothing is retried", async () => {
		for (const failure of [
			Object.assign(new Error("replication slot is active for PID 41"), {
				code: "55006",
			}),
			Object.assign(new Error("unexpected chunk number"), { code: "XX000" }),
		]) {
			const server = scripted({ settled: [], probes: [failure] });
			await assert.rejects(
				async () => {
					await captureOf(server.engine).start({
						scope: SCOPE,
						subscription: "tail",
					});
				},
				(cause) => cause === failure,
			);
			const steps = server.steps();
			assert.equal(steps.filter((step) => step === "create").length, 1);
			assert.ok(!steps.includes("record"), "nothing was recorded");
			// The slot and the publication nobody recorded are dropped.
			assert.deepEqual(steps.slice(-2), ["drop-slot", "drop-publication"]);
		}
	});

	test("five poisoned slots in a row is an error that names the cause, and leaves nothing behind", async () => {
		const server = scripted({
			settled: [],
			probes: [unmapped(), unmapped(), unmapped(), unmapped(), unmapped()],
		});
		await assert.rejects(
			async () => {
				await captureOf(server.engine).start({
					scope: SCOPE,
					subscription: "tail",
				});
			},
			(cause) =>
				cause instanceof PostgresDataError &&
				cause.code === "CAPTURE_SLOT_UNPROVEN" &&
				cause.detail.reason === "UNDECODABLE" &&
				cause.detail.subscription === "tail",
		);
		const steps = server.steps();
		assert.equal(steps.filter((step) => step === "create").length, 5);
		assert.ok(!steps.includes("record"));
		assert.deepEqual(steps.slice(-2), ["drop-slot", "drop-publication"]);
	});

	test("transactions that never end leave the slot unproven: the start is refused and the slot dropped", async () => {
		const server = scripted({
			settled: Array.from({ length: 1000 }, () => false),
			probes: [],
		});
		await assert.rejects(
			async () => {
				await captureOf(server.engine).start({
					scope: SCOPE,
					subscription: "tail",
				});
			},
			(cause) =>
				cause instanceof PostgresDataError &&
				cause.code === "CAPTURE_SLOT_UNPROVEN" &&
				cause.detail.reason === "TRANSACTIONS_STILL_OPEN",
		);
		assert.equal(server.waits.length, 600, "a bounded wait");
		const steps = server.steps();
		assert.ok(!steps.includes("probe") && !steps.includes("record"));
		assert.deepEqual(steps.slice(-2), ["drop-slot", "drop-publication"]);
	});

	test("an existing subscription is answered from the registry: no slot is created or probed again", async () => {
		const server = scripted({
			settled: [],
			probes: [],
			subscription: {
				dataset: DATASET,
				tenant: "",
				slot_name: "hobo_s_recorded",
				publication_name: "hobo_p_recorded",
				start_position: "0/77",
			},
		});
		assert.equal(
			await captureOf(server.engine).start({
				scope: SCOPE,
				subscription: "tail",
			}),
			"0/77",
		);
		assert.deepEqual(server.steps(), []);
	});
});

describe("what the strengthened conformance kit found", () => {
	const recorded: PostgresRow = {
		dataset: DATASET,
		tenant: "tenant-a",
		slot_name: "hobo_s_recorded",
		publication_name: "hobo_p_recorded",
		start_position: "0/77",
	};

	test("a subscription name is one reader of one scope: another tenant or dataset is refused", async () => {
		const server = scripted({
			settled: [],
			probes: [],
			subscription: recorded,
		});
		const capture = captureOf(server.engine);
		assert.equal(
			await capture.start({
				scope: scopeOf(DATASET, "tenant-a"),
				subscription: "tail",
			}),
			"0/77",
		);
		for (const other of [scopeOf(DATASET, "tenant-b"), scopeOf(DATASET)]) {
			await assert.rejects(
				async () => {
					await capture.start({ scope: other, subscription: "tail" });
				},
				(cause) =>
					cause instanceof DataCoreError &&
					cause.code === "CAPTURE_SUBSCRIPTION_CONFLICT",
			);
		}
		assert.deepEqual(server.steps(), [], "and nothing was created for it");
	});

	test("a position past the end of the log is not an acknowledgement: the slot is not advanced", async () => {
		const server = scripted({
			settled: [],
			probes: [],
			subscription: recorded,
			head: "behind",
		});
		await assert.rejects(
			async () => {
				await captureOf(server.engine).acknowledge({
					subscription: "tail",
					position: "1/0",
				});
			},
			(cause) =>
				cause instanceof CapturePositionError &&
				cause.code === "CAPTURE_POSITION_INVALID" &&
				cause.subscription === "tail",
		);
		assert.ok(!server.steps().includes("advance"));
		// At or before the end of the log, it advances as before.
		const level = scripted({ settled: [], probes: [], subscription: recorded });
		await captureOf(level.engine).acknowledge({
			subscription: "tail",
			position: "0/80",
		});
		assert.deepEqual(level.steps(), ["advance"]);
	});

	test("a slot that stops decoding under a reader is named, not passed off as an outage", async () => {
		const server = scripted({
			settled: [],
			probes: [],
			subscription: { ...recorded, tenant: "" },
			peek: unmapped(),
		});
		await assert.rejects(
			async () => {
				await captureOf(server.engine).read({
					scope: SCOPE,
					subscription: "tail",
					after: "0/77",
					limit: 10,
				});
			},
			(cause) =>
				cause instanceof PostgresDataError &&
				cause.code === "CAPTURE_STREAM_UNDECODABLE" &&
				cause.detail.sqlState === "XX000",
		);
	});

	test("a delete naming a key in a non-canonical spelling is refused before any statement is sent", async () => {
		const server = scripted({ settled: [], probes: [] });
		// The same key, spelled with spaces: read leniently it would delete
		// here and delete nothing in an engine that compares keys as text.
		for (const key of ['[ "order-1" ]', '["order-1"] ']) {
			await assert.rejects(
				async () => {
					await server.engine.records.write({
						dataset: DATASET,
						mutations: [deleteMutation("", key)],
					});
				},
				(cause) =>
					cause instanceof DataCoreError && cause.code === "INVALID_RECORD",
			);
		}
		assert.ok(
			server.statements.every((sql) => !sql.startsWith("DELETE FROM")),
			"no delete reached the server",
		);
		await server.engine.records.write({
			dataset: DATASET,
			mutations: [deleteMutation("", '["order-1"]')],
		});
		assert.ok(server.statements.some((sql) => sql.startsWith("DELETE FROM")));
	});
});
