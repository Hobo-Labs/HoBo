import type { FoldEvent } from "@hobo/core";
import { type AnyActorDefinition, actor } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import {
	computeRivetOperationDigest,
	type RivetCapabilityClaims,
	type RivetJournalAction,
	type RivetOperation,
	type RivetSignedCapability,
} from "./distributed-auth.js";
import {
	encodeDistributedEvent,
	snapshotDistributedData,
} from "./distributed-journal.js";

const LEASE_MS = 30_000;
const MAX_PAGE = 16;

type LeaseInput = {
	readonly holderId: string;
	readonly requestId: string;
	readonly fenceToken: number;
};
type AcquireInput = { readonly holderId: string; readonly requestId: string };
type AppendInput = LeaseInput & {
	readonly expectedRevision: number;
	readonly eventId: string;
	readonly event: FoldEvent;
};
type ReadInput = {
	readonly afterRevision: number;
	readonly limit: number;
	readonly throughRevision?: number;
};
type AuthorizedInput<T> = {
	readonly args: T;
	readonly capability: RivetSignedCapability;
};
export type RivetJournalVerifier = (
	input: RivetOperation & { readonly capability: RivetSignedCapability },
) => Promise<RivetCapabilityClaims>;
type Head = {
	epoch: number;
	revision: number;
	holder: string | null;
	request: string | null;
	expires: number | null;
	lastNow: number;
};
type Row = Record<string, string | number | null>;

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- SAFETY: inputs and SQL rows cross the Rivet persistence boundary. */
function name(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}
function integer(value: string | number | null | undefined): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters */

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: SQL rows are untrusted persistent data. */
async function head(tx: RawAccess): Promise<Head> {
	const rows = await tx.execute<Row>(
		"SELECT epoch, revision, holder, request, expires, last_now AS lastNow FROM hobo_journal_head WHERE id=1",
	);
	const row = rows[0];
	if (
		rows.length !== 1 ||
		row === undefined ||
		!integer(row.epoch) ||
		!integer(row.revision) ||
		!integer(row.lastNow)
	)
		throw new Error("corrupt journal head");
	if (row.holder === null && row.request === null && row.expires === null)
		return {
			epoch: row.epoch,
			revision: row.revision,
			holder: null,
			request: null,
			expires: null,
			lastNow: row.lastNow,
		};
	if (
		typeof row.holder === "string" &&
		name(row.holder) &&
		typeof row.request === "string" &&
		name(row.request) &&
		integer(row.expires)
	)
		return {
			epoch: row.epoch,
			revision: row.revision,
			holder: row.holder,
			request: row.request,
			expires: row.expires,
			lastNow: row.lastNow,
		};
	throw new Error("corrupt journal lease");
}
/* oxlint-enable anti-slop/no-runtime-typeof */

type Result =
	| { status: "denied"; code: string }
	| { status: "uncertain"; code: string }
	| {
			status: "acquired";
			fenceToken: number;
			expiresAtMs: number;
			duplicate: boolean;
	  }
	| { status: "released" | "valid" }
	| { status: "appended"; revision: number; duplicate: boolean };

function denied(code: string) {
	return { status: "denied" as const, code };
}

async function transaction<T>(
	database: RawAccess,
	authorizedUntil: number,
	run: (tx: RawAccess, state: Head, now: number) => Promise<T>,
): Promise<T | { status: "denied" | "uncertain"; code: string }> {
	try {
		return await database.transaction(async (tx) => {
			const state = await head(tx);
			const now = Date.now();
			if (!Number.isSafeInteger(now) || now < 0 || now < state.lastNow)
				return denied("CLOCK_REGRESSION");
			if (now >= authorizedUntil) return denied("CAPABILITY_EXPIRED");
			if (now > state.lastNow)
				await tx.execute(
					"UPDATE hobo_journal_head SET last_now=? WHERE id=1",
					now,
				);
			return run(tx, state, now);
		});
	} catch {
		return { status: "uncertain", code: "PERSISTENCE_OUTCOME_UNKNOWN" };
	}
}

function live(state: Head, input: LeaseInput, now: number): boolean {
	return (
		name(input.holderId) &&
		name(input.requestId) &&
		Number.isSafeInteger(input.fenceToken) &&
		input.fenceToken > 0 &&
		state.holder === input.holderId &&
		state.request === input.requestId &&
		state.epoch === input.fenceToken &&
		state.expires !== null &&
		now < state.expires
	);
}

