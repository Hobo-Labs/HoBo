import {
	type CaptureBatch,
	CapturePositionError,
	type CaptureReadRequest,
	type CaptureStartRequest,
	type ChangeCapturePort,
	type ChangeEnvelope,
	canonicalEncode,
	DataCoreError,
	type DatasetSchema,
	deleteMutation,
	envelopeOf,
	normalizeCanonicalValue,
	type RecordMutation,
	upsertMutation,
} from "@hobo/data-core";
import { PostgresDataError } from "../errors.js";
import { type PostgresExecutor, sqlStateOf } from "./executor.js";
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

const ROWS_PER_CHANGE = 4;
const MINIMUM_ROW_BUDGET = 64;
const MAXIMUM_ROW_BUDGET = 1_000_000_000;

const INTERNAL_ERROR = "XX000";
const UNMAPPED_RELATION = /could not map file(?:node|number)/u;

export function isUndecodableSlotError(cause: unknown): boolean {
	return (
		sqlStateOf(cause) === INTERNAL_ERROR &&
		cause instanceof Error &&
		UNMAPPED_RELATION.test(cause.message)
	);
}

export const SLOT_HORIZON = "SELECT pg_current_xact_id()::text AS horizon";

export const SLOT_SETTLED =
	"SELECT (pg_snapshot_xmin(pg_current_snapshot()) > $1::xid8)::text AS settled";

export const SLOT_PROBE =
	"SELECT count(*)::text AS decoded FROM pg_logical_slot_peek_binary_changes($1::name, NULL, NULL, 'proto_version', '1', 'publication_names', $2::text)";

const SLOT_ATTEMPTS = 5;
const SETTLE_POLLS = 600;

export interface CapturePortOptions {
	readonly pollIntervalMs: number;
	readonly wait: (milliseconds: number) => Promise<void>;
}

