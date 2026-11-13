/**
 * The assignment register's SQL replica: one backend's log in a table.
 *
 * The register itself (entries, majority, resolve, propose, bootstrap,
 * complete, override, membership epochs) is engine-neutral and lives in
 * `@hobo/fleet/assignment`. What stays here is how a PostgreSQL backend holds
 * its log: `readAssignmentRows`, `sqlAssignmentReplica`, whose `accept` is one
 * statement, and `sqlAssignmentRegister`.
 *
 * An entry's member set (written only once the fleet's policy sets
 * `membership_epochs`) is kept in the nullable `members` column, a sorted
 * `text[]`; an entry without one leaves it null, so the rows, and the
 * `assignmentKey` of each, are what they were before member sets existed.
 */
import {
	type AssignmentEntry,
	type AssignmentRegister,
	type AssignmentReplica,
	type MemberName,
	parseMemberName,
} from "@hobo/fleet";
import {
	assignmentKey,
	parseAssignmentEntry,
	parseAssignmentRegister,
} from "@hobo/fleet/assignment";
import { PostgresDataError } from "../errors.js";
import { FLEET_LOCK_CLASS, type FleetLayout } from "./layout.js";
import {
	classifyFleetFailure,
	column,
	optionalColumn,
	type PostgresBackend,
	parseCount,
	parseFlag,
	type SqlRow,
	type SqlSession,
	sqlState,
} from "./sql.js";

/** A `text[]` read back as text: `{a,b}`. Member names never need quoting. */
const MEMBER_ARRAY = /^\{[a-z0-9_-]+(?:,[a-z0-9_-]+)*\}$/u;

function membersFromColumn(
	value: string | undefined,
): readonly MemberName[] | undefined {
	if (value === undefined) return undefined;
	if (!MEMBER_ARRAY.test(value))
		throw new PostgresDataError(
			"FLEET_RECORD_INVALID",
			"members is not a list of member names",
			{ detail: { column: "members" } },
		);
	return value
		.slice(1, -1)
		.split(",")
		.map((name) => parseMemberName(name, "members"));
}

/** The `text[]` literal a member set is written as, or null for none. */
function membersToParameter(
	members: readonly MemberName[] | undefined,
): string | null {
	return members === undefined ? null : `{${members.join(",")}}`;
}

function assignmentFromRow(row: SqlRow): AssignmentEntry {
	const loss = optionalColumn(row, "loss_window_ms");
	const active = optionalColumn(row, "active");
	const target = optionalColumn(row, "target");
	return parseAssignmentEntry({
		epoch: parseCount(column(row, "epoch"), "epoch"),
		active:
			active === undefined ? undefined : parseMemberName(active, "active"),
		sealed: parseFlag(column(row, "sealed"), "sealed"),
		target:
			target === undefined ? undefined : parseMemberName(target, "target"),
		reason: column(row, "reason"),
		lossWindowMs: loss === undefined ? undefined : parseCount(loss, "loss"),
		decidedAtMs: parseCount(column(row, "decided_at_ms"), "decidedAtMs"),
		decidedBy: column(row, "decided_by"),
		members: membersFromColumn(optionalColumn(row, "members")),
	});
}

const SELECT_ASSIGNMENT = `epoch::text AS epoch, active, sealed::text AS sealed, target, reason,
	loss_window_ms::text AS loss_window_ms,
	round(extract(epoch FROM decided_at) * 1000)::bigint::text AS decided_at_ms, decided_by,
	members::text AS members`;

/**
 * Read one backend's log on a given session, newest `limit` entries, ascending.
 * A backend whose log table does not exist yet holds nothing.
 */
export async function readAssignmentRows(
	session: SqlSession,
	layout: FleetLayout,
	limit?: number,
): Promise<readonly AssignmentEntry[]> {
	try {
		const result = await session.query(
			`SELECT ${SELECT_ASSIGNMENT} FROM ${layout.assignmentTable} ORDER BY epoch DESC LIMIT $1::bigint`,
			[limit ?? 1_000_000],
		);
		return result.rows.map(assignmentFromRow).reverse();
	} catch (error) {
		if (sqlState(error instanceof Error ? error : undefined) === "42P01")
			return [];
		throw error;
	}
}

/**
 * The log of one backend, over its SQL executor.
 *
 * `accept` is one statement. It takes the fleet's shared advisory lock for the
 * statement's own transaction, so a copy into this backend (which holds the
 * exclusive form) and an entry arriving here can never interleave, and it
 * inserts only when the highest epoch held is exactly the one before.
 */
export function sqlAssignmentReplica(
	backend: PostgresBackend,
	layout: FleetLayout,
): AssignmentReplica {
	const table = layout.assignmentTable;
	const id = parseMemberName(backend.id, "backend");
	return {
		id,
		read: (limit) => readAssignmentRows(backend.executor, layout, limit),
		async accept(assignment) {
			const result = await backend.executor.query(
				`WITH gate AS (
					SELECT pg_try_advisory_xact_lock_shared($9::int, hashtext($10)) AS free
				), inserted AS (
					INSERT INTO ${table}
						(epoch, active, sealed, target, reason, loss_window_ms, decided_at, decided_by, members)
					SELECT $1::bigint, $2::text, $3::boolean, $4::text, $5::text, $6::bigint,
						timestamptz 'epoch' + $7::bigint * interval '1 millisecond', $8::text, $11::text[]
					FROM gate
					WHERE gate.free
						AND coalesce((SELECT max(epoch) FROM ${table}), 0) = $1::bigint - 1
					ON CONFLICT (epoch) DO NOTHING
					RETURNING epoch
				)
				SELECT gate.free::text AS free,
					(SELECT count(*) FROM inserted)::text AS inserted
				FROM gate`,
				[
					assignment.epoch,
					assignment.active ?? null,
					assignment.sealed,
					assignment.target ?? null,
					assignment.reason,
					assignment.lossWindowMs ?? null,
					assignment.decidedAtMs,
					assignment.decidedBy,
					FLEET_LOCK_CLASS,
					table,
					membersToParameter(assignment.members),
				],
			);
			const outcome = result.rows[0];
			if (outcome === undefined)
				throw new PostgresDataError(
					"FLEET_RECORD_INVALID",
					"assignment write returned no outcome",
				);
			if (!parseFlag(column(outcome, "free"), "free")) return "busy";
			if (column(outcome, "inserted") === "1") return "accepted";
			const held = await backend.executor.query(
				`SELECT ${SELECT_ASSIGNMENT} FROM ${table} WHERE epoch = $1::bigint`,
				[assignment.epoch],
			);
			const existing = held.rows[0];
			if (existing === undefined) return "gap";
			return assignmentKey(assignmentFromRow(existing)) ===
				assignmentKey(assignment)
				? "duplicate"
				: "conflict";
		},
	};
}

/** Build the register of a fleet from its backends, in configured order. */
export function sqlAssignmentRegister(
	backends: readonly PostgresBackend[],
	layout: FleetLayout,
): AssignmentRegister {
	return parseAssignmentRegister(
		backends.map((backend) => sqlAssignmentReplica(backend, layout)),
		{ classify: classifyFleetFailure },
	);
}