async function acquire(
	database: RawAccess,
	input: AcquireInput,
	authorizedUntil: number,
): Promise<Result> {
	if (!name(input.holderId) || !name(input.requestId))
		return denied("INVALID_INPUT");
	return transaction(database, authorizedUntil, async (tx, state, now) => {
		const existing = await tx.execute<Row>(
			"SELECT holder, token, expires FROM hobo_journal_grants WHERE request=?",
			input.requestId,
		);
		if (existing.length > 1) throw new Error("duplicate grant");
		const prior = existing[0];
		if (prior !== undefined) {
			if (prior.holder !== input.holderId) return denied("REQUEST_ID_CONFLICT");
			if (
				!integer(prior.token) ||
				!integer(prior.expires) ||
				state.request !== input.requestId ||
				state.epoch !== prior.token ||
				now >= prior.expires
			)
				return denied("LEASE_EXPIRED");
			return {
				status: "acquired",
				fenceToken: prior.token,
				expiresAtMs: prior.expires,
				duplicate: true,
			};
		}
		if (state.request !== null && state.expires !== null && now < state.expires)
			return denied("LEASE_HELD");
		if (
			state.epoch >= Number.MAX_SAFE_INTEGER ||
			now > Number.MAX_SAFE_INTEGER - LEASE_MS
		)
			return denied("CAPACITY_EXCEEDED");
		const token = state.epoch + 1;
		const expires = now + LEASE_MS;
		await tx.execute(
			"INSERT INTO hobo_journal_grants(request,holder,token,expires) VALUES(?,?,?,?)",
			input.requestId,
			input.holderId,
			token,
			expires,
		);
		await tx.execute(
			"UPDATE hobo_journal_head SET epoch=?,holder=?,request=?,expires=? WHERE id=1",
			token,
			input.holderId,
			input.requestId,
			expires,
		);
		return {
			status: "acquired",
			fenceToken: token,
			expiresAtMs: expires,
			duplicate: false,
		};
	});
}

async function leaseAction(
	database: RawAccess,
	input: LeaseInput,
	operation: "check" | "release",
	authorizedUntil: number,
): Promise<Result> {
	return transaction(database, authorizedUntil, async (tx, state, now) => {
		if (!live(state, input, now)) return denied("STALE_LEASE");
		if (operation === "check") return { status: "valid" };
		await tx.execute(
			"UPDATE hobo_journal_head SET holder=NULL,request=NULL,expires=NULL WHERE id=1",
		);
		return { status: "released" };
	});
}

