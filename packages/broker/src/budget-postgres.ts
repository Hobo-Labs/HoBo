import { createHash } from "node:crypto";
import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import type { Pool, PoolClient } from "pg";
import {
	type BudgetAdmissionAuthority,
	type BudgetAuthorityEvent,
	BudgetAuthorityEventSchema,
	type BudgetLedgerSnapshot,
	BudgetLedgerSnapshotSchema,
	createBudgetAdmissionAuthority,
} from "./budget-authority.js";

type Authority = ReturnType<typeof createBudgetAdmissionAuthority>;
/** Asynchronous view of the SAME financial authority used by local hosting and CI. */
export type AsyncBudgetAdmissionAuthority = {
	readonly persistence: BudgetAdmissionAuthority["persistence"];
} & {
	[K in Exclude<keyof BudgetAdmissionAuthority, "persistence">]: (
		...args: Parameters<BudgetAdmissionAuthority[K]>
	) => Promise<ReturnType<BudgetAdmissionAuthority[K]>>;
};

/** Shared distributed authority. Every client of a budget must use this database;
 * a local SQLite file on each host would create independent balances.
 * PostgreSQL holds one budget row lock while the existing pure journal evaluates
 * a command and commits its events. No provider/network operation runs in that transaction. */
export function createPostgresBudgetAdmissionAuthority(options: {
	pool: Pool;
	snapshot: BudgetLedgerSnapshot;
	now?: () => string;
	/** Bound pool starvation, including a CI transaction holding the same pool. */
	connectionTimeoutMs?: number;
	lockTimeoutMs?: number;
	statementTimeoutMs?: number;
}): AsyncBudgetAdmissionAuthority & {
	initialize(): Promise<void>;
	configure(...args: Parameters<Authority["configure"]>): Promise<void>;
} {
	const owner = options.snapshot.identity;
	if (!owner?.tenantId || !owner.budgetId)
		throw new Error("complete shared budget ownership required");
	const partition = createHash("sha256")
		.update(JSON.stringify([owner.tenantId, owner.budgetId]))
		.digest("hex");
	const now = options.now ?? (() => new Date().toISOString());
	function timeout(value: number): number {
		if (!Number.isSafeInteger(value) || value < 1 || value > 60000)
			throw new Error("budget database timeouts must be within 1..60000 ms");
		return value;
	}
	const connectionTimeoutMs = timeout(options.connectionTimeoutMs ?? 5000);
	const lockTimeoutMs = timeout(options.lockTimeoutMs ?? 5000);
	const statementTimeoutMs = timeout(options.statementTimeoutMs ?? 15000);
	async function acquire(): Promise<PoolClient> {
		let expired = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const pending = options.pool.connect().then((client) => {
			// A timed-out caller may no longer execute SQL. Return a late client immediately.
			if (expired) client.release();
			return client;
		});
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				expired = true;
				reject(new Error("budget database connection acquisition timed out"));
			}, connectionTimeoutMs);
		});
		try {
			return await Promise.race([pending, deadline]);
		} finally {
			clearTimeout(timer);
		}
	}
	async function begin(client: PoolClient): Promise<void> {
		await client.query("BEGIN");
		await client.query(
			"SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
			[`${lockTimeoutMs}ms`, `${statementTimeoutMs}ms`],
		);
	}
	let initializing: Promise<void> | undefined;
	async function initializeOnce(): Promise<void> {
		const client = await acquire();
		try {
			await begin(client);
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtext('hobo-budget-authority-schema-v1'))",
			);
			await client.query(
				"CREATE TABLE IF NOT EXISTS hobo_budget_partitions (id text PRIMARY KEY, base_body text NOT NULL)",
			);
			await client.query(
				"CREATE TABLE IF NOT EXISTS hobo_budget_events (partition_id text NOT NULL REFERENCES hobo_budget_partitions(id), seq bigint NOT NULL, body text NOT NULL, PRIMARY KEY (partition_id, seq))",
			);
			await client.query(
				"INSERT INTO hobo_budget_partitions(id,base_body) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",
				[partition, toJsonString(BudgetLedgerSnapshotSchema, options.snapshot)],
			);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}
	async function initialize(): Promise<void> {
		initializing ??= initializeOnce();
		try {
			await initializing;
		} catch (error) {
			initializing = undefined;
			throw error;
		}
	}
	async function transaction<T>(
		operation: (authority: Authority) => T,
	): Promise<T> {
		await initialize();
		const client = await acquire();
		try {
			await begin(client);
			const baseRows = await client.query<{ base_body: string }>(
				"SELECT base_body FROM hobo_budget_partitions WHERE id=$1 FOR UPDATE",
				[partition],
			);
			const baseRow = baseRows.rows[0];
			if (!baseRow) throw new Error("shared budget partition missing");
			const base = fromJsonString(
				BudgetLedgerSnapshotSchema,
				baseRow.base_body,
			);
			if (
				base.identity?.tenantId !== owner?.tenantId ||
				base.identity?.budgetId !== owner?.budgetId
			)
				throw new Error("database belongs to another budget");
			const rows = await client.query<{ body: string }>(
				"SELECT body FROM hobo_budget_events WHERE partition_id=$1 ORDER BY seq",
				[partition],
			);
			const priorEvents = rows.rows.map((row) =>
				fromJsonString(BudgetAuthorityEventSchema, row.body),
			);
			let seq = priorEvents.at(-1)?.snapshot?.seq ?? base.seq;
			const pending: BudgetAuthorityEvent[] = [];
			const authority = createBudgetAdmissionAuthority({
				snapshot: base,
				priorEvents,
				commit(event, expectedSeq) {
					if (seq !== expectedSeq || event.snapshot?.seq !== expectedSeq + 1)
						throw new Error("budget sequence conflict");
					seq = event.snapshot.seq;
					pending.push(event);
				},
			});
			const result = operation(authority);
			for (const event of pending)
				await client.query(
					"INSERT INTO hobo_budget_events(partition_id,seq,body) VALUES($1,$2,$3)",
					[
						partition,
						event.snapshot?.seq,
						toJsonString(BudgetAuthorityEventSchema, event),
					],
				);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			// A failed COMMIT response is uncertain. Never issue a compensating release.
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}
	return {
		persistence: "durable-cas",
		initialize,
		read(_at) {
			return transaction((authority) => authority.read(now()));
		},
		lookup(id) {
			return transaction((authority) => authority.lookup(id));
		},
		claimExecution(input) {
			return transaction((authority) => {
				authority.read(now());
				return authority.claimExecution(input);
			});
		},
		reserve(input) {
			return transaction((authority) =>
				authority.reserve({ ...input, now: now() }),
			);
		},
		settle(id, actualMicros, evidence) {
			return transaction((authority) =>
				authority.settle(id, actualMicros, evidence),
			);
		},
		uncertain(id) {
			return transaction((authority) => authority.uncertain(id));
		},
		release(id, confirmedUnused, evidenceRef) {
			return transaction((authority) =>
				authority.release(id, confirmedUnused, evidenceRef),
			);
		},
		configure(snapshot, expectedSeq, _at, evidence) {
			return transaction((authority) =>
				authority.configure(snapshot, expectedSeq, now(), evidence),
			);
		},
	};
}
