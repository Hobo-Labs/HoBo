import {
	bigserial,
	integer,
	pgTable,
	serial,
	smallserial,
} from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { ingestDrizzleSchema } from "../src/index.js";

describe("Drizzle serial columns", () => {
	it("represents implicit sequence defaults through their PostgreSQL types", () => {
		const counters = pgTable("counters", {
			id: serial().primaryKey(),
			small: smallserial(),
			bigNumber: bigserial({ mode: "number" }),
			bigInt: bigserial({ mode: "bigint" }),
			fixed: integer().default(7),
		});
		const result = ingestDrizzleSchema({ counters });
		expect(result.impedance).toEqual([]);
		const columns = result.schema.tables[0]?.columns;
		expect(columns?.map((column) => [column.name, column.type])).toEqual([
			["bigInt", "bigserial"],
			["bigNumber", "bigserial"],
			["fixed", "integer"],
			["id", "serial"],
			["small", "smallserial"],
		]);
		expect(columns?.find((column) => column.name === "id")).toMatchObject({
			primaryKey: true,
			nullable: false,
		});
		expect(columns?.find((column) => column.name === "fixed")).toMatchObject({
			defaultExpression: "7",
		});
	});

	it("reports runtime default functions even on serial columns", () => {
		const counters = pgTable("counters", {
			id: serial().$defaultFn(() => 42),
		});
		const result = ingestDrizzleSchema({ counters });
		expect(result.impedance.map((finding) => finding.code)).toContain(
			"DRIZZLE_DEFAULT_UNREPRESENTABLE",
		);
	});
});
