import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { schemathesisAvailable } from "../src/env.js";

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

it("accepts the package-manager argument separator", () => {
	const child = spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--", "--seed", "1742", "--runs", "2"],
		{
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			encoding: "utf8",
			timeout: 60_000,
		},
	);
	expect(child.status, child.stderr).toBe(0);
	expect(JSON.parse(child.stdout).modelTraces).toBe(2);
});

it("fails if the requested API fuzzer is unavailable", () => {
	const child = spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--runs", "1", "--api"],
		{
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			encoding: "utf8",
			timeout: 60_000,
			env: { PATH: "", LANG: "C.UTF-8" },
		},
	);
	expect(child.status).not.toBe(0);
	expect(child.stderr).toContain("schemathesis executable unavailable");
	expect(child.stdout).toBe("");
});

it.skipIf(!schemathesisAvailable())(
	"runs the API campaign from the CLI",
	() => {
		const child = spawnSync(
			process.execPath,
			["--import", "tsx", cli, "--runs", "1", "--seed", "1742", "--api"],
			{
				cwd: fileURLToPath(new URL("..", import.meta.url)),
				encoding: "utf8",
				timeout: 60_000,
			},
		);
		expect(child.status, child.stderr).toBe(0);
		const result = JSON.parse(child.stdout);
		expect(result.api.ran).toBe(true);
		expect(result.api.passed).toBe(true);
		expect(result.api.requests).toBeGreaterThan(0);
	},
	60_000,
);
