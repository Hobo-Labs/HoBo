/**
 * The synchronous dual-run port over two SQLite stores — the port the Trails
 * runner and the pooled → siloed tenant move have always run on, now owned by
 * the engine package (ADR-0177 decision 3) and built on the same store as the
 * SPI binding rather than beside it.
 *
 * It is a *dual run*, not a dual write: business writes land on the SOURCE
 * store and its change journal in one transaction, and `replicate()` tails
 * the journal onto the TARGET under a watermark — at-least-once delivery,
 * exactly-once effect. Exactly one side is ever the write authority.
 *
 * Pooled → siloed: when `tenant` is set, the source is a pooled store and the
 * target that tenant's silo. Replication and the oracle are tenant-scoped, so
 * divergence in another tenant's rows never masks or fails this tenant's move.
 */

import type { SQLInputValue } from "node:sqlite";
import {
	compareDigests,
	type DatasetSchema,
	type DatasetScope,
	encodeRecordKey,
	FencedWriteError,
	type JsonObject,
	parseCanonicalRecord,
	parseDatasetSchema,
	type RecordMutation,
	schemaToJson,
	scopeOf,
} from "@hobo/data-core";
import { quoteIdentifier, SqliteDatasetStore } from "./store.js";

const tagOf = Object.prototype.toString;

/** Names the watermark the target keeps for the source's journal. */
const DUAL_SOURCE = "dual-run";
/** Holds the source journal from zero; the port keeps its own cursor. */
const DUAL_PIN = "hobo_dual_run_pin";
const DIGEST_BUCKETS = 16;
const PAGE = 1000;

export interface SqliteDataDualWrite {
	readonly id: string;
	readonly doc: JsonObject;
	/** Pooled-store tenant; defaults to the port's tenant (or "default"). */
	readonly tenant?: string;
	readonly deleted?: boolean;
}

/** Row view over both stores. Kept for the simulated-fixture oracle shape. */
export interface DataDualRows {
	readonly sourceRows: readonly JsonObject[];
	readonly targetRows: readonly JsonObject[];
	readonly fidelity: "live";
}

/**
 * Digest evidence over both stores: counts and digests, never rows. This is
 * what an oracle should consume — the row view above makes the oracle itself
 * a custody point for the data it is checking.
 */
// domain-view: computed evidence; wire form is DataDualEvidence in data-models/data_sqlite.proto.
export interface DataDualEvidence {
	readonly source: { readonly count: number; readonly digest: string };
	readonly target: { readonly count: number; readonly digest: string };
	readonly consistent: boolean;
	readonly fidelity: "live";
}

export interface SqliteDataDualPort {
	readonly fidelity: "live";
	/** Ordered oracle view over both stores (tenant-scoped when configured). */
	snapshot(): DataDualRows;
	/** Counts and digests over both stores; no row leaves the store. */
	evidence(): DataDualEvidence;
	/** Apply business writes to the source and its change journal atomically. */
	writeSource(writes: readonly SqliteDataDualWrite[]): void;
	/** Tail the journal onto the target; returns changes applied. */
	replicate(): number;
	/** Journal entries in scope not yet applied to the target. */
	lag(): number;
	/**
	 * Brownfield bulk copy: every current in-scope source row to the target,
	 * with the watermark advanced to the current journal head, so rows written
	 * before this port existed are covered (snapshot-then-tail).
	 */
	backfill(): number;
	/**
	 * Raise a write fence for a tenant on the SOURCE store. Subsequent
	 * `writeSource` calls for that tenant throw `FencedTenantError`.
	 * Idempotent — re-raising returns the existing token.
	 */
	raiseFence(tenant: string): { readonly fenceToken: string };
	isFenced(tenant: string): boolean;
	/** Highest journal seq in the port's scope — the quiescent head after a drain. */
	headSeq(): number;
	/** Last journal seq applied to the target. */
	appliedWatermark(): number;
	/**
	 * Destructive source reap after a verified move. Refused unless the tenant
	 * is fenced, nothing is un-replicated, and both sides digest equal.
	 */
	reapSource(tenant: string): { readonly reaped: number };
	close(): void;
}

/** A write arrived for a tenant whose rows are fenced (moved to a silo). */
export class FencedTenantError extends FencedWriteError {
	readonly fenceToken: string;

	constructor(dataset: string, tenant: string, fenceToken: string) {
		super(dataset, tenant);
		this.name = "FencedTenantError";
		this.fenceToken = fenceToken;
		this.message = `tenant ${tenant} is fenced (${fenceToken}); its writes now belong to the silo`;
	}
}

// domain-view: construction options; wire form is CreateSqliteDataDualPortOptions in data-models/data_sqlite.proto.
export interface CreateSqliteDataDualPortOptions {
	/** Source store path ("file" | ":memory:"). Pooled store in tenant mode. */
	readonly sourcePath: string;
	/** Target store path. The tenant silo in tenant mode. */
	readonly targetPath: string;
	readonly table?: string;
	/** Scope replication and the oracle to one tenant (pooled → siloed). */
	readonly tenant?: string;
}

function dualSchema(table: string): DatasetSchema {
	return parseDatasetSchema({
		name: table,
		version: 1,
		keyFields: ["id"],
		fields: [
			{ name: "id", type: "string", nullable: false },
			{ name: "doc", type: "json", nullable: false },
		],
	});
}

