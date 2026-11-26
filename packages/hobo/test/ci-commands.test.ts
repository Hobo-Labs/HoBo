import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELAY_CI_COMMANDS } from "@hobo/ci";
import { createHoboCli } from "@hobo/cli";
import { afterEach, describe, expect, it } from "vitest";
import { BUILT_IN_CI_COMMANDS, createCiCommand } from "../src/ci-command.js";
import {
	CI_COMMANDS,
	type CiCommand,
	type CiCommandContext,
	findCiCommand,
} from "../src/ci-commands.js";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

async function cliWith(commands: readonly CiCommand[]) {
	const home = await mkdtemp(join(tmpdir(), "hobo-ci-commands-"));
	directories.push(home);
	const seen: CiCommandContext[] = [];
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: { HOBO_HOME: home },
				now: () => 1_234,
				git: async (args) => {
					if (args[0] === "rev-parse") return home;
					return "git@github.com:octo/app.git";
				},
				commands: commands.map((command) => ({
					...command,
					run: async (context: CiCommandContext) => {
						seen.push(context);
						return command.run(context);
					},
				})),
			}),
		},
	});
	return { cli, home, seen };
}

const probe: CiCommand = {
	name: "probe",
	summary: "Answer with what the command was given.",
	run: async (context) => {
		const local = await context.localRepository(
			context.args.includes("--other") ? "octo/other" : undefined,
		);
		return {
			message: `probe ${context.args.join(" ")} in ${local.repository ?? "?"} at ${context.now()}`,
			data: { args: [...context.args], repository: local.repository },
		};
	},
};

describe("hobo ci command table", () => {
	it("dispatches a table entry with its own arguments", async () => {
		const { cli, home, seen } = await cliWith([probe]);
		const result = await cli.run(["ci", "probe", "one", "--other"], {
			cwd: home,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("probe one --other in octo/other at 1234");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.args).toEqual(["one", "--other"]);
		expect(seen[0]?.env.HOBO_HOME).toBe(home);
	});

	it("reads the repository from the origin remote when none is given", async () => {
		const { cli, home } = await cliWith([probe]);
		const result = await cli.run(["ci", "probe"], { cwd: home });
		expect(result.stdout).toContain("in octo/app");
	});

	it("never lets a table entry shadow a built-in command", async () => {
		const shadow: CiCommand = { ...probe, name: "route" };
		const { cli, home, seen } = await cliWith([shadow]);
		await cli.run(["ci", "route", "--github", "ubuntu-24.04"], { cwd: home });
		expect(seen).toEqual([]);
	});

	it("still refuses a name nothing handles", async () => {
		const { cli, home } = await cliWith([probe]);
		const result = await cli.run(["ci", "nothing-here"], { cwd: home });
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout + result.stderr).toContain("Unknown CI command");
	});

	it("finds an entry by name", () => {
		expect(findCiCommand("probe", [probe])).toBe(probe);
		expect(findCiCommand("probe")).toBeUndefined();
	});

	it("keeps every table name unique and apart from the built-ins", () => {
		const names = CI_COMMANDS.map((command) => command.name);
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) {
			expect(BUILT_IN_CI_COMMANDS).not.toContain(name);
			expect(RELAY_CI_COMMANDS).toContain(name);
		}
	});
});
