/**
 * Change capture over logical decoding.
 *
 * A subscription is a publication for the dataset's table plus a logical
 * replication slot using the `pgoutput` plugin. Changes are fetched through
 * the server's SQL decoding functions, so no replication-protocol connection
 * is needed — any session that can run a query can tail the log.
 *
 * Positions are write-ahead-log locations. A change's position is where its
 * transaction's commit record ends, so every change of one transaction shares
 * a position and a read never returns part of a transaction.
 */
import {
	type CaptureBatch,
	type CaptureReadRequest,
	type CaptureStartRequest,
	type ChangeCapturePort,
	type ChangeEnvelope,
	canonicalEncode,
	type DatasetSchema,
	deleteMutation,
	envelopeOf,
	normalizeCanonicalValue,
	type RecordMutation,
	upsertMutation,
} from "@hobo/data-core";
import { PostgresDataError } from "../errors.js";
import {
	captureObjectNames,
	type PostgresCaptureObjects,
	qualifiedName,
	quoteIdentifier,
	TENANT_COLUMN,
} from "./identifiers.js";
import { formatLsn, maxLsn, parseLsn } from "./lsn.js";
import {
	decodePgOutputTransactions,
	type PgOutputRelation,
	type PgOutputRowChange,
	type PgOutputTransaction,
	type PgOutputTuple,
} from "./pgoutput.js";
import type { DatasetStore, StoredDataset } from "./store.js";
import {
	canonicalFromNative,
	keyFieldsOf,
	type NativeCell,
	nativeTextToCanonical,
} from "./types.js";

/**
 * Session settings the decoding call runs under. Logical decoding emits each
 * value through its type's output function, which obeys the session: without
 * these, a timestamp would arrive in the session's zone and style, bytes in
 * whichever `bytea_output` was configured, and a float possibly rounded.
 */
export const CAPTURE_SESSION_SETTINGS = Object.freeze({
	TimeZone: "UTC",
	DateStyle: "ISO, YMD",
	IntervalStyle: "postgres",
	extra_float_digits: "1",
	bytea_output: "hex",
} as const);

const PIN_SETTINGS = `SELECT ${Object.entries(CAPTURE_SESSION_SETTINGS)
	.map(
		([name, value], index) =>
			`set_config('${name}', '${value}', true) AS pinned_${index}`,
	)
	.join(", ")}`;

/** Rows a first decoding call may return, per requested change. */
const ROWS_PER_CHANGE = 4;
const MINIMUM_ROW_BUDGET = 64;
const MAXIMUM_ROW_BUDGET = 1_000_000_000;

/** A durable reader of one dataset's log, as the registry records it. */
export interface CaptureSubscription {
	readonly dataset: string;
	readonly start: string;
	readonly objects: PostgresCaptureObjects;
}

type Subscription = CaptureSubscription;

function lost(subscription: string, message: string): PostgresDataError {
	return new PostgresDataError("CAPTURE_SUBSCRIPTION_LOST", message, {
		detail: { subscription },
	});
}

function cellOf(tuple: PgOutputTuple, column: string): NativeCell {
	const cell = tuple.get(column);
	if (cell === undefined || cell.kind === "unchanged") return undefined;
	return cell.kind === "null" ? null : cell.text;
}

/**
 * One column of a new row, falling back to the old image where the server
 * sent a placeholder. A value stored out of line that an update left alone is
 * not resent in the new row; when that value belongs to the replica identity
 * the server logs it in the old-key image instead, and when the identity is
 * full, in the old row. Either way the real value is in `old`.
 */
function settledCell(
	tuple: PgOutputTuple,
	old: PgOutputTuple | undefined,
	column: string,
): NativeCell {
	if (tuple.get(column)?.kind === "unchanged" && old !== undefined) {
		return cellOf(old, column);
	}
	return cellOf(tuple, column);
}

function tenantOf(tuple: PgOutputTuple, old?: PgOutputTuple): string {
	return settledCell(tuple, old, TENANT_COLUMN) ?? "";
}

/**
 * The canonical key of a decoded tuple, from its key columns alone. `old` is
 * the image to complete an update's new row from: a large key the update did
 * not touch arrives there, not in the row.
 */