export function createSqliteDataDualPort(
	options: CreateSqliteDataDualPortOptions,
): SqliteDataDualPort {
	const table = options.table ?? "records";
	quoteIdentifier(table);
	const tenant = options.tenant;
	const schema = dualSchema(table);
	const scope: DatasetScope = scopeOf(table, tenant ?? "");
	const source = new SqliteDatasetStore({ path: options.sourcePath });
	const target = new SqliteDatasetStore({ path: options.targetPath });
	source.ensure(schema, schemaToJson(schema));
	target.ensure(schema, schemaToJson(schema));
	source.pinJournal(DUAL_PIN, table);

	const watermark = (): number =>
		Number(target.watermark(table, DUAL_SOURCE) ?? "0");

	const allRows = (store: SqliteDatasetStore): RecordMutation[] => {
		const rows: RecordMutation[] = [];
		let after: readonly SQLInputValue[] | undefined;
		for (;;) {
			const page = store.page(scope, after, PAGE);
			rows.push(...page.rows);
			if (page.rows.length < PAGE || page.last === undefined) break;
			after = page.last;
		}
		return rows;
	};

	const view = (store: SqliteDatasetStore): readonly JsonObject[] =>
		Object.freeze(
			allRows(store).map((row) => {
				const doc = row.record?.doc ?? null;
				return Object.freeze({
					...(tenant === undefined ? { tenant: row.tenant } : undefined),
					id: String(row.record?.id ?? ""),
					// SAFETY: the tag check proves a JSON object before it is spread.
					...(tagOf.call(doc) === "[object Object]"
						? (doc as JsonObject)
						: undefined),
				});
			}),
		);

	const digests = (within: DatasetScope) => ({
		source: source.digest(within, DIGEST_BUCKETS),
		target: target.digest(within, DIGEST_BUCKETS),
	});

	return {
		fidelity: "live",
		writeSource(writes) {
			const mutations = writes.map((write): RecordMutation => {
				const rowTenant = write.tenant ?? tenant ?? "default";
				const record = parseCanonicalRecord(schema, {
					id: write.id,
					doc: write.doc,
				});
				const key = encodeRecordKey(schema, record);
				return write.deleted
					? { tenant: rowTenant, key, op: "delete" }
					: { tenant: rowTenant, key, op: "upsert", record };
			});
			try {
				source.commit(table, mutations, undefined);
			} catch (error) {
				if (error instanceof FencedWriteError) {
					// Fail closed: a fenced tenant's writes belong to its silo.
					const fence = source.fenceCovering(table, error.tenant);
					throw new FencedTenantError(
						table,
						error.tenant,
						fence?.fenceToken ?? "",
					);
				}
				throw error;
			}
		},
		replicate() {
			let applied = 0;
			for (;;) {
				const batch = source.readChanges(scope, String(watermark()), PAGE);
				const last = batch.changes[batch.changes.length - 1];
				if (last === undefined) break;
				// The watermark is the last change applied — not the journal
				// head — so it stays comparable with the scope's own head.
				target.commit(table, batch.changes, undefined, {
					source: DUAL_SOURCE,
					position: last.position,
				});
				applied += batch.changes.length;
				if (batch.caughtUp) break;
			}
			return applied;
		},
		lag() {
			return source.pending(scope, String(watermark()));
		},
		backfill() {
			const rows = allRows(source);
			target.commit(table, rows, undefined, {
				source: DUAL_SOURCE,
				position: String(source.headOf(scope)),
			});
			return rows.length;
		},
		raiseFence(forTenant) {
			return { fenceToken: source.raiseFence(scopeOf(table, forTenant)) };
		},
		isFenced(forTenant) {
			return source.isFenced(scopeOf(table, forTenant));
		},
		headSeq() {
			return source.headOf(scope);
		},
		appliedWatermark() {
			return watermark();
		},
		reapSource(forTenant) {
			const within = scopeOf(table, forTenant);
			const fence = source
				.fences(table)
				.find((entry) => entry.tenant === forTenant);
			if (fence === undefined) {
				throw new Error(
					`reap refused: tenant ${forTenant} is not fenced; the pooled store may still be authoritative`,
				);
			}
			const pending = source.pending(scope, String(watermark()));
			if (pending > 0) {
				throw new Error(
					`reap refused: ${pending} un-replicated change(s) would be lost`,
				);
			}
			const pair = digests(within);
			if (
				tenant !== undefined &&
				!compareDigests(pair.source, pair.target).equal
			) {
				throw new Error(
					"reap refused: source and silo row sets are not checksum-equal",
				);
			}
			return { reaped: source.retire(within, fence.fenceToken, pair.source) };
		},
		snapshot() {
			return Object.freeze({
				sourceRows: view(source),
				targetRows: view(target),
				fidelity: "live" as const,
			});
		},
		evidence() {
			const pair = digests(scope);
			return Object.freeze({
				source: { count: pair.source.count, digest: pair.source.digest },
				target: { count: pair.target.count, digest: pair.target.digest },
				consistent: compareDigests(pair.source, pair.target).equal,
				fidelity: "live" as const,
			});
		},
		close() {
			source.close();
			target.close();
		},
	};
}
