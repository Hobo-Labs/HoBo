import { index, integer, pgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { ingestDrizzleSchema } from "../src/index.js";

describe("Drizzle index options", () => {
	it("reports options that cannot be represented while preserving index columns", () => {
		const items = pgTable("items", { id: integer("id") }, (table) => [
			index("plain_idx").on(table.id),
			index("custom_idx")
				.using("gin", table.id)
				.with({ fillfactor: 75 })
				.concurrently(),
			index("only_idx").onOnly(table.id),
		]);

		const result = ingestDrizzleSchema({ items });
		expect(result.schema.tables[0]?.indexes).toEqual([
			{ name: "custom_idx", columns: ["id"], unique: false },
			{ name: "only_idx", columns: ["id"], unique: false },
			{ name: "plain_idx", columns: ["id"], unique: false },
		]);
		expect(result.impedance).toEqual([
			{
				code: "DRIZZLE_INDEX_OPTIONS_UNREPRESENTABLE",
				detail:
					'Index "custom_idx" of table "items" uses USING gin, storage parameters, CONCURRENTLY, ONLY; the canonical IR carries the columns but not these options.',
			},
			{
				code: "DRIZZLE_INDEX_OPTIONS_UNREPRESENTABLE",
				detail:
					'Index "only_idx" of table "items" uses ONLY; the canonical IR carries the columns but not these options.',
			},
		]);
		expect(ingestDrizzleSchema({ items })).toEqual(result);
	});
});
