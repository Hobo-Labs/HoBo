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
			env: {
				PATH: process.env.PATH ?? "",
				LANG: "C.UTF-8",
				HOBO_FUZZ_DOCKER: "0",
			},
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
		env: {
			PATH: process.env.PATH ?? "",
			LANG: "C.UTF-8",
			HOBO_FUZZ_DOCKER: "0",
		},
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
			env: {
				PATH: process.env.PATH ?? "",
				LANG: "C.UTF-8",
				HOBO_FUZZ_DOCKER: "0",
			},
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
			env: { PATH: "", LANG: "C.UTF-8", HOBO_FUZZ_DOCKER: "0" },
		},
	);
	expect(child.status).not.toBe(0);
	expect(child.stderr).toContain("schemathesis executable unavailable");
	expect(child.stdout).toBe("");
});

it("allows a model-only campaign without Docker", () => {
	const child = spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--runs", "1", "--no-docker"],
		{
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" },
			timeout: 60_000,
		},
	);
	expect(child.status, child.stderr).toBe(0);
	expect(JSON.parse(child.stdout).modelTraces).toBe(1);
	expect(JSON.parse(child.stdout).docker).toBeUndefined();
});

it("fails when Docker is required and unavailable", () => {
	const child = spawnSync(
		process.execPath,
		["--import", "tsx", cli, "--runs", "1", "--docker"],
		{
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			encoding: "utf8",
			env: { PATH: "", LANG: "C.UTF-8", HOBO_FUZZ_DOCKER: "0" },
			timeout: 60_000,
		},
	);
	expect(child.status).not.toBe(0);
	expect(child.stderr).toContain("docker");
	expect(child.stdout).toBe("");
});
