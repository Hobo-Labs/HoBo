import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../src/nightly-cli.ts", import.meta.url));

it("runs a real seeded nightly campaign", () => {
	const child = spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--seed", "1742", "--runs", "10"],
		{
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			encoding: "utf8",
			timeout: 60_000,
		},
	);
	expect(child.status, child.stderr).toBe(0);
	expect(JSON.parse(child.stdout)).toEqual({
		seed: 1742,
		modelTraces: 10,
		eventDocuments: 10,
		policyDocuments: 10,
		serializedInputs: 10,
	});
});

it.each([
	["--runs", "0"],
	["--seed", "not-a-number"],
	["--unknown", "1"],
	["--runs"],
])("fails on invalid options", (...args) => {
	const child = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
		cwd: fileURLToPath(new URL("..", import.meta.url)),
		encoding: "utf8",
		timeout: 60_000,
	});
	expect(child.status).not.toBe(0);
	expect(child.stdout).toBe("");
});
