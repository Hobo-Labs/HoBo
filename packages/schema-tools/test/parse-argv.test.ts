import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCodegenArgv, resolveFromModule } from "../src/parse.js";
import {
	makeTempRepo,
	REPO_ROOT,
	removeTempRepo,
} from "./support/temp-workspace.js";

describe("parseCodegenArgv defaults", () => {
	it("parses an empty argv into a frozen write-mode invocation", () => {
		const invocation = parseCodegenArgv([], REPO_ROOT);
		expect(invocation.check).toBe(false);
		expect(invocation.json).toBe(false);
		expect(invocation.filter).toBeUndefined();
		expect(invocation.repoRoot).toBe(join(REPO_ROOT).replace(/[\\/]+$/, ""));
		expect(invocation.bufTemplate).toBe(
			join(invocation.repoRoot, "buf.gen.yaml"),
		);
		expect(Object.isFrozen(invocation)).toBe(true);
	});

	it("chooses the production packages/ root when @hobo/schema-tools is promoted", () => {
		const invocation = parseCodegenArgv([], REPO_ROOT);
		expect(invocation.packagesRoot).toBe(join(invocation.repoRoot, "packages"));
	});

	it("falls back to <repo>/packages for a bare directory without the draft POC", async () => {
		const root = await makeTempRepo({
			withBufTemplate: false,
			withCueCache: false,
		});
		try {
			const invocation = parseCodegenArgv([], root);
			expect(invocation.packagesRoot).toBe(
				join(invocation.repoRoot, "packages"),
			);
		} finally {
			await removeTempRepo(root);
		}
	});
});

describe("parseCodegenArgv flags", () => {
	it("recognizes --check and --json independently and together", () => {
		expect(parseCodegenArgv(["--check"], REPO_ROOT).check).toBe(true);
		expect(parseCodegenArgv(["--check"], REPO_ROOT).json).toBe(false);
		expect(parseCodegenArgv(["--json"], REPO_ROOT).json).toBe(true);
		expect(parseCodegenArgv(["--json"], REPO_ROOT).check).toBe(false);
		const both = parseCodegenArgv(["--check", "--json"], REPO_ROOT);
		expect(both.check).toBe(true);
		expect(both.json).toBe(true);
	});

	it("resolves --filter relative to the repo root", () => {
		const invocation = parseCodegenArgv(
			["--filter", "packages/core"],
			REPO_ROOT,
		);
		expect(invocation.filter).toBe(join(REPO_ROOT, "packages", "core"));
	});

	it("resolves an explicit package discovery root", () => {
		const invocation = parseCodegenArgv(
			["--packages-root", ".", "--filter", "site"],
			REPO_ROOT,
		);
		expect(invocation.packagesRoot).toBe(resolve(REPO_ROOT));
		expect(invocation.filter).toBe(join(REPO_ROOT, "site"));
	});

	it("rejects --filter without a value", () => {
		expect(() => parseCodegenArgv(["--filter"], REPO_ROOT)).toThrow(
			/missing value for --filter/,
		);
	});

	it("rejects --packages-root without a value", () => {
		expect(() => parseCodegenArgv(["--packages-root"], REPO_ROOT)).toThrow(
			/missing value for --packages-root/,
		);
	});

	it("rejects --filter whose value looks like another flag", () => {
		expect(() => parseCodegenArgv(["--filter", "--json"], REPO_ROOT)).toThrow(
			/missing value for --filter/,
		);
	});

	it("rejects unknown flags", () => {
		expect(() => parseCodegenArgv(["--frobnicate"], REPO_ROOT)).toThrow(
			"unknown flag: --frobnicate",
		);
	});

	it("rejects stray positional arguments", () => {
		expect(() => parseCodegenArgv(["extra"], REPO_ROOT)).toThrow(
			"unexpected argument: extra",
		);
	});
});

describe("resolveFromModule", () => {
	it("maps a file URL back to a filesystem path", () => {
		const path = resolveFromModule(import.meta.url);
		expect(path.endsWith("parse-argv.test.ts")).toBe(true);
		expect(path.startsWith("file:")).toBe(false);
	});
});