export interface CaptureSubscription {
	readonly dataset: string;
	readonly tenant: string;
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

export async function mutationsOf(
	schema: DatasetSchema,
	change: PgOutputRowChange,
	reread: (tenant: string, key: string) => Promise<RecordMutation | undefined>,
): Promise<readonly RecordMutation[]> {
	if (change.op === "truncate") {
		throw new PostgresDataError(
			"CAPTURE_STREAM_UNDECODABLE",
			`dataset ${schema.name} was truncated; a truncate cannot be captured as record changes`,
			{ detail: { dataset: schema.name } },
		);
	}
	if (change.op === "delete") {
		return [deleteMutation(tenantOf(change.old), keyOf(schema, change.old))];
	}
	const image = change.op === "update" ? change.old : undefined;
	const tenant = tenantOf(change.row, image);
	const key = keyOf(schema, change.row, image);
	const out: RecordMutation[] = [];
	if (image !== undefined) {
		const oldTenant = tenantOf(image);
		const oldKey = keyOf(schema, image);
		if (oldTenant !== tenant || oldKey !== key) {
			out.push(deleteMutation(oldTenant, oldKey));
		}
	}
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
	readonly quiescentHead: bigint | undefined;
	readonly messages: readonly Uint8Array[];
}

export interface CapturePort extends ChangeCapturePort {
	describe(subscription: string): Promise<CaptureSubscription | undefined>;
	stopAll(): Promise<void>;
}

export function createCapturePort(
	store: DatasetStore,
	options: CapturePortOptions,
): CapturePort {
	const { executor, namespace } = store;
	const subscriptions = store.meta("subscriptions");
	const relations = new Map<string, Map<number, PgOutputRelation>>();

	const find = async (name: string): Promise<Subscription | undefined> => {
		await store.ready();
		const result = await executor.query(
			`SELECT dataset, tenant, slot_name, publication_name, start_position FROM ${subscriptions} WHERE subscription = $1::text`,
			[name],
		);
		const row = result.rows[0];
		if (row === undefined) return undefined;
		return {
			dataset: row.dataset ?? "",
			tenant: row.tenant ?? "",
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

	const dropSlot = (on: PostgresExecutor, slot: string) =>
		on.query(
			"SELECT pg_drop_replication_slot(slot_name)::text AS dropped FROM pg_replication_slots WHERE slot_name = $1::name",
			[slot],
		);

	const settled = async (): Promise<boolean> => {
		const horizon = (await executor.query(SLOT_HORIZON)).rows[0]?.horizon;
		if (horizon === null || horizon === undefined) return true;
		for (let poll = 0; poll < SETTLE_POLLS; poll += 1) {
			const state = await executor.query(SLOT_SETTLED, [horizon]);
			if (state.rows[0]?.settled !== "false") return true;
			await options.wait(options.pollIntervalMs);
		}
		return false;
	};

	const createProvenSlot = async (
		subscription: string,
		objects: PostgresCaptureObjects,
	): Promise<string> => {
		const unproven = (reason: string, message: string): PostgresDataError =>
			new PostgresDataError("CAPTURE_SLOT_UNPROVEN", message, {
				detail: { subscription, reason },
			});
		for (let attempt = 1; ; attempt += 1) {
			const created = await executor.query(
				"SELECT lsn::text AS lsn FROM pg_create_logical_replication_slot($1::name, 'pgoutput')",
				[objects.slot],
			);
			const position = formatLsn(parseLsn(created.rows[0]?.lsn ?? ""));
			if (!(await settled())) {
				throw unproven(
					"TRANSACTIONS_STILL_OPEN",
					`transactions that were open when the replication slot for ${subscription} was created have not ended; until they do, the slot cannot be shown to decode them. Start the subscription again once they have`,
				);
			}
			try {
				await executor.query(SLOT_PROBE, [
					objects.slot,
					quoteIdentifier(objects.publication),
				]);
				return position;
			} catch (cause) {
				if (!isUndecodableSlotError(cause)) throw cause;
				await dropSlot(executor, objects.slot);
				if (attempt >= SLOT_ATTEMPTS) {
					throw unproven(
						"UNDECODABLE",
						`${SLOT_ATTEMPTS} replication slots in a row for ${subscription} could not decode a transaction that was open while they were created; tables are being created and written to faster than a slot can be started`,
					);
				}
			}
		}
	};

	const peek = (
		name: string,
		objects: PostgresCaptureObjects,
		after: bigint,
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
				throw new CapturePositionError(
					name,
					`changes before ${formatLsn(confirmed)} were acknowledged and released; subscription ${name} cannot be read from ${formatLsn(after)}`,
				);
			}
			const quiescentHead =
				row.flushed !== null && row.flushed === row.inserted
					? parseLsn(row.flushed ?? "")
					: undefined;
			const changes = await tx
				.query(
					"SELECT encode(data, 'hex') AS data FROM pg_logical_slot_peek_binary_changes($1::name, NULL, $2::integer, 'proto_version', '1', 'publication_names', $3::text)",
					[
						objects.slot,
						budget === undefined ? null : String(budget),
						quoteIdentifier(objects.publication),
					],
				)
				.catch((cause) => {
					if (!isUndecodableSlotError(cause)) throw cause;
					throw new PostgresDataError(
						"CAPTURE_STREAM_UNDECODABLE",
						`the replication slot behind subscription ${name} cannot decode a transaction in its log and never will; stop the subscription and start it again`,
						{ detail: { subscription: name, sqlState: INTERNAL_ERROR } },
					);
				});
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
		if (existing !== undefined) {
			if (
				existing.dataset !== request.scope.dataset ||
				existing.tenant !== request.scope.tenant
			) {
				throw new DataCoreError(
					"CAPTURE_SUBSCRIPTION_CONFLICT",
					`subscription ${request.subscription} is bound to another scope`,
					{ detail: { subscription: request.subscription } },
				);
			}
			return existing.start;
		}
		const { schema } = await store.dataset(request.scope.dataset);
		const objects = captureObjectNames(
			await store.ready(),
			namespace,
			request.subscription,
		);
		await dropObjects(objects);
		try {
			await executor.query(
				`CREATE PUBLICATION ${quoteIdentifier(objects.publication)} FOR TABLE ${qualifiedName(namespace, schema.name)}`,
			);
			const position = await createProvenSlot(request.subscription, objects);
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
			const bounded = budget <= MAXIMUM_ROW_BUDGET;
			const peeked = await peek(
				request.subscription,
				subscription.objects,
				after,
				bounded ? budget : undefined,
			);
			const decoded = decodePgOutputTransactions(peeked.messages, known);
			for (const [oid, relation] of decoded.relations) known.set(oid, relation);
			const exhausted = !bounded || peeked.messages.length < budget;
			const pending = decoded.transactions.filter(
				(transaction) => transaction.endLsn > after,
			);
			if (pending.length === 0 && !exhausted) {
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
			const head = await executor.query(
				"SELECT ($1::pg_lsn > pg_current_wal_insert_lsn())::text AS ahead",
				[position],
			);
			if (head.rows[0]?.ahead === "true") {
				throw new CapturePositionError(
					request.subscription,
					`${position} is past the end of the write-ahead log; nothing was read there, so it cannot be acknowledged`,
				);
			}
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