function keyOf(
	schema: DatasetSchema,
	tuple: PgOutputTuple,
	old?: PgOutputTuple,
): string {
	return canonicalEncode(
		keyFieldsOf(schema).map((field) => {
			const text = settledCell(tuple, old, field.name);
			if (text === null || text === undefined) {
				throw new PostgresDataError(
					"CAPTURE_STREAM_UNDECODABLE",
					`a decoded change carries no value for key column ${field.name}; the table's replica identity must cover the primary key`,
					{ detail: { dataset: schema.name, column: field.name } },
				);
			}
			return normalizeCanonicalValue(
				field.type,
				nativeTextToCanonical(field.type, text, "decoded", field.name),
				field.name,
			);
		}),
	);
}

function unchangedColumns(tuple: PgOutputTuple): readonly string[] {
	return [...tuple]
		.filter(([, cell]) => cell.kind === "unchanged")
		.map(([column]) => column);
}

/**
 * Turn one decoded row change into the mutations it means.
 *
 * Pure except for `reread`, which is consulted only when an update left a
 * large out-of-line value untouched: the server then sends a placeholder
 * instead of the value, and the row has to be completed from the old image
 * (when the replica identity is full) or from the store.
 */
export async function mutationsOf(
	schema: DatasetSchema,
	change: PgOutputRowChange,
	reread: (tenant: string, key: string) => Promise<RecordMutation | undefined>,
): Promise<readonly RecordMutation[]> {
	if (change.op === "truncate") {
		// A truncate names no keys, so it cannot become record changes. The
		// truncate guard refuses it at the source; reaching here means the
		// guard was removed, and silently dropping it would diverge the target.
		throw new PostgresDataError(
			"CAPTURE_STREAM_UNDECODABLE",
			`dataset ${schema.name} was truncated; a truncate cannot be captured as record changes`,
			{ detail: { dataset: schema.name } },
		);
	}
	if (change.op === "delete") {
		return [deleteMutation(tenantOf(change.old), keyOf(schema, change.old))];
	}
	// The old image of an update, whichever kind: enough to complete the key.
	const image = change.op === "update" ? change.old : undefined;
	const tenant = tenantOf(change.row, image);
	const key = keyOf(schema, change.row, image);
	const out: RecordMutation[] = [];
	if (image !== undefined) {
		const oldTenant = tenantOf(image);
		const oldKey = keyOf(schema, image);
		// A changed key is a move: the record leaves one key and lands on
		// another, in that order.
		if (oldTenant !== tenant || oldKey !== key) {
			out.push(deleteMutation(oldTenant, oldKey));
		}
	}
	// A full old row completes any column; a key image completes the key
	// columns and nothing else. What neither covers is re-read from the store.
	const full =
		change.op === "update" && change.oldImage === "full"
			? change.old
			: undefined;
	const identity = new Set([
		TENANT_COLUMN,
		...keyFieldsOf(schema).map((field) => field.name),
	]);
	const settled = full ?? image;
	const covered = (column: string): boolean =>
		full !== undefined || (image !== undefined && identity.has(column));
	const missing = unchangedColumns(change.row);
	if (missing.some((column) => !covered(column))) {
		const current = await reread(tenant, key);
		// Gone by now: its delete follows later in the log.
		if (current !== undefined) out.push(current);
		return out;
	}
	const record = canonicalFromNative(
		schema,
		(column) => settledCell(change.row, settled, column),
		"decoded",
	);
	out.push(upsertMutation(tenant, key, record));
	return out;
}

interface Peek {
	readonly confirmed: bigint;
	/** A log location known to be a record boundary with nothing unflushed before it. */
	readonly quiescentHead: bigint | undefined;
	readonly messages: readonly Uint8Array[];
}

export interface CapturePort extends ChangeCapturePort {
	/** The registry's record of one subscription, when there is one. */
	describe(subscription: string): Promise<CaptureSubscription | undefined>;
	/** Drop every subscription this namespace holds, and the log each pinned. */
	stopAll(): Promise<void>;
}

