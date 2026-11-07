import { DatabaseSync } from "node:sqlite";
import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
	type BudgetAdmissionAuthority,
	BudgetAuthorityEventSchema,
	type BudgetLedgerSnapshot,
	BudgetLedgerSnapshotSchema,
	createBudgetAdmissionAuthority,
} from "./budget-authority.js";
import { isJsonNumber, isJsonString } from "./json.js";

/** Local durable authority: one shared SQLite file, synchronous transactions,
 * atomic journal/head CAS. Multiple local processes/connections may admit;
 * distributed hosts need a transactional adapter to their shared database. */
export function createSqliteBudgetAdmissionAuthority(options: {
	path: string;
	snapshot: BudgetLedgerSnapshot;
	/** Trusted server clock; caller-supplied command timestamps cannot revive evidence. */
	now?: () => string;
}): BudgetAdmissionAuthority & {
	configure(
		snapshot: BudgetLedgerSnapshot,
		expectedSeq: number,
		now: string,
		evidence?: { liabilityResolutionEvidenceRef?: string },
	): void;
	close(): void;
} {
	if (options.path === ":memory:")
		throw new TypeError(
			"durable budget authority requires a persistent SQLite path",
		);
	const database = new DatabaseSync(options.path);
	const now = options.now ?? (() => new Date().toISOString());
	database.exec(
		"PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS budget_base(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS budget_events(seq INTEGER PRIMARY KEY, body TEXT NOT NULL)",
	);
	database
		.prepare("INSERT OR IGNORE INTO budget_base(id,body) VALUES(1,?)")
		.run(toJsonString(BudgetLedgerSnapshotSchema, options.snapshot));
	function authority() {
		const row = database
			.prepare("SELECT body FROM budget_base WHERE id=1")
			.get();
		if (!isJsonString(row?.body))
			throw new Error("budget authority base missing");
		const base = fromJsonString(BudgetLedgerSnapshotSchema, row.body);
		if (
			!base.identity ||
			!options.snapshot.identity ||
			base.identity.tenantId !== options.snapshot.identity.tenantId ||
			base.identity.budgetId !== options.snapshot.identity.budgetId
		)
			throw new Error("database belongs to another budget");
		const priorEvents = database
			.prepare("SELECT body FROM budget_events ORDER BY seq")
			.all()
			.map((event) => {
				if (!isJsonString(event.body))
					throw new Error("invalid budget journal row");
				return fromJsonString(BudgetAuthorityEventSchema, event.body);
			});
		return createBudgetAdmissionAuthority({
			snapshot: base,
			priorEvents,
			commit(event, expectedSeq) {
				const head = database
					.prepare("SELECT MAX(seq) AS seq FROM budget_events")
					.get();
				const actualSeq = isJsonNumber(head?.seq) ? head.seq : base.seq;
				if (
					actualSeq !== expectedSeq ||
					!event.snapshot ||
					event.snapshot.seq !== expectedSeq + 1
				)
					throw new Error("budget sequence conflict");
				database
					.prepare("INSERT INTO budget_events(seq,body) VALUES(?,?)")
					.run(
						event.snapshot.seq,
						toJsonString(BudgetAuthorityEventSchema, event),
					);
			},
		});
	}
	function transaction<T>(
		operation: (port: ReturnType<typeof createBudgetAdmissionAuthority>) => T,
	): T {
		database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation(authority());
			database.exec("COMMIT");
			return result;
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
	}
	return {
		persistence: "durable-cas",
		read(_at) {
			return transaction((port) => port.read(now()));
		},
		lookup(id) {
			return transaction((port) => port.lookup(id));
		},
		claimExecution(input) {
			return transaction((port) => {
				port.read(now());
				return port.claimExecution(input);
			});
		},
		reserve(input) {
			return transaction((port) => port.reserve({ ...input, now: now() }));
		},
		settle(id, actualMicros, evidence) {
			return transaction((port) => port.settle(id, actualMicros, evidence));
		},
		uncertain(id) {
			return transaction((port) => port.uncertain(id));
		},
		release(id, confirmedUnused, evidenceRef) {
			return transaction((port) =>
				port.release(id, confirmedUnused, evidenceRef),
			);
		},
		configure(snapshot, expectedSeq, _at, evidence) {
			transaction((port) =>
				port.configure(snapshot, expectedSeq, now(), evidence),
			);
		},
		close() {
			database.close();
		},
	};
}
