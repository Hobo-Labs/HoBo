/**
 * The optional flags on the pg_dump and pg_restore command lines.
 *
 * `migration.test.ts` covers the security half of argv construction — the fused
 * `--flag=value` form, the NUL/newline refusal, the credential-shaped-material
 * refusal, and the rule that a password only ever travels in the environment.
 * This covers the other half: which flags actually end up on the line, which is
 * what decides whether a migration moves the schema, the rows, or both.
 *
 * **Schema-only and data-only are mutually exclusive, and the refusal is the
 * point.** `pg_dump` given both produces an empty dump rather than an error, so
 * a migration built that way would report success and restore nothing. Catching
 * it here means the contradiction is reported against the spec that expressed
 * it rather than discovered when the restore comes up empty.
 *
 * **Absent is not false.** Every optional flag is spread on `=== true`, so a
 * spec that omits one contributes nothing to the line. That matters because
 * these are booleans arriving from callers and config: a flag emitted for any
 * truthy value would put `--data-only` on a line because someone wrote
 * `dataOnly: "no"`.
 *
 * **`--no-owner` travels with `--no-acl`.** They are one decision — restore
 * into a database whose ownership and grants differ from the source — and
 * emitting only one produces a restore that fails partway on permissions it
 * was told not to care about.
 */
import { describe, expect, it } from "vitest";

import type { JsonValue } from "../src/json.js";
import {
	buildPgDumpArgv,
	buildPgRestoreArgv,
	type PgDumpSpec,
	type PgRestoreSpec,
	type PostgresTarget,
} from "../src/migration.js";

const TARGET: PostgresTarget = {
	host: "db.example.neon.tech",
	port: 5432,
	username: "app",
	database: "appdb",
	sslMode: "require",
};

const DUMP: PgDumpSpec = {
	target: TARGET,
	format: "custom",
	filePath: "/tmp/dump.bin",
};

const dump = (over: Partial<PgDumpSpec> = {}) =>
	buildPgDumpArgv({ ...DUMP, ...over });

const restore = (over: Partial<PgRestoreSpec> = {}) =>
	buildPgRestoreArgv({ target: TARGET, filePath: "/tmp/dump.bin", ...over });

/** A dump spec as config delivers it: `dataOnly` may be any JSON value. */
function dumpFromConfig(dataOnly: JsonValue): readonly string[] {
	const spec: Omit<PgDumpSpec, "dataOnly"> & { readonly dataOnly: JsonValue } =
		{ ...DUMP, dataOnly };
	// SAFETY: deliberately outside the declared type. Specs arrive from callers
	// and config untyped, and the builder reads `=== true`, which is pinned here.
	return buildPgDumpArgv(spec as PgDumpSpec);
}

/** The message of the refusal, or a marker when there was none. */
function refusal(run: () => void): string {
	try {
		run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "no-refusal";
}

describe("choosing what pg_dump copies", () => {
	it("refuses a spec that asks for schema-only and data-only at once", () => {
		// pg_dump given both produces an empty dump rather than an error, so a
		// migration built this way reports success and restores nothing.
		expect(refusal(() => dump({ schemaOnly: true, dataOnly: true }))).toMatch(
			/cannot be both schema-only and data-only/u,
		);
	});

	it("emits --schema-only alone", () => {
		const argv = dump({ schemaOnly: true });
		expect(argv).toContain("--schema-only");
		expect(argv).not.toContain("--data-only");
	});

	it("emits --data-only alone", () => {
		const argv = dump({ dataOnly: true });
		expect(argv).toContain("--data-only");
		expect(argv).not.toContain("--schema-only");
	});

	it("emits neither when the spec asks for a full dump", () => {
		// The default is everything; a flag appearing here would silently narrow
		// what a plain migration copies.
		const argv = dump();
		expect(argv).not.toContain("--schema-only");
		expect(argv).not.toContain("--data-only");
	});

	it("treats a non-boolean as absent rather than as true", () => {
		// `=== true`, not truthiness. These arrive from callers and config, and a
		// flag emitted for `"no"` would drop every row from the dump.
		const notTrue: JsonValue[] = ["true", 1, {}, "no"];
		for (const value of notTrue) {
			expect(dumpFromConfig(value)).not.toContain("--data-only");
		}
	});
});

describe("ownership and grants", () => {
	it("emits --no-owner together with --no-acl on a dump", () => {
		// One decision, two flags. Emitting only one produces a restore that
		// fails partway on permissions it was told not to care about.
		const argv = dump({ noOwner: true });
		expect(argv).toContain("--no-owner");
		expect(argv).toContain("--no-acl");
	});

	it("emits neither when ownership is to be preserved", () => {
		const argv = dump();
		expect(argv).not.toContain("--no-owner");
		expect(argv).not.toContain("--no-acl");
	});

	it("applies the same pairing on a restore", () => {
		const argv = restore({ noOwner: true });
		expect(argv).toContain("--no-owner");
		expect(argv).toContain("--no-acl");
	});
});

describe("restoring over an existing database", () => {
	it("emits --clean together with --if-exists", () => {
		// `--clean` alone fails on the first object that is not there, which is
		// the normal case for a restore into a fresh database.
		const argv = restore({ cleanFirst: true });
		expect(argv).toContain("--clean");
		expect(argv).toContain("--if-exists");
	});

	it("emits neither by default", () => {
		// Dropping objects is not something a restore should do unasked.
		const argv = restore();
		expect(argv).not.toContain("--clean");
		expect(argv).not.toContain("--if-exists");
	});
});

describe("which binary is invoked", () => {
	it("defaults to the tool's usual name", () => {
		expect(dump()[0]).toBe("pg_dump");
		expect(restore()[0]).toBe("pg_restore");
	});

	it("honours an explicit path", () => {
		// Callers pin a version-matched binary; PostgreSQL's dump format is not
		// forward-compatible, so the one on PATH is not always the right one.
		expect(dump({ binary: "/usr/lib/postgresql/16/bin/pg_dump" })[0]).toBe(
			"/usr/lib/postgresql/16/bin/pg_dump",
		);
		expect(
			restore({ binary: "/usr/lib/postgresql/16/bin/pg_restore" })[0],
		).toBe("/usr/lib/postgresql/16/bin/pg_restore");
	});

	it("puts the binary first and nothing before it", () => {
		expect(dump().indexOf("pg_dump")).toBe(0);
	});
});

describe("where the file goes on each line", () => {
	it("passes the dump file as a fused flag on pg_dump", () => {
		// Fused, so a path beginning with a dash can never be re-read as a flag.
		expect(dump({ filePath: "/tmp/out.bin" })).toContain("--file=/tmp/out.bin");
	});

	it("passes the dump file as the trailing operand on pg_restore", () => {
		// pg_restore takes it positionally rather than as --file, and it has to be
		// last or it would be consumed as a flag's value.
		const argv = restore({ filePath: "/tmp/in.bin" });
		expect(argv[argv.length - 1]).toBe("/tmp/in.bin");
	});

	it("names the connection the same way on both tools", () => {
		// The two lines are built from one target; a divergence here would dump
		// from one database and restore into another.
		for (const argv of [dump(), restore()]) {
			expect(argv).toContain(`--host=${TARGET.host}`);
			expect(argv).toContain(`--dbname=${TARGET.database}`);
			expect(argv).toContain(`--username=${TARGET.username}`);
			expect(argv).toContain("--no-password");
		}
	});
});
