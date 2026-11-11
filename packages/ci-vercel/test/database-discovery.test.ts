import { describe, expect, it } from "vitest";
import { discoverDatabases } from "../src/database-discovery.js";

const neon = "postgres://u:p@ep-one.neon.tech/neondb";
const neonDirect = "postgres://u:p@ep-one-direct.neon.tech/neondb";
const supabase = "postgres://u:p@aws-0.pooler.supabase.com:6543/postgres";
const supabaseDirect = "postgres://u:p@db.abc.supabase.co:5432/postgres";

describe("discoverDatabases", () => {
	it("finds nothing in an environment that names no database", () => {
		expect(discoverDatabases({ PATH: "/bin" })).toEqual([]);
	});

	it("lists one database once when an integration injects it under two names", () => {
		const found = discoverDatabases({
			DATABASE_URL: neon,
			DATABASE_URL_UNPOOLED: neonDirect,
			POSTGRES_URL: neon,
			POSTGRES_URL_NON_POOLING: neonDirect,
		});
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({
			prefix: "",
			binding: "explicit",
			primaryName: "DATABASE_URL",
			directName: "DATABASE_URL_UNPOOLED",
			hasDirect: true,
		});
	});

	it("finds a second store connected under a prefix, unprefixed first", () => {
		const found = discoverDatabases({
			DATABASE_URL: neon,
			DATABASE_URL_UNPOOLED: neonDirect,
			SUPABASE_POSTGRES_URL: supabase,
			SUPABASE_POSTGRES_URL_NON_POOLING: supabaseDirect,
		});
		expect(found.map((entry) => [entry.prefix, entry.binding])).toEqual([
			["", "explicit"],
			["SUPABASE_", "supabase"],
		]);
		expect(found[0]?.database).not.toBe(found[1]?.database);
	});

	it("never carries a connection string, host or credential", () => {
		const text = JSON.stringify(
			discoverDatabases({
				SUPABASE_POSTGRES_URL: supabase,
				SUPABASE_POSTGRES_URL_NON_POOLING: supabaseDirect,
			}),
		);
		expect(text).not.toContain("supabase.co");
		expect(text).not.toContain("pooler");
		expect(text).not.toContain("u:p");
	});

	it("skips a prefix whose variables are not a PostgreSQL address", () => {
		expect(
			discoverDatabases({ OTHER_DATABASE_URL: "mysql://u:p@h/db" }),
		).toEqual([]);
	});
});
