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

const DUAL_SOURCE = "dual-run";
const DUAL_PIN = "hobo_dual_run_pin";
const DIGEST_BUCKETS = 16;
const PAGE = 1000;

export interface SqliteDataDualWrite {
	readonly id: string;
	readonly doc: JsonObject;
	readonly tenant?: string;
	readonly deleted?: boolean;
}

export interface DataDualRows {
	readonly sourceRows: readonly JsonObject[];
	readonly targetRows: readonly JsonObject[];
	readonly fidelity: "live";
}

// domain-view: computed evidence; wire form is DataDualEvidence in data-models/data_sqlite.proto.
export interface DataDualEvidence {
	readonly source: { readonly count: number; readonly digest: string };
	readonly target: { readonly count: number; readonly digest: string };
	readonly consistent: boolean;
	readonly fidelity: "live";
}

export interface SqliteDataDualPort {
	readonly fidelity: "live";
	snapshot(): DataDualRows;
	evidence(): DataDualEvidence;
	writeSource(writes: readonly SqliteDataDualWrite[]): void;
	replicate(): number;
	lag(): number;
	backfill(): number;
	raiseFence(tenant: string): { readonly fenceToken: string };
	isFenced(tenant: string): boolean;
	headSeq(): number;
	appliedWatermark(): number;
	reapSource(tenant: string): { readonly reaped: number };
	close(): void;
}

export class FencedTenantError extends FencedWriteError {
	constructor(dataset: string, tenant: string) {
		super(dataset, tenant);
		this.name = "FencedTenantError";
		this.message = `tenant ${tenant} is fenced; its writes now belong to the silo`;
	}
}

// domain-view: construction options; wire form is CreateSqliteDataDualPortOptions in data-models/data_sqlite.proto.
export interface CreateSqliteDataDualPortOptions {
	readonly sourcePath: string;
	readonly targetPath: string;
	readonly table?: string;
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

	const cursor = (): string =>
		String(Math.max(watermark(), source.journalFloor()));

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
					throw new FencedTenantError(table, error.tenant);
				}
				throw error;
			}
		},
		replicate() {
			let applied = 0;
			for (;;) {
				const batch = source.readChanges(scope, cursor(), PAGE);
				const last = batch.changes[batch.changes.length - 1];
				if (last === undefined) break;
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
			return source.pending(scope, cursor());
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
			const pending = source.pending(scope, cursor());
			if (pending > 0) {
				throw new Error(
					`reap refused: ${pending} un-replicated change(s) would be lost`,
				);
			}
			const pair = digests(within);
			if (!compareDigests(pair.source, pair.target).equal) {
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