export function createCapturePort(store: DatasetStore): CapturePort {
	const { executor, namespace } = store;
	const subscriptions = store.meta("subscriptions");
	const relations = new Map<string, Map<number, PgOutputRelation>>();

	const find = async (name: string): Promise<Subscription | undefined> => {
		await store.ready();
		const result = await executor.query(
			`SELECT dataset, slot_name, publication_name, start_position FROM ${subscriptions} WHERE subscription = $1::text`,
			[name],
		);
		const row = result.rows[0];
		if (row === undefined) return undefined;
		return {
			dataset: row.dataset ?? "",
			start: row.start_position ?? "",
			objects: {
				slot: row.slot_name ?? "",
				publication: row.publication_name ?? "",
			},
		};
	};

	const dropObjects = async (
		objects: PostgresCaptureObjects,
	): Promise<void> => {
		await executor.query(
			"SELECT pg_drop_replication_slot(slot_name)::text AS dropped FROM pg_replication_slots WHERE slot_name = $1::name",
			[objects.slot],
		);
		await executor.query(
			`DROP PUBLICATION IF EXISTS ${quoteIdentifier(objects.publication)}`,
		);
	};

	const peek = (
		name: string,
		objects: PostgresCaptureObjects,
		after: bigint,
		/** Rows after which the server may stop; `undefined` decodes to the end. */
		budget: number | undefined,
	): Promise<Peek> =>
		executor.transaction(async (tx) => {
			await tx.query(PIN_SETTINGS);
			const state = await tx.query(
				"SELECT confirmed_flush_lsn::text AS confirmed, pg_current_wal_flush_lsn()::text AS flushed, pg_current_wal_insert_lsn()::text AS inserted FROM pg_replication_slots WHERE slot_name = $1::name",
				[objects.slot],
			);
			const row = state.rows[0];
			if (row === undefined || row.confirmed === null) {
				throw lost(
					name,
					`the replication slot behind subscription ${name} is gone; changes since its last acknowledged position cannot be recovered`,
				);
			}
			const confirmed = parseLsn(row.confirmed ?? "");
			if (after < confirmed) {
				throw new PostgresDataError(
					"CAPTURE_POSITION_INVALID",
					`changes before ${formatLsn(confirmed)} were acknowledged and released; subscription ${name} cannot be read from ${formatLsn(after)}`,
					{ detail: { subscription: name } },
				);
			}
			// When everything inserted is also flushed, that location is a
			// record boundary with no commit pending behind it, so it is a safe
			// resume point even though no change of ours sits there. A bare
			// flush location is not: it can fall inside a commit record, and
			// acknowledging it would make the server skip that transaction.
			const quiescentHead =
				row.flushed !== null && row.flushed === row.inserted
					? parseLsn(row.flushed ?? "")
					: undefined;
			const changes = await tx.query(
				"SELECT encode(data, 'hex') AS data FROM pg_logical_slot_peek_binary_changes($1::name, NULL, $2::integer, 'proto_version', '1', 'publication_names', $3::text)",
				[
					objects.slot,
					budget === undefined ? null : String(budget),
					quoteIdentifier(objects.publication),
				],
			);
			return {
				confirmed,
				quiescentHead,
				messages: changes.rows.map((entry) =>
					Buffer.from(entry.data ?? "", "hex"),
				),
			};
		});

	const envelopesOf = async (
		stored: StoredDataset,
		tenant: string,
		transaction: PgOutputTransaction,
	): Promise<readonly ChangeEnvelope[]> => {
		const { schema } = stored;
		const position = formatLsn(transaction.endLsn);
		const out: ChangeEnvelope[] = [];
		for (const change of transaction.changes) {
			const touched =
				change.op === "truncate" ? change.relations : [change.relation];
			if (
				!touched.some(
					(entry) =>
						entry.namespace === namespace && entry.name === schema.name,
				)
			) {
				continue;
			}
			const mutations = await mutationsOf(schema, change, async (at, key) => {
				const record = await store.read(schema.name, at, key);
				return record === undefined
					? undefined
					: upsertMutation(at, key, record);
			});
			for (const mutation of mutations) {
				if (tenant === "" || mutation.tenant === tenant) {
					out.push(envelopeOf(schema, mutation, position));
				}
			}
		}
		return out;
	};

	const start = async (request: CaptureStartRequest): Promise<string> => {
		const existing = await find(request.subscription);
		if (existing !== undefined) return existing.start;
		const { schema } = await store.dataset(request.scope.dataset);
		const objects = captureObjectNames(
			await store.ready(),
			namespace,
			request.subscription,
		);
		// Leftovers of a start that died before it recorded itself.
		await dropObjects(objects);
		try {
			// The publication first: decoding resolves it as of the log
			// position being decoded, so it has to predate the slot.
			await executor.query(
				`CREATE PUBLICATION ${quoteIdentifier(objects.publication)} FOR TABLE ${qualifiedName(namespace, schema.name)}`,
			);
			const created = await executor.query(
				"SELECT lsn::text AS lsn FROM pg_create_logical_replication_slot($1::name, 'pgoutput')",
				[objects.slot],
			);
			const position = formatLsn(parseLsn(created.rows[0]?.lsn ?? ""));
			await executor.query(
				`INSERT INTO ${subscriptions} (subscription, dataset, tenant, slot_name, publication_name, start_position) VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text)`,
				[
					request.subscription,
					schema.name,
					request.scope.tenant,
					objects.slot,
					objects.publication,
					position,
				],
			);
			return position;
		} catch (cause) {
			// A slot nobody recorded would pin the log for ever.
			await dropObjects(objects).catch(() => undefined);
			throw cause;
		}
	};

	const read = async (request: CaptureReadRequest): Promise<CaptureBatch> => {
		const after = parseLsn(request.after);
		const subscription = await find(request.subscription);
		if (subscription === undefined) {
			throw lost(
				request.subscription,
				`subscription ${request.subscription} was never started, or was stopped`,
			);
		}
		if (subscription.dataset !== request.scope.dataset) {
			// The slot only carries the dataset it was started on; reading it
			// for another would return nothing and look like "no changes".
			throw new PostgresDataError(
				"CAPTURE_SUBSCRIPTION_LOST",
				`subscription ${request.subscription} captures ${subscription.dataset}, not ${request.scope.dataset}`,
				{ detail: { subscription: request.subscription } },
			);
		}
		const stored = await store.dataset(request.scope.dataset);
		const limit = request.limit;
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new PostgresDataError(
				"ENGINE_OPTIONS_INVALID",
				"a capture read limit must be a positive integer",
				{ detail: { field: "limit" } },
			);
		}
		const known =
			relations.get(request.subscription) ??
			new Map<number, PgOutputRelation>();
		relations.set(request.subscription, known);

		let budget = Math.max(MINIMUM_ROW_BUDGET, limit * ROWS_PER_CHANGE);
		for (;;) {
			// Past what the server's integer argument can carry, stop
			// budgeting and decode to the end of the log.
			const bounded = budget <= MAXIMUM_ROW_BUDGET;
			const peeked = await peek(
				request.subscription,
				subscription.objects,
				after,
				bounded ? budget : undefined,
			);
			const decoded = decodePgOutputTransactions(peeked.messages, known);
			for (const [oid, relation] of decoded.relations) known.set(oid, relation);
			// The server stops a decoding call at the first transaction
			// boundary past the row budget; fewer rows than the budget means
			// it ran to the end of the log.
			const exhausted = !bounded || peeked.messages.length < budget;
			const pending = decoded.transactions.filter(
				(transaction) => transaction.endLsn > after,
			);
			if (pending.length === 0 && !exhausted) {
				// Everything decoded so far sits at or before `after` — an
				// unacknowledged backlog. Look further.
				budget *= 2;
				continue;
			}
			const changes: ChangeEnvelope[] = [];
			let position = after;
			let cut = false;
			for (const transaction of pending) {
				const envelopes = await envelopesOf(
					stored,
					request.scope.tenant,
					transaction,
				);
				// Whole transactions only. The first one is always taken, so a
				// transaction larger than the limit still makes progress.
				if (changes.length > 0 && changes.length + envelopes.length > limit) {
					cut = true;
					break;
				}
				changes.push(...envelopes);
				position = transaction.endLsn;
			}
			const caughtUp = exhausted && !cut;
			if (caughtUp && peeked.quiescentHead !== undefined) {
				position = maxLsn(position, peeked.quiescentHead);
			}
			return { changes, position: formatLsn(position), caughtUp };
		}
	};

	const stop = async (name: string): Promise<void> => {
		const existing = await find(name);
		const objects =
			existing?.objects ??
			captureObjectNames(await store.ready(), namespace, name);
		await dropObjects(objects);
		await executor.query(
			`DELETE FROM ${subscriptions} WHERE subscription = $1::text`,
			[name],
		);
		relations.delete(name);
	};

	return {
		start,
		read,
		async acknowledge(request) {
			const position = formatLsn(parseLsn(request.position));
			const existing = await find(request.subscription);
			if (existing === undefined) return;
			// Advancing backwards is an error to the server and a no-op to the
			// contract, so the guard is in the statement.
			await executor.query(
				"SELECT pg_replication_slot_advance(slot_name, $2::pg_lsn)::text AS advanced FROM pg_replication_slots WHERE slot_name = $1::name AND confirmed_flush_lsn < $2::pg_lsn",
				[existing.objects.slot, position],
			);
		},
		stop,
		describe: find,
		async stopAll() {
			await store.ready();
			const all = await executor.query(
				`SELECT subscription FROM ${subscriptions}`,
			);
			for (const row of all.rows) {
				if (row.subscription !== null && row.subscription !== undefined) {
					await stop(row.subscription);
				}
			}
		},
	};
}
