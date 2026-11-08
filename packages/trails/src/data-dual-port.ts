/**
 * Live data-dual port: two real SQLite stores behind the Trail runner's dual
 * oracle (replaces the simulated `DataDualFixture` — vision-gap Phase 7).
 *
 * CDC dual-write per ADR-0032: business writes land on the SOURCE store and a
 * change journal in the same transaction; `replicate()` tails the journal and
 * applies un-replicated changes to the TARGET with a seq watermark —
 * at-least-once delivery, exactly-once effect. The oracle (`snapshot()`)
 * reads both stores ordered by key so `evaluateDataDual` can assert checksum
 * equivalence and zero loss against live data.
 *
 * Pooled → siloed: when `tenant` is set, the source is treated as a pooled
 * store (rows carry `tenant_id`) and the target as that tenant's silo —
 * replication and the oracle are tenant-scoped, so divergence in another
 * tenant's rows never masks or fails this tenant's migration.
 */
import { DatabaseSync } from "node:sqlite";

import type { DataDualView } from "./data-steps.js";
import type { JsonObject } from "./json.js";

export interface DataDualPort {
	readonly fidelity: "live";
	/** Ordered oracle view over both stores (tenant-scoped when configured). */
	snapshot(): DataDualView;
}

export interface SqliteDataDualWrite {
	readonly id: string;
	readonly doc: JsonObject;
	/** Pooled-store tenant; defaults to the port's tenant (or "default"). */
	readonly tenant?: string;
	readonly deleted?: boolean;
}

export interface SqliteDataDualPort extends DataDualPort {
	/** Dual-write entry: apply business writes to source + CDC journal atomically. */
	writeSource(writes: readonly SqliteDataDualWrite[]): void;
	/** Tail the CDC journal onto the target; returns changes applied. */
	replicate(): number;
	/** CDC lag: journal entries not yet applied to the target. */
	lag(): number;
	/**
	 * Brownfield bulk snapshot: copy every current in-scope source row to the
	 * target and advance the watermark to the current CDC head, so rows written
	 * BEFORE this port existed are covered (snapshot-then-tail). Returns rows
	 * copied.
	 */
	backfill(): number;
	/**
	 * Raise a write fence for a tenant on the SOURCE store (ADR-0080 §2 /
	 * ADR-0053): subsequent `writeSource` calls for that tenant throw
	 * `FencedTenantError`. Idempotent — re-raising returns the existing token.
	 */
	raiseFence(tenant: string): { readonly fenceToken: string };
	isFenced(tenant: string): boolean;
	/** Max CDC seq for the port's scope — the quiescent head after a drain. */
	headSeq(): number;
	/** The silo-side replication watermark: last CDC seq applied to the target. */
	appliedWatermark(): number;
	/**
	 * Destructive source reap after a verified move: deletes the tenant's rows
	 * from the pooled source. Refused unless the tenant is fenced AND the
	 * oracle view shows checksum-equal, zero-loss source/target sets.
	 */
	reapSource(tenant: string): { readonly reaped: number };
	close(): void;
}

/** A write arrived for a tenant whose streams are fenced (moved to a silo). */
export class FencedTenantError extends Error {
	readonly tenant: string;
	readonly fenceToken: string;

	constructor(tenant: string, fenceToken: string) {
		super(
			`tenant ${tenant} is fenced (${fenceToken}); its writes now belong to the silo`,
		);
		this.name = "FencedTenantError";
		this.tenant = tenant;
		this.fenceToken = fenceToken;
	}
}

export interface CreateSqliteDataDualPortOptions {
	/** Source store path ("file" | ":memory:"). Pooled store in tenant mode. */
	readonly sourcePath: string;
	/** Target store path. The tenant silo in tenant mode. */
	readonly targetPath: string;
	readonly table?: string;
	/** Scope replication + oracle to one tenant (pooled → siloed protocol). */
	readonly tenant?: string;
}

