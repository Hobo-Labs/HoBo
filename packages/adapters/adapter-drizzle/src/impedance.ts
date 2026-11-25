/**
 * Impedance findings — the honest record of what a Drizzle schema module said
 * that the canonical schema IR cannot say back.
 *
 * ADR-0144 makes impedance a first-class output rather than a footnote: an
 * adapter that quietly drops a construct it does not understand is claiming a
 * fidelity it does not have. Every construct this adapter meets is either
 * represented in the IR or named here with a code and a detail string. There is
 * no third bucket, and ingestion never throws over an unrecognized construct —
 * a finding is the answer, not a failure.
 */

import { compareText } from "./order.js";

export const DRIZZLE_IMPEDANCE_CODES = Object.freeze([
	/** A column value in a table's column map was not column-shaped. */
	"DRIZZLE_COLUMN_UNRECOGNIZED",
	/** No readable SQL type on a column (no `getSQLType`, `columnType`, `dataType`). */
	"DRIZZLE_COLUMN_TYPE_UNREADABLE",
	/** A default exists but is not a literal the IR can carry (SQL expression, runtime fn). */
	"DRIZZLE_DEFAULT_UNREPRESENTABLE",
	/** A module export is not a Drizzle table (enum, relations helper, plain value, function). */
	"DRIZZLE_EXPORT_UNRECOGNIZED",
	/** A table's extra-config callback exists but its entries were not readable as indexes. */
	"DRIZZLE_EXTRA_CONFIG_UNREAD",
	/** Inline foreign keys are declared; the canonical IR has no foreign-key concept. */
	"DRIZZLE_FOREIGN_KEY_UNREAD",
	/** An index keys on a SQL expression; the IR indexes declared columns only, so the index was not ingested. */
	"DRIZZLE_INDEX_EXPRESSION_UNREPRESENTABLE",
	/** An index key has a non-default sort order, nulls order, or operator class; the index is ingested without it. */
	"DRIZZLE_INDEX_KEY_ORDER_UNREPRESENTABLE",
	/** An index has a `WHERE` predicate (partial index); the index is ingested without it. */
	"DRIZZLE_INDEX_PREDICATE_UNREPRESENTABLE",
	/** Columns carry a non-postgres dialect marker; this adapter ingests postgres only. */
	"DRIZZLE_NON_POSTGRES_TABLE",
	/** A table-shaped export yielded zero readable columns, so no table was emitted. */
	"DRIZZLE_TABLE_COLUMNS_EMPTY",
	/** Two exports resolve to the same SQL table name; the first (by export key) wins. */
	"DRIZZLE_TABLE_NAME_DUPLICATE",
	/** A table is bound to a non-default postgres schema; the IR has no schema qualifier. */
	"DRIZZLE_TABLE_SCHEMA_UNREPRESENTABLE",
	/** A view export was found; the IR models tables only. */
	"DRIZZLE_VIEW_UNREAD",
] as const);

export type DrizzleImpedanceCode = (typeof DRIZZLE_IMPEDANCE_CODES)[number];

export interface DrizzleImpedanceFinding {
	readonly code: DrizzleImpedanceCode;
	readonly detail: string;
}

/** Deterministic ordering: findings sort by `(code, detail)`, never by discovery order. */
export function sortImpedance(
	findings: readonly DrizzleImpedanceFinding[],
): readonly DrizzleImpedanceFinding[] {
	return Object.freeze(
		[...findings]
			.sort((left, right) =>
				left.code === right.code
					? compareText(left.detail, right.detail)
					: compareText(left.code, right.code),
			)
			.map((finding) => Object.freeze({ ...finding })),
	);
}
