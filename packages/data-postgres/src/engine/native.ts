/**
 * `migration.postgres.logical-copy/v1` as a native-transfer port: PostgreSQL's
 * own logical replication carries the records.
 *
 * The source half is a publication for the dataset's table and a logical
 * replication slot — the same two objects a capture subscription is made of,
 * created the same way and recorded in the same registry. The target half is
 * a server-side subscription: the target server connects to the source, copies
 * the table, and then applies every change after it.
 *
 * Four things are worth knowing before reading on.
 *
 * - **The slot is created separately, and the subscription told not to.** A
 *   subscription that creates its own slot waits for every transaction open in
 *   the source cluster to end — including, when both databases live in one
 *   cluster, the very transaction creating the subscription. That never ends.
 * - **The connection string is a secret, and is handled as one.** It is given
 *   to the binding as a function, resolved only when a subscription is
 *   created, and sent to the server as one bind parameter of one statement
 *   that stores it in a transaction-local setting. No statement text contains
 *   it, the server is told to report a failure without it, and whatever the
 *   driver throws is discarded but for its SQLSTATE. It is never placed in a
 *   ticket, an error, or a fact. (The target server itself necessarily keeps
 *   it, in `pg_subscription`, until the subscription is dropped.)
 * - **A table lands under the name it was published as.** Logical replication
 *   maps tables by schema-qualified name, so the two bindings must use the
 *   same namespace in two different databases, and the target table must be
 *   empty. Anything else is refused: there is no faithful way to do it.
 * - **One tenant of a pooled table is refused.** It would need a publication
 *   row filter, which exists only from PostgreSQL 15 and does not cover every
 *   case. The hub moves a tenant; this profile moves a dataset.
 */
import {
	type Awaitable,
	DataCoreError,
	isJsonString,
	type JsonObject,
	type JsonValue,
	type NativeReachedRequest,
	type NativeSubscribeRequest,
	type NativeTransferPort,
	type NativeTransferRef,
	sha256Hex,
} from "@hobo/data-core";
import { PostgresDataError } from "../errors.js";
import { LOGICAL_COPY_PROFILE } from "../migration-profiles.js";
import type { CapturePort } from "./capture.js";
import { sqlStateOf } from "./executor.js";
import {
	captureObjectNames,
	NATIVE_TRANSFER_KEY_PREFIX,
	nativeSubscriptionName,
	nativeSubscriptionPrefix,
	nativeTransferKey,
	type PostgresCaptureObjects,
	qualifiedName,
	quoteIdentifier,
} from "./identifiers.js";
import { formatLsn, parseLsn } from "./lsn.js";
import type { DatasetStore } from "./store.js";
import { POSTGRES_ENGINE_ID } from "./types.js";

// public-contract: transaction-local setting the source connection string is handed to the server in.
export const NATIVE_SOURCE_SETTING = "hobo.native_source";

// public-contract: prefix of the logical message a native transfer marks the source's log with.
export const NATIVE_MARK_PREFIX = "hobo.native.mark";

/** Why a native transfer was refused; carried as `detail.reason`. */
export const NATIVE_REFUSALS = [
	"PROFILE_UNKNOWN",
	"TENANT_SCOPE",
	"TICKET_INVALID",
	"NAMESPACE_MISMATCH",
	"SCOPE_MISMATCH",
	"SAME_DATABASE",
	"TARGET_NOT_EMPTY",
	"SOURCE_CONNECTION_MISSING",
] as const;
export type NativeRefusal = (typeof NATIVE_REFUSALS)[number];

/**
 * The statement that hands the connection string to the server: as a bind
 * parameter, into a setting that ends with the transaction. It answers a
 * boolean, never the value, so the secret does not come back in a result.
 */
// public-contract: the one statement that carries the source connection string, as a bind parameter; recorded in the native-transfer pact.
export const PRESENT_NATIVE_SOURCE = `SELECT (set_config('${NATIVE_SOURCE_SETTING}', $1::text, true) IS NOT NULL)::text AS presented`;

