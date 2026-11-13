import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { parseFleetReporters } from "../src/fleet-verdict.js";

/** The operator scripts of plan 0025, steps G2 and G3. */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(script: string, args: readonly string[]) {
	const result = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"--no-warnings",
			join(packageRoot, "scripts", script),
			...args,
		],
		{
			cwd: packageRoot,
			encoding: "utf8",
			env: { ...process.env, NODE_OPTIONS: "" },
		},
	);
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function directory() {
	const created = mkdtempSync(join(tmpdir(), "hobo-fleet-scripts-"));
	onTestFinished(() => rmSync(created, { recursive: true, force: true }));
	return created;
}

describe("fleet-reporter-enroll.mts", { timeout: 60_000 }, () => {
	it("prints an enrollment entry the hosted relay accepts, with the public key only", () => {
		const keys = join(directory(), "keys");
		const keyFile = join(keys, "mesh-node.key");
		const args = [
			"--key-file",
			keyFile,
			"--id",
			"box-1",
			"--account",
			"tenant",
			"--labels",
			"hobo, HoBo-Trunk",
		];
		const first = run("fleet-reporter-enroll.mts", args);
		expect(first.stderr).toBe("");
		expect(first.status).toBe(0);
		const entry = z
			.object({
				id: z.literal("box-1"),
				publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
				accountId: z.literal("tenant"),
				labels: z.tuple([z.literal("hobo"), z.literal("hobo-trunk")]),
			})
			.strict()
			.parse(JSON.parse(first.stdout));
		expect(first.stdout.trim().split("\n")).toHaveLength(1);
		expect(first.stdout).not.toMatch(/PRIVATE KEY/u);
		expect(statSync(keyFile).mode & 0o077).toBe(0);
		// The same key, the same entry: it reads the key it made.
		expect(run("fleet-reporter-enroll.mts", args).stdout).toBe(first.stdout);
		expect(
			parseFleetReporters(JSON.stringify({ reporters: [entry] })),
		).toBeDefined();
	});

	it.each([
		[[], /--key-file is required/u],
		[
			[
				"--key-file",
				"k",
				"--id",
				"box 1",
				"--account",
				"a",
				"--labels",
				"hobo",
			],
			/--id/u,
		],
		[
			["--key-file", "k", "--id", "box-1", "--account", "", "--labels", "hobo"],
			/--account/u,
		],
		[
			["--key-file", "k", "--id", "box-1", "--account", "a", "--labels", ","],
			/--labels/u,
		],
		[
			[
				"--key-file",
				"k",
				"--id",
				"box-1",
				"--account",
				"a",
				"--labels",
				"hobo",
				"--extra",
			],
			/usage/u,
		],
	])("refuses %j with its usage", (args, message) => {
		const result = run("fleet-reporter-enroll.mts", args);
		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(message);
		expect(result.stderr).toMatch(/usage: fleet-reporter-enroll\.mts/u);
	});
});

describe("hold-memory.mts", { timeout: 60_000 }, () => {
	it("holds the memory it was asked for, says so, and lets go", () => {
		const result = run("hold-memory.mts", ["--mb", "80", "--seconds", "0"]);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		const [held, released, ...rest] = result.stdout.trim().split("\n");
		expect(rest).toEqual([]);
		expect(JSON.parse(held ?? "")).toMatchObject({
			event: "hold_memory_held",
			mb: 80,
			seconds: 0,
		});
		expect(JSON.parse(released ?? "")).toMatchObject({
			event: "hold_memory_released",
			mb: 80,
		});
	});

	it.each([
		[[], /--mb/u],
		[["--mb", "0", "--seconds", "1"], /--mb must be between/u],
		[["--mb", "64", "--seconds", "-1"], /--seconds/u],
		[["--mb", "64", "--seconds", "ten"], /--seconds must be a whole number/u],
		[["--mb", "64", "--seconds", "1", "--now"], /usage/u],
	])("refuses %j with its usage", (args, message) => {
		const result = run("hold-memory.mts", args);
		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(message);
		expect(result.stderr).toMatch(/usage: hold-memory\.mts/u);
	});
});