async function append(
	database: RawAccess,
	input: AppendInput,
	authorizedUntil: number,
): Promise<Result> {
	if (
		!name(input.eventId) ||
		!Number.isSafeInteger(input.expectedRevision) ||
		input.expectedRevision < 0
	)
		return denied("INVALID_INPUT");
	const encoded = encodeDistributedEvent(input.event);
	if (encoded === undefined) return denied("INVALID_EVENT");
	return transaction(database, authorizedUntil, async (tx, state, now) => {
		if (!live(state, input, now)) return denied("STALE_LEASE");
		const previous = await tx.execute<Row>(
			"SELECT seq,expected_revision AS expectedRevision,event_json AS eventJson FROM hobo_journal_facts WHERE event_id=?",
			input.eventId,
		);
		if (previous.length > 1) throw new Error("duplicate event identity");
		const old = previous[0];
		if (old !== undefined) {
			if (!integer(old.seq) || old.seq < 1)
				throw new Error("corrupt event sequence");
			return old.expectedRevision === input.expectedRevision &&
				old.eventJson === encoded
				? { status: "appended", revision: old.seq, duplicate: true }
				: denied("EVENT_ID_CONFLICT");
		}
		if (input.expectedRevision !== state.revision)
			return denied("REVISION_CONFLICT");
		if (state.revision >= Number.MAX_SAFE_INTEGER)
			return denied("CAPACITY_EXCEEDED");
		const revision = state.revision + 1;
		await tx.execute(
			"INSERT INTO hobo_journal_facts(seq,event_id,expected_revision,event_json) VALUES(?,?,?,?)",
			revision,
			input.eventId,
			input.expectedRevision,
			encoded,
		);
		await tx.execute(
			"UPDATE hobo_journal_head SET revision=? WHERE id=1",
			revision,
		);
		return { status: "appended", revision, duplicate: false };
	});
}

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: SQL rows are untrusted persistent data. */
async function read(
	database: RawAccess,
	input: ReadInput,
	authorizedUntil: number,
) {
	if (
		!Number.isSafeInteger(input.afterRevision) ||
		input.afterRevision < 0 ||
		!Number.isSafeInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > MAX_PAGE ||
		(input.throughRevision !== undefined &&
			(!Number.isSafeInteger(input.throughRevision) ||
				input.throughRevision < input.afterRevision))
	)
		return denied("INVALID_INPUT");
	return transaction(database, authorizedUntil, async (tx, state) => {
		const through = input.throughRevision ?? state.revision;
		if (through > state.revision || input.afterRevision > through)
			return denied("REVISION_CONFLICT");
		const rows = await tx.execute<Row>(
			"SELECT seq,event_id AS eventId,event_json AS eventJson FROM hobo_journal_facts WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?",
			input.afterRevision,
			through,
			input.limit,
		);
		const events: { eventId: string; event: FoldEvent }[] = [];
		for (const [index, row] of rows.entries()) {
			if (
				row.seq !== input.afterRevision + index + 1 ||
				!name(row.eventId) ||
				typeof row.eventJson !== "string" ||
				row.eventJson.length > 32_768
			)
				throw new Error("corrupt journal event");
			// SAFETY: the row is parsed and compared with the canonical bounded event encoding.
			const event = JSON.parse(row.eventJson) as FoldEvent;
			if (encodeDistributedEvent(event) !== row.eventJson)
				throw new Error("corrupt journal event");
			events.push({ eventId: row.eventId, event });
		}
		if (rows.length < Math.min(input.limit, through - input.afterRevision))
			throw new Error("journal sequence gap");
		const nextRevision = input.afterRevision + events.length;
		return {
			status: "ok" as const,
			revision: through,
			nextRevision,
			hasMore: nextRevision < through,
			events,
		};
	});
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/** A RivetKit actor whose SQLite transaction owns leases, fences and facts. */
export function createRivetSqlJournalActor(
	verify: RivetJournalVerifier,
): AnyActorDefinition {
	if (!(verify instanceof Function))
		throw new TypeError("a Rivet capability verifier is required");
	const protect = async <T, R>(
		context: { readonly key: readonly string[] },
		action: RivetJournalAction,
		input: AuthorizedInput<T>,
		run: (args: T, authorizedUntil: number) => Promise<R>,
	): Promise<R | { status: "denied"; code: string }> => {
		const captured = snapshotDistributedData(input);
		if (captured === undefined) return denied("INVALID_INPUT");
		try {
			const actorKey = [...context.key];
			const operation = { actorKey, action, args: captured.args };
			const before = computeRivetOperationDigest(operation);
			const claims = await verify({
				...operation,
				capability: captured.capability,
			});
			if (
				before !== computeRivetOperationDigest(operation) ||
				!Number.isSafeInteger(claims.expiresAtMs) ||
				claims.expiresAtMs <= 0
			)
				return denied("UNAUTHORIZED");
			return run(captured.args, claims.expiresAtMs);
		} catch {
			return denied("UNAUTHORIZED");
		}
	};
	return actor({
		db: db({
			onMigrate: async (database) => {
				await database.execute(
					"CREATE TABLE IF NOT EXISTS hobo_journal_head(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,revision INTEGER NOT NULL,holder TEXT,request TEXT,expires INTEGER,last_now INTEGER NOT NULL)",
				);
				await database.execute(
					"INSERT OR IGNORE INTO hobo_journal_head(id,epoch,revision,last_now) VALUES(1,0,0,0)",
				);
				await database.execute(
					"CREATE TABLE IF NOT EXISTS hobo_journal_grants(request TEXT PRIMARY KEY,holder TEXT NOT NULL,token INTEGER NOT NULL UNIQUE,expires INTEGER NOT NULL)",
				);
				await database.execute(
					"CREATE TABLE IF NOT EXISTS hobo_journal_facts(seq INTEGER PRIMARY KEY,event_id TEXT NOT NULL UNIQUE,expected_revision INTEGER NOT NULL,event_json TEXT NOT NULL)",
				);
			},
		}),
		actions: {
			acquire: (context, input: AuthorizedInput<AcquireInput>) =>
				protect(context, "acquire", input, (args, until) =>
					acquire(
						context.db,
						{
							holderId: args.holderId,
							requestId: args.requestId,
						},
						until,
					),
				),
			check: (context, input: AuthorizedInput<LeaseInput>) =>
				protect(context, "check", input, (args, until) =>
					leaseAction(
						context.db,
						{
							holderId: args.holderId,
							requestId: args.requestId,
							fenceToken: args.fenceToken,
						},
						"check",
						until,
					),
				),
			release: (context, input: AuthorizedInput<LeaseInput>) =>
				protect(context, "release", input, (args, until) =>
					leaseAction(
						context.db,
						{
							holderId: args.holderId,
							requestId: args.requestId,
							fenceToken: args.fenceToken,
						},
						"release",
						until,
					),
				),
			append: (context, input: AuthorizedInput<AppendInput>) =>
				protect(context, "append", input, (args, until) =>
					append(
						context.db,
						{
							holderId: args.holderId,
							requestId: args.requestId,
							fenceToken: args.fenceToken,
							expectedRevision: args.expectedRevision,
							eventId: args.eventId,
							event: args.event,
						},
						until,
					),
				),
			read: (context, input: AuthorizedInput<ReadInput>) =>
				protect(context, "read", input, (args, until) =>
					read(
						context.db,
						args.throughRevision === undefined
							? { afterRevision: args.afterRevision, limit: args.limit }
							: {
									afterRevision: args.afterRevision,
									limit: args.limit,
									throughRevision: args.throughRevision,
								},
						until,
					),
				),
		},
	});
}