const SLOT_NAME = /^hobo_s_[0-9a-f]{12}_[0-9a-f]{24}$/u;
const PUBLICATION_NAME = /^hobo_p_[0-9a-f]{12}_[0-9a-f]{24}$/u;
const SUBSCRIPTION_NAME = /^hobo_n_[0-9a-f]{12}_[0-9a-f]{24}$/u;
const OBJECT_IN_USE = "55006";
const DUPLICATE_OBJECT = "42710";

// domain-view: parsed ticket; wire form is PostgresNativeTicket in data-models/postgres_engine.proto.
export interface PostgresNativeTicket {
	readonly profile: typeof LOGICAL_COPY_PROFILE;
	readonly publication: string;
	readonly slot: string;
	readonly namespace: string;
	readonly dataset: string;
	readonly tenant: "";
	/** A digest naming the source database, so a store is never copied into itself. */
	readonly origin: string;
}

function refused(reason: NativeRefusal, message: string): DataCoreError {
	return new DataCoreError("NATIVE_TRANSFER_REFUSED", message, {
		detail: {
			engine: POSTGRES_ENGINE_ID,
			reason,
			profile: LOGICAL_COPY_PROFILE,
		},
	});
}

function lost(transfer: string, message: string): DataCoreError {
	return new DataCoreError("NATIVE_TRANSFER_LOST", message, {
		detail: { engine: POSTGRES_ENGINE_ID, transfer },
	});
}

/**
 * The one constructor for a ticket. A ticket arrives from the other side of a
 * migration, by way of a journal, and its names are placed in statement text —
 * so every name has to be exactly a name this package derives.
 */
export function parsePostgresNativeTicket(
	value: JsonObject,
): PostgresNativeTicket {
	const text = (field: string): string => {
		const found: JsonValue | undefined = value[field];
		if (!isJsonString(found)) {
			throw refused(
				"TICKET_INVALID",
				`a logical-copy ticket carries a text ${field}`,
			);
		}
		return found;
	};
	const publication = text("publication");
	const slot = text("slot");
	const origin = text("origin");
	if (
		text("profile") !== LOGICAL_COPY_PROFILE ||
		!PUBLICATION_NAME.test(publication) ||
		!SLOT_NAME.test(slot) ||
		!/^[0-9a-f]{32}$/u.test(origin) ||
		text("tenant") !== ""
	) {
		throw refused(
			"TICKET_INVALID",
			"the ticket was not issued by a logical-copy source",
		);
	}
	return Object.freeze({
		profile: LOGICAL_COPY_PROFILE,
		publication,
		slot,
		namespace: text("namespace"),
		dataset: text("dataset"),
		tenant: "",
		origin,
	});
}

/**
 * `CREATE SUBSCRIPTION`, issued from inside a block.
 *
 * A utility statement takes no bind parameters, so the connection string is
 * read from the transaction-local setting and quoted by the server's own
 * `format`. The handler is the point of the block: a failed `CREATE
 * SUBSCRIPTION` reports its own statement — connection string included — as
 * error context. Caught here, it is replaced by an error that keeps the
 * SQLSTATE and says nothing else, and the original is never logged.
 *
 * `create_slot = false` because the slot already exists (see the module
 * note); `synchronous_commit = on` so the target confirms a change only once
 * it is durable there, which is what `reached` then reports.
 */
export function createSubscriptionStatement(names: {
	readonly subscription: string;
	readonly publication: string;
	readonly slot: string;
}): string {
	if (
		!SUBSCRIPTION_NAME.test(names.subscription) ||
		!PUBLICATION_NAME.test(names.publication) ||
		!SLOT_NAME.test(names.slot)
	) {
		throw refused(
			"TICKET_INVALID",
			"subscription, publication and slot names must be names this package derives",
		);
	}
	return `DO $hobo$
BEGIN
	EXECUTE format(
		'CREATE SUBSCRIPTION %I CONNECTION %L PUBLICATION %I WITH (create_slot = false, slot_name = %L, copy_data = true, synchronous_commit = %L)',
		'${names.subscription}', current_setting('${NATIVE_SOURCE_SETTING}'), '${names.publication}', '${names.slot}', 'on');
EXCEPTION WHEN OTHERS THEN
	RAISE EXCEPTION 'the subscription could not be created' USING ERRCODE = SQLSTATE;
END
$hobo$`;
}

