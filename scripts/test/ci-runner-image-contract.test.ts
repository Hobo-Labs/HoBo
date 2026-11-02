import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertBaseDockerfileDigestPinned,
	assertTurboLockSidecarsPresent,
	CI_RUNNER_BASE_DOCKERFILE,
	CI_RUNNER_BUILD_SCRIPT,
	CI_RUNNER_PREFLIGHT_NODE_ARGS,
	CI_RUNNER_SYSTEM_PACKAGES,
	ciRunnerImageVersion,
	evaluateCiRunnerContract,
	MISE_LOCK,
	MISE_TOML,
	REQUIRED_COMMANDS,
	verifyBaseImageDigestResolves,
} from "../lib/ci-runner-contract.mts";

const root = join(import.meta.dirname, "..", "..");

describe("ci-runner image contract (repo manifests)", () => {
	it("pins mise.toml and mise.lock at repo root", () => {
		expect(existsSync(join(root, MISE_TOML))).toBe(true);
		expect(existsSync(join(root, MISE_LOCK))).toBe(true);
		const toml = readFileSync(join(root, MISE_TOML), "utf8");
		expect(toml).toContain("[oci]");
		expect(toml).toContain('user = "1000:1000"');
		expect(toml).toContain("gitleaks");
		expect(toml).toContain("127.0.0.1:5000");
	});

	it("declares system packages, base Dockerfile, and oci build script", () => {
		expect(existsSync(join(root, CI_RUNNER_BASE_DOCKERFILE))).toBe(true);
		expect(existsSync(join(root, CI_RUNNER_SYSTEM_PACKAGES))).toBe(true);
		expect(existsSync(join(root, CI_RUNNER_BUILD_SCRIPT))).toBe(true);
		const pkgList = readFileSync(join(root, CI_RUNNER_SYSTEM_PACKAGES), "utf8");
		for (const cmd of REQUIRED_COMMANDS) {
			if (cmd === "ps") expect(pkgList).toMatch(/procps/);
			if (cmd === "xz") expect(pkgList).toMatch(/xz-utils/);
			if (cmd === "docker") expect(pkgList).toMatch(/docker\.io/);
		}
	});

	it("pins a resolvable debian:bookworm-slim digest in the base Dockerfile", () => {
		expect(() => assertBaseDockerfileDigestPinned(root)).not.toThrow();
		if (process.env.HOBO_CI_VERIFY_BASE_DIGEST === "1") {
			const check = verifyBaseImageDigestResolves();
			expect(check.ok, check.detail).toBe(true);
		}
	});

	it("commits turbo lock sidecars referenced by mise.lock", () => {
		expect(() => assertTurboLockSidecarsPresent(root)).not.toThrow();
	});

	it("derives a stable image version tag from lock + base inputs", () => {
		const v = ciRunnerImageVersion(root);
		expect(v).toMatch(/^v[0-9a-f]{12}$/);
	});

	it("evaluates live toolchain contract when running inside the runner image", () => {
		if (process.env.HOBO_CI_RUNNER_CONTRACT !== "live") {
			return;
		}
		const checks = evaluateCiRunnerContract(root);
		const failed = checks.filter((c) => !c.ok);
		expect(failed, failed.map((f) => f.detail).join("; ")).toEqual([]);
	});
});

describe("ci-runner image contract (host smoke)", () => {
	it("documents required commands in system manifest", () => {
		const checks = evaluateCiRunnerContract(root);
		const names = new Set(checks.map((c) => c.name));
		for (const cmd of REQUIRED_COMMANDS) {
			expect(names.has(`system:${cmd}`)).toBe(true);
		}
	});

	it("preflight composite action does not depend on tsx", () => {
		const action = readFileSync(
			join(root, ".github/actions/ci-runner-preflight/action.yml"),
			"utf8",
		);
		expect(action).toContain(
			"node --no-warnings scripts/ci-runner-preflight.mts",
		);
		expect(action).not.toContain("tsx");
	});

	it("preflight runs with Node native TS only (no node_modules / tsx)", () => {
		const result = spawnSync(process.execPath, CI_RUNNER_PREFLIGHT_NODE_ARGS, {
			cwd: root,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				USER: process.env.USER ?? "",
				LANG: process.env.LANG ?? "C.UTF-8",
			},
			encoding: "utf8",
		});
		const combined = `${result.stdout}\n${result.stderr}`;
		expect(combined).not.toMatch(/ERR_MODULE_NOT_FOUND.*['"]tsx['"]/);
		expect(combined).not.toContain("--import tsx");
	});

	it("image version script runs without tsx", () => {
		const result = spawnSync(
			process.execPath,
			["--no-warnings", "scripts/ci-runner-image-version.mts"],
			{
				cwd: root,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: process.env.HOME ?? "",
					USER: process.env.USER ?? "",
					LANG: process.env.LANG ?? "C.UTF-8",
				},
				encoding: "utf8",
			},
		);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toMatch(/^v[0-9a-f]{12}$/);
		expect(`${result.stdout}${result.stderr}`).not.toContain("tsx");
	});
});
