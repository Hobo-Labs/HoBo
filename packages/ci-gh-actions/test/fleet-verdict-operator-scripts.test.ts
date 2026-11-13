import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The operator script of plan 0025, step G3 (G2's reporter enrollment retired with plan 0026, 3.9). */
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