/** Whether the initial copy is done: every table of the subscription ready. */
// public-contract: the target-side readiness query; recorded in the native-transfer pact.
export const NATIVE_SUBSCRIPTION_STATE = `SELECT count(DISTINCT s.oid)::text AS subscriptions, count(r.srrelid)::text AS tables, (count(r.srrelid) FILTER (WHERE r.srsubstate = 'r'))::text AS ready FROM pg_subscription s LEFT JOIN pg_subscription_rel r ON r.srsubid = s.oid WHERE s.subname = $1::name AND s.subdbid = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())`;

/**
 * A mark in the source's log. The message is transactional, so its commit is
 * flushed after it: the sender is certain to read past the mark, and so the
 * slot's confirmed position is certain to pass it once the target is level —
 * even when no dataset change follows.
 */
// public-contract: the source-side mark statement; recorded in the native-transfer pact.
export const NATIVE_MARK = `SELECT pg_logical_emit_message(true, '${NATIVE_MARK_PREFIX}', $1::text)::text AS mark`;

/** Whether the subscriber has durably applied everything up to a mark. */
// public-contract: the source-side "reached the mark" query; recorded in the native-transfer pact.
export const NATIVE_REACHED =
	"SELECT (confirmed_flush_lsn >= $2::pg_lsn)::text AS reached FROM pg_replication_slots WHERE slot_name = $1::name";

export interface NativePortInput {
	readonly store: DatasetStore;
	readonly capture: CapturePort;
	/** Resolves the connection string the target server reaches the source with. */
	readonly sourceConnection: (() => Awaitable<string>) | undefined;
	/** How long a progress question waits before answering "not yet". */
	readonly pollIntervalMs: number;
	readonly wait: (milliseconds: number) => Promise<void>;
}

export interface PostgresNativePort extends NativeTransferPort {
	/** Drop every native subscription, slot and publication this namespace holds. */
	stopAll(): Promise<void>;
}

/** Attempts at dropping a slot whose sender is still letting go of it. */
const RELEASE_ATTEMPTS = 40;

