import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createHoboCli } from "../src/shell/dispatch.js";
import { UsageError } from "../src/shell/errors.js";
import { parseArgv } from "../src/shell/parse.js";
import { VERB_SUBCOMMANDS } from "../src/shell/subcommands.js";
import { projectScopedVerbs } from "../src/shell/verbs.js";

/**
 * `hobo deploy`, `hobo incident` and `hobo serve cd` subcommands declare their
 * own flags (packages/hobo/CD.md). The shell accepts exactly the flags the
 * resolved subcommand declares, typed (a value or a switch), and refuses any
 * other with the same `Unknown option` usage error as every other verb.
 */
describe("subcommand-declared options", () => {
	it("accepts the flags a deploy subcommand declares, typed", () => {
		const parsed = parseArgv([
			"deploy",
			"freight",
			"record",
			"--file",
			"manifest.json",
			"--format",
			"json",
			"--simulate",
		]);
		expect(parsed.verb).toBe("deploy");
		expect(parsed.args).toEqual(["freight", "record"]);
		expect(parsed.flags.subcommandOptions.file).toBe("manifest.json");
		expect(parsed.flags.subcommandOptions.format).toBe("json");
		expect(parsed.flags.subcommandOptions.simulate).toBe(true);
	});

	it("accepts declared flags before the subcommand words", () => {
		const parsed = parseArgv([
			"deploy",
			"--simulate",
			"agent",
			"token",
			"--camp-set",
			"hobo-ci-runner-fleet",
			"--camp",
			"hobo-ci-runners/box",
		]);
		expect(parsed.args).toEqual(["agent", "token"]);
		expect(parsed.flags.subcommandOptions["camp-set"]).toBe(
			"hobo-ci-runner-fleet",
		);
		expect(parsed.flags.subcommandOptions.camp).toBe("hobo-ci-runners/box");
	});

	it("accepts --name=value for a declared value flag", () => {
		const parsed = parseArgv(["deploy", "status", "--format=json"]);
		expect(parsed.flags.subcommandOptions.format).toBe("json");
	});

	it("refuses a flag the resolved subcommand does not declare", () => {
		// `--file` is a deploy flag, but `freight list` takes none.
		expect(() =>
			parseArgv(["deploy", "freight", "list", "--file", "x.json"]),
		).toThrow(/Unknown option "--file"/);
		expect(() =>
			parseArgv(["deploy", "freight", "list", "--file", "x.json"]),
		).toThrow(UsageError);
	});

	it("refuses shell flags a strict verb does not declare", () => {
		// `--force` is a shell flag for other verbs; deploy never takes it.
		expect(() => parseArgv(["deploy", "status", "--force"])).toThrow(
			/Unknown option "--force"/,
		);
		expect(() => parseArgv(["deploy", "status", "--bogus"])).toThrow(
			/Unknown option "--bogus"/,
		);
	});

	it("keeps the shell's global flags on strict verbs", () => {
		const parsed = parseArgv([
			"deploy",
			"camp",
			"list",
			"--json",
			"--cwd",
			".",
			"-q",
		]);
		expect(parsed.flags.json).toBe(true);
		expect(parsed.flags.quiet).toBe(true);
		expect(parsed.cwd).toBe(path.resolve("."));
	});

	it("requires a value for a declared value flag", () => {
		expect(() => parseArgv(["deploy", "pipeline", "apply", "--file"])).toThrow(
			/requires a value/,
		);
	});

	it("resolves incident's default subcommand and its flags", () => {
		const open = parseArgv([
			"incident",
			"open",
			"--camp",
			"edge/prod",
			"--signal",
			"slo-burn",
		]);
		expect(open.flags.subcommandOptions.signal).toBe("slo-burn");
		expect(() => parseArgv(["incident", "--signal", "x"])).toThrow(
			/Unknown option "--signal"/,
		);
	});

	it("scopes --simulate to serve cd, not serve control", () => {
		const cd = parseArgv([
			"serve",
			"cd",
			"--port",
			"8791",
			"--host",
			"127.0.0.1",
			"--simulate",
		]);
		expect(cd.flags.subcommandOptions.simulate).toBe(true);
		expect(cd.flags.port).toBe("8791");
		expect(() => parseArgv(["serve", "control", "--simulate"])).toThrow(
			/Unknown option "--simulate"/,
		);
		expect(() => parseArgv(["serve", "--simulate"])).toThrow(
			/Unknown option "--simulate"/,
		);
	});

	it("declares every option a subcommand lists", () => {
		for (const [verb, table] of VERB_SUBCOMMANDS) {
			for (const name of table.common)
				expect(table.options.has(name), `${verb} --${name}`).toBe(true);
			for (const [sub, names] of table.subcommands)
				for (const name of names)
					expect(table.options.has(name), `${verb} ${sub} --${name}`).toBe(
						true,
					);
		}
	});

	it("runs deploy, incident and serve outside a Bindle project", async () => {
		for (const verb of ["deploy", "incident", "serve"])
			expect(projectScopedVerbs.has(verb), verb).toBe(false);
		const dir = await mkdtemp(path.join(tmpdir(), "hobo-cli-cd-"));
		try {
			const seen: string[] = [];
			const cli = createHoboCli({
				commands: {
					deploy: {
						run: async ({ args, flags }) => {
							seen.push(
								`${args.join(" ")} ${String(flags.subcommandOptions?.campset)}`,
							);
							return { ok: true, message: "listed" };
						},
					},
				},
			});
			const result = await cli.run(
				["deploy", "camp", "list", "--campset", "hobo-ci-runner-fleet"],
				{ cwd: dir },
			);
			expect(result.exitCode).toBe(0);
			expect(seen).toEqual(["camp list hobo-ci-runner-fleet"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
