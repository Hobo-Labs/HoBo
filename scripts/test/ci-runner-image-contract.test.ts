import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
	CI_RUNNER_BASE_DOCKERFILE,
	CI_RUNNER_BUILD_SCRIPT,
	CI_RUNNER_SYSTEM_PACKAGES,
	MISE_LOCK,
	MISE_TOML,
	ciRunnerImageVersion,
	evaluateCiRunnerContract,
	REQUIRED_COMMANDS,
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
});