export function createNativeTransferPort(
	input: NativePortInput,
): PostgresNativePort {
	const { store, capture, wait, pollIntervalMs } = input;
	const { executor, namespace } = store;
	let identity: Promise<string> | undefined;

	/** A digest naming this database: which cluster, and which database in it. */
	const origin = (): Promise<string> => {
		identity ??= executor
			.query(
				"SELECT (SELECT system_identifier::text FROM pg_control_system()) AS cluster, current_database()::text AS database",
			)
			.then((result) =>
				sha256Hex(
					`${result.rows[0]?.cluster ?? ""}\u0000${result.rows[0]?.database ?? ""}`,
				).slice(0, 32),
			)
			.catch((cause) => {
				identity = undefined;
				throw cause;
			});
		return identity;
	};

	const assertWholeDataset = (ref: NativeTransferRef): void => {
		if (ref.profile !== LOGICAL_COPY_PROFILE) {
			throw refused(
				"PROFILE_UNKNOWN",
				`the PostgreSQL binding does not run ${ref.profile}`,
			);
		}
		if (ref.scope.tenant !== "") {
			throw refused(
				"TENANT_SCOPE",
				"logical-copy publishes a whole dataset table. Moving one tenant of a pooled table would need a publication row filter, which PostgreSQL has only from version 15 and which is not applied faithfully to every change; it is refused rather than approximated. Move a tenant through the hub",
			);
		}
	};

	const subscriptionExists = async (name: string): Promise<boolean> => {
		const found = await executor.query(
			"SELECT s.subname::text AS name FROM pg_subscription s WHERE s.subname = $1::name AND s.subdbid = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())",
			[name],
		);
		return found.rows.length > 0;
	};

	/**
	 * Drop a subscription. The plain form also drops, on the source, the slot
	 * and any slot an unfinished copy made. When the source cannot be reached,
	 * or its slot is already gone, the subscription is detached and dropped
	 * locally instead, and the source's half is left to the source's `stop`.
	 */
	const dropSubscription = async (name: string): Promise<void> => {
		if (!(await subscriptionExists(name))) return;
		const quoted = quoteIdentifier(name);
		try {
			await executor.query(`DROP SUBSCRIPTION IF EXISTS ${quoted}`);
			return;
		} catch {
			// Deliberately not kept: the server's text may name the source.
		}
		try {
			await executor.query(`ALTER SUBSCRIPTION ${quoted} DISABLE`);
			await executor.query(
				`ALTER SUBSCRIPTION ${quoted} SET (slot_name = NONE)`,
			);
			await executor.query(`DROP SUBSCRIPTION IF EXISTS ${quoted}`);
		} catch (cause) {
			throw new PostgresDataError(
				"NATIVE_STOP_FAILED",
				"the subscription behind a native transfer could not be dropped; it is still applying changes from the source",
				{ detail: { sqlState: sqlStateOf(cause) ?? "unknown" } },
			);
		}
	};

	/** Drop the publication and the slot recorded under a registry key. */
	const dropPublished = async (key: string): Promise<void> => {
		const recorded = await capture.describe(key);
		const objects: PostgresCaptureObjects =
			recorded?.objects ??
			captureObjectNames(await store.ready(), namespace, key);
		for (let attempt = 1; ; attempt += 1) {
			// A sender still attached holds the slot. Once the subscription is
			// gone nothing reconnects, so ending the sender frees it for good.
			await executor.query(
				"SELECT pg_terminate_backend(active_pid)::text AS ended FROM pg_replication_slots WHERE slot_name = $1::name AND active",
				[objects.slot],
			);
			try {
				await capture.stop(key);
				return;
			} catch (cause) {
				if (
					sqlStateOf(cause) !== OBJECT_IN_USE ||
					attempt >= RELEASE_ATTEMPTS
				) {
					throw cause;
				}
				await wait(pollIntervalMs);
			}
		}
	};

	const published = async (ref: NativeTransferRef): Promise<string> => {
		const recorded = await capture.describe(nativeTransferKey(ref.transfer));
		if (recorded === undefined) {
			throw lost(
				ref.transfer,
				`native transfer ${ref.transfer} was never published here, or was stopped`,
			);
		}
		return recorded.objects.slot;
	};

	return {
		profiles: Object.freeze([LOGICAL_COPY_PROFILE]),

		async publish(ref): Promise<JsonObject> {
			assertWholeDataset(ref);
			const { schema } = await store.dataset(ref.scope.dataset);
			const key = nativeTransferKey(ref.transfer);
			// The publication, then the slot, then the record — and nothing at
			// all when the record is already there.
			await capture.start({ scope: ref.scope, subscription: key });
			const objects = captureObjectNames(await store.ready(), namespace, key);
			return {
				profile: LOGICAL_COPY_PROFILE,
				publication: objects.publication,
				slot: objects.slot,
				namespace,
				dataset: schema.name,
				tenant: "",
				origin: await origin(),
			};
		},

		async subscribe(request: NativeSubscribeRequest): Promise<void> {
			assertWholeDataset(request);
			const ticket = parsePostgresNativeTicket(request.ticket);
			if (ticket.namespace !== namespace) {
				throw refused(
					"NAMESPACE_MISMATCH",
					`logical replication lands a table under the schema-qualified name it was published as: the source published ${ticket.namespace}.${ticket.dataset}, and this binding's namespace is ${namespace}. Give the target the source's namespace, in another database`,
				);
			}
			if (ticket.dataset !== request.scope.dataset) {
				throw refused(
					"SCOPE_MISMATCH",
					"logical-copy lands a dataset under the name it left; renaming one needs the hub",
				);
			}
			await store.dataset(ticket.dataset);
			const name = nativeSubscriptionName(namespace, request.transfer);
			if (await subscriptionExists(name)) return;
			if (ticket.origin === (await origin())) {
				throw refused(
					"SAME_DATABASE",
					"the target is the database the ticket was issued in; a table cannot be replicated into itself",
				);
			}
			const occupied = await executor.query(
				`SELECT 1::text AS present FROM ${qualifiedName(namespace, ticket.dataset)} LIMIT 1`,
			);
			if (occupied.rows.length > 0) {
				throw refused(
					"TARGET_NOT_EMPTY",
					"the initial copy needs an empty target table: it cannot merge into rows already there, and would stop on the first key they share",
				);
			}
			if (input.sourceConnection === undefined) {
				throw refused(
					"SOURCE_CONNECTION_MISSING",
					"this binding was not given a way to reach the source; construct the target binding with nativeSourceConnection",
				);
			}
			const statement = createSubscriptionStatement({
				subscription: name,
				publication: ticket.publication,
				slot: ticket.slot,
			});
			let sqlState: string | undefined;
			let failed = false;
			try {
				// Resolved here and nowhere else, and held only for this call.
				const connection = await input.sourceConnection();
				await executor.transaction(async (tx) => {
					await tx.query(PRESENT_NATIVE_SOURCE, [connection]);
					await tx.query(statement);
				});
			} catch (cause) {
				// Only the SQLSTATE leaves this block. The thrown value is not
				// kept as a cause and its message is not read: either can quote
				// the connection string.
				failed = true;
				sqlState = sqlStateOf(cause);
			}
			if (!failed || sqlState === DUPLICATE_OBJECT) return;
			throw new PostgresDataError(
				"NATIVE_SUBSCRIBE_FAILED",
				"the target server could not create its subscription to the source. The cause is withheld because it can quote the connection string; the SQLSTATE says which kind of failure it was (08xxx: the source could not be reached or refused the login; 42501: the role may not create subscriptions; 42601: the connection string does not parse)",
				{
					detail: {
						sqlState: sqlState ?? "unknown",
						transfer: request.transfer,
					},
				},
			);
		},

		async seeded(ref): Promise<boolean> {
			const name = nativeSubscriptionName(namespace, ref.transfer);
			const state = await executor.query(NATIVE_SUBSCRIPTION_STATE, [name]);
			const row = state.rows[0];
			if (row === undefined || row.subscriptions !== "1") {
				throw lost(
					ref.transfer,
					`the subscription behind native transfer ${ref.transfer} does not exist here; it was never subscribed, or was stopped`,
				);
			}
			const ready = row.tables === "1" && row.ready === "1";
			if (!ready) await wait(pollIntervalMs);
			return ready;
		},

		async mark(ref): Promise<string> {
			await published(ref);
			const result = await executor.query(NATIVE_MARK, [ref.transfer]);
			return formatLsn(parseLsn(result.rows[0]?.mark ?? ""));
		},

		async reached(request: NativeReachedRequest): Promise<boolean> {
			const mark = formatLsn(parseLsn(request.mark));
			const slot = await published(request);
			const result = await executor.query(NATIVE_REACHED, [slot, mark]);
			const row = result.rows[0];
			if (row === undefined) {
				throw lost(
					request.transfer,
					`the replication slot behind native transfer ${request.transfer} is gone; the changes it retained cannot be recovered`,
				);
			}
			const reached = row.reached === "true";
			if (!reached) await wait(pollIntervalMs);
			return reached;
		},

		async stop(ref): Promise<void> {
			// Both halves, whichever this binding holds. The subscription first:
			// dropping it lets go of the slot the publication half then removes.
			await dropSubscription(nativeSubscriptionName(namespace, ref.transfer));
			await dropPublished(nativeTransferKey(ref.transfer));
		},

		async stopAll(): Promise<void> {
			const prefix = nativeSubscriptionPrefix(namespace);
			const subscriptions = await executor.query(
				"SELECT s.subname::text AS name FROM pg_subscription s WHERE s.subdbid = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database()) AND left(s.subname::text, $2::integer) = $1::text",
				[prefix, String(prefix.length)],
			);
			for (const row of subscriptions.rows) {
				if (row.name !== null && row.name !== undefined) {
					await dropSubscription(row.name);
				}
			}
			await store.ready();
			const keys = await executor.query(
				`SELECT subscription FROM ${store.meta("subscriptions")} WHERE left(subscription, $2::integer) = $1::text`,
				[NATIVE_TRANSFER_KEY_PREFIX, String(NATIVE_TRANSFER_KEY_PREFIX.length)],
			);
			for (const row of keys.rows) {
				if (row.subscription !== null && row.subscription !== undefined) {
					await dropPublished(row.subscription);
				}
			}
		},
	};
}