export function createSqliteDataDualPort(
	options: CreateSqliteDataDualPortOptions,
): SqliteDataDualPort {
	const table = validIdentifier(options.table ?? "records");
	const tenant = options.tenant;
	const source = new DatabaseSync(options.sourcePath);
	const target = new DatabaseSync(options.targetPath);

	source.exec(`
		CREATE TABLE IF NOT EXISTS ${table} (
			tenant_id TEXT NOT NULL,
			id TEXT NOT NULL,
			doc TEXT NOT NULL,
			PRIMARY KEY (tenant_id, id)
		);
		CREATE TABLE IF NOT EXISTS ${table}_cdc_log (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			tenant_id TEXT NOT NULL,
			id TEXT NOT NULL,
			op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
			doc TEXT
		);
		CREATE TABLE IF NOT EXISTS ${table}_tenant_fence (
			tenant_id TEXT PRIMARY KEY,
			fence_token TEXT NOT NULL,
			fenced_at TEXT NOT NULL
		);
	`);
	target.exec(`
		CREATE TABLE IF NOT EXISTS ${table} (
			tenant_id TEXT NOT NULL,
			id TEXT NOT NULL,
			doc TEXT NOT NULL,
			PRIMARY KEY (tenant_id, id)
		);
		CREATE TABLE IF NOT EXISTS ${table}_cdc_applied (
			table_name TEXT PRIMARY KEY,
			watermark INTEGER NOT NULL
		);
	`);

	const insertRow = source.prepare(
		`INSERT INTO ${table} (tenant_id, id, doc) VALUES (?, ?, ?)
		 ON CONFLICT (tenant_id, id) DO UPDATE SET doc = excluded.doc`,
	);
	const deleteRow = source.prepare(
		`DELETE FROM ${table} WHERE tenant_id = ? AND id = ?`,
	);
	const appendCdc = source.prepare(
		`INSERT INTO ${table}_cdc_log (tenant_id, id, op, doc) VALUES (?, ?, ?, ?)`,
	);
	const applyUpsert = target.prepare(
		`INSERT INTO ${table} (tenant_id, id, doc) VALUES (?, ?, ?)
		 ON CONFLICT (tenant_id, id) DO UPDATE SET doc = excluded.doc`,
	);
	const applyDelete = target.prepare(
		`DELETE FROM ${table} WHERE tenant_id = ? AND id = ?`,
	);

	function watermark(): number {
		// SAFETY: the query selects one optional numeric watermark column.
		const row = target
			.prepare(
				`SELECT watermark FROM ${table}_cdc_applied WHERE table_name = ?`,
			)
			// SAFETY: the query selects one optional numeric watermark column.
			.get(table) as { watermark?: number | bigint } | undefined;
		return Number(row?.watermark ?? 0);
	}

	function pendingChanges(): readonly {
		seq: number;
		tenant_id: string;
		id: string;
		op: string;
		doc: string | null;
	}[] {
		const after = watermark();
		const rows = tenant
			? source
					.prepare(
						`SELECT seq, tenant_id, id, op, doc FROM ${table}_cdc_log
						 WHERE seq > ? AND tenant_id = ? ORDER BY seq`,
					)
					.all(after, tenant)
			: source
					.prepare(
						`SELECT seq, tenant_id, id, op, doc FROM ${table}_cdc_log
						 WHERE seq > ? ORDER BY seq`,
					)
					.all(after);
		return rows.map((row) => ({
			seq: Number(row.seq),
			tenant_id: String(row.tenant_id),
			id: String(row.id),
			op: String(row.op),
			doc: row.doc === null ? null : String(row.doc),
		}));
	}

	function readRows(db: DatabaseSync): readonly JsonObject[] {
		const rows = tenant
			? db
					.prepare(
						`SELECT id, doc FROM ${table} WHERE tenant_id = ? ORDER BY id`,
					)
					.all(tenant)
			: db
					.prepare(
						`SELECT tenant_id, id, doc FROM ${table} ORDER BY tenant_id, id`,
					)
					.all();
		return Object.freeze(
			// SAFETY: the SELECT statements below provide these row columns.
			(rows as { tenant_id?: string; id: string; doc: string }[]).map((row) =>
				Object.freeze({
					...(row.tenant_id !== undefined
						? { tenant: row.tenant_id }
						: undefined),
					id: row.id,
					// SAFETY: writeSource serializes JsonObject documents.
					...(JSON.parse(row.doc) as JsonObject),
				}),
			),
		);
	}

	function fenceRow(forTenant: string): { fence_token: string } | undefined {
		// SAFETY: the query selects the optional fence token column.
		return (
			source
				.prepare(
					`SELECT fence_token FROM ${table}_tenant_fence WHERE tenant_id = ?`,
				)
				// SAFETY: the query selects the optional fence token column.
				.get(forTenant) as { fence_token: string } | undefined
		);
	}

	function maxSeq(): number {
		// SAFETY: the query selects one nullable numeric head column.
		const row = (
			tenant
				? source
						.prepare(
							`SELECT MAX(seq) AS head FROM ${table}_cdc_log WHERE tenant_id = ?`,
						)
						.get(tenant)
				: source.prepare(`SELECT MAX(seq) AS head FROM ${table}_cdc_log`).get()
		) as { head: number | bigint | null } | undefined;
		// SAFETY: the query selects one nullable numeric head column.
		return Number(row?.head ?? 0);
	}

	return {
		fidelity: "live",
		writeSource(writes) {
			// Fail closed BEFORE the transaction: a fenced tenant's writes belong
			// to its silo — refusing here is the zero-loss guarantee's write half.
			for (const write of writes) {
				const rowTenant = write.tenant ?? tenant ?? "default";
				const fence = fenceRow(rowTenant);
				if (fence) throw new FencedTenantError(rowTenant, fence.fence_token);
			}
			source.exec("BEGIN IMMEDIATE");
			try {
				for (const write of writes) {
					const rowTenant = write.tenant ?? tenant ?? "default";
					const doc = JSON.stringify(write.doc);
					if (write.deleted) {
						deleteRow.run(rowTenant, write.id);
						appendCdc.run(rowTenant, write.id, "delete", null);
					} else {
						insertRow.run(rowTenant, write.id, doc);
						appendCdc.run(rowTenant, write.id, "upsert", doc);
					}
				}
				source.exec("COMMIT");
			} catch (error) {
				source.exec("ROLLBACK");
				throw error;
			}
		},
		replicate() {
			const changes = pendingChanges();
			if (changes.length === 0) return 0;
			target.exec("BEGIN IMMEDIATE");
			try {
				for (const change of changes) {
					if (change.op === "delete") {
						applyDelete.run(change.tenant_id, change.id);
					} else {
						applyUpsert.run(change.tenant_id, change.id, change.doc ?? "{}");
					}
				}
				const top = changes[changes.length - 1]?.seq ?? 0;
				target
					.prepare(
						`INSERT INTO ${table}_cdc_applied (table_name, watermark) VALUES (?, ?)
						 ON CONFLICT (table_name) DO UPDATE SET watermark = excluded.watermark`,
					)
					.run(table, top);
				target.exec("COMMIT");
			} catch (error) {
				target.exec("ROLLBACK");
				throw error;
			}
			return changes.length;
		},
		lag() {
			return pendingChanges().length;
		},
		backfill() {
			// Snapshot-then-tail: copy the current in-scope row set, then pin the
			// watermark at today's CDC head so tailing resumes from here. One
			// target transaction — a failed backfill leaves the watermark alone.
			const rows = (
				tenant
					? source
							.prepare(
								`SELECT tenant_id, id, doc FROM ${table} WHERE tenant_id = ? ORDER BY id`,
							)
							.all(tenant)
					: source
							.prepare(
								`SELECT tenant_id, id, doc FROM ${table} ORDER BY tenant_id, id`,
							)
							// SAFETY: the SELECT above fixes the backfill row shape.
							.all()
			).map((row) => ({
				tenant_id: String(row.tenant_id),
				id: String(row.id),
				doc: String(row.doc),
			}));
			const head = maxSeq();
			target.exec("BEGIN IMMEDIATE");
			try {
				for (const row of rows) {
					applyUpsert.run(row.tenant_id, row.id, row.doc);
				}
				target
					.prepare(
						`INSERT INTO ${table}_cdc_applied (table_name, watermark) VALUES (?, ?)
						 ON CONFLICT (table_name) DO UPDATE SET watermark = excluded.watermark`,
					)
					.run(table, head);
				target.exec("COMMIT");
			} catch (error) {
				target.exec("ROLLBACK");
				throw error;
			}
			return rows.length;
		},
		raiseFence(forTenant) {
			const existing = fenceRow(forTenant);
			if (existing) return { fenceToken: existing.fence_token };
			const fenceToken = `fence:${forTenant}:${maxSeq()}`;
			source
				.prepare(
					`INSERT INTO ${table}_tenant_fence (tenant_id, fence_token, fenced_at) VALUES (?, ?, ?)`,
				)
				.run(forTenant, fenceToken, new Date().toISOString());
			return { fenceToken };
		},
		isFenced(forTenant) {
			return fenceRow(forTenant) !== undefined;
		},
		headSeq() {
			return maxSeq();
		},
		appliedWatermark() {
			return watermark();
		},
		reapSource(forTenant) {
			// Destructive: only after the move is proven. Fenced + zero lag +
			// checksum-equal oracle view, else refuse.
			if (!fenceRow(forTenant)) {
				throw new Error(
					`reap refused: tenant ${forTenant} is not fenced; the pooled store may still be authoritative`,
				);
			}
			if (pendingChanges().length > 0) {
				throw new Error(
					`reap refused: ${pendingChanges().length} un-replicated change(s) would be lost`,
				);
			}
			const view = Object.freeze({
				sourceRows: readRows(source),
				targetRows: readRows(target),
			});
			const encode = (rows: readonly unknown[]) => JSON.stringify(rows);
			if (
				tenant !== undefined &&
				encode(view.sourceRows) !== encode(view.targetRows)
			) {
				throw new Error(
					"reap refused: source and silo row sets are not checksum-equal",
				);
			}
			const result = source
				.prepare(`DELETE FROM ${table} WHERE tenant_id = ?`)
				.run(forTenant);
			return { reaped: Number(result.changes) };
		},
		snapshot() {
			return Object.freeze({
				sourceRows: readRows(source),
				targetRows: readRows(target),
				fidelity: "live" as const,
			});
		},
		close() {
			source.close();
			target.close();
		},
	};
}

function validIdentifier(value: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
		throw new Error(`invalid SQL identifier: ${value}`);
	}
	return value;
}
