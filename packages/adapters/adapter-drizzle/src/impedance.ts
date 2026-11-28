import { compareText } from "./order.js";

export const DRIZZLE_IMPEDANCE_CODES = Object.freeze([
	"DRIZZLE_COLUMN_UNRECOGNIZED",
	"DRIZZLE_COLUMN_TYPE_UNREADABLE",
	"DRIZZLE_DEFAULT_UNREPRESENTABLE",
	"DRIZZLE_EXPORT_UNRECOGNIZED",
	"DRIZZLE_EXTRA_CONFIG_UNREAD",
	"DRIZZLE_FOREIGN_KEY_UNREAD",
	"DRIZZLE_INDEX_EXPRESSION_UNREPRESENTABLE",
	"DRIZZLE_INDEX_KEY_ORDER_UNREPRESENTABLE",
	"DRIZZLE_INDEX_PREDICATE_UNREPRESENTABLE",
	"DRIZZLE_NON_POSTGRES_TABLE",
	"DRIZZLE_TABLE_COLUMNS_EMPTY",
	"DRIZZLE_TABLE_NAME_DUPLICATE",
	"DRIZZLE_TABLE_SCHEMA_UNREPRESENTABLE",
	"DRIZZLE_VIEW_UNREAD",
] as const);

export type DrizzleImpedanceCode = (typeof DRIZZLE_IMPEDANCE_CODES)[number];

export interface DrizzleImpedanceFinding {
	readonly code: DrizzleImpedanceCode;
	readonly detail: string;
}

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
