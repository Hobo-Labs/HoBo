import { sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { ingestDrizzleSchema } from "../src/index.js";

it("reports generated and identity columns from real Drizzle builders", () => {
	const items = pgTable("items", {
		id: integer("id").generatedAlwaysAsIdentity(),
		name: text("name"),
		sequence: integer("sequence").generatedByDefaultAsIdentity(),
		slug: text("slug").generatedAlwaysAs(sql`lower(name)`),
	});
	const result = ingestDrizzleSchema({ items });
	expect(result.schema.tables[0]?.columns.map((column) => column.name)).toEqual(
		["id", "name", "sequence", "slug"],
	);
	expect(result.impedance).toEqual([
		{
			code: "DRIZZLE_COLUMN_GENERATED_UNREPRESENTABLE",
			detail:
				'Column "slug" of table "items" is generated; the canonical IR carries its type but not its generation expression.',
		},
		{
			code: "DRIZZLE_COLUMN_IDENTITY_UNREPRESENTABLE",
			detail:
				'Column "id" of table "items" is an identity column; the canonical IR carries its type but not its identity generation.',
		},
		{
			code: "DRIZZLE_COLUMN_IDENTITY_UNREPRESENTABLE",
			detail:
				'Column "sequence" of table "items" is an identity column; the canonical IR carries its type but not its identity generation.',
		},
	]);
	expect(ingestDrizzleSchema({ items })).toEqual(result);
});
