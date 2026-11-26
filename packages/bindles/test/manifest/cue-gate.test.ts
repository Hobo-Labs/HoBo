import { execFileSync } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isJsonNumber } from "../../src/json.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, "../..");
const repoRoot = join(packageRoot, "../..");
const cueDir = join(packageRoot, "data-models/cue");
const cueSchemaFile = join(cueDir, "hobo_manifest_v1.cue");
const goldenDir = join(packageRoot, "test/fixtures/manifests/golden");
const invalidDir = join(packageRoot, "test/fixtures/manifests/invalid");

function resolveCueBinary(): string {
	const configured = process.env.HOBO_CUE_BIN;
	if (configured && existsSync(configured)) {
		return configured;
	}

	const cached = join(
		repoRoot,
		".tools",
		"cue",
		"v0.14.0",
		process.platform === "win32" ? "cue.exe" : "cue",
	);
	if (existsSync(cached)) {
		return cached;
	}

	try {
		const lookup = process.platform === "win32" ? "where.exe" : "which";
		return execFileSync(lookup, ["cue"], {
			encoding: "utf8",
			windowsHide: true,
		})
			.split(/\r?\n/u)[0]
			.trim();
	} catch {
		throw new Error(
			"CUE binary not found. Run root test:schema to populate .tools/cue/v0.14.0 or install cue v0.14.0 on PATH.",
		);
	}
}

function vetFixture(cueBin: string, fixturePath: string): number {
	try {
		execFileSync(
			cueBin,
			["vet", "-d", "#Manifest", basename(cueSchemaFile), resolve(fixturePath)],
			{
				cwd: cueDir,
				encoding: "utf8",
				stdio: "pipe",
				windowsHide: true,
			},
		);
		return 0;
	} catch (error) {
		// SAFETY: assertion required at this I/O or test boundary.
		const status = (error as NodeJS.ErrnoException & { status?: number })
			.status;
		return isJsonNumber(status) ? status : 1;
	}
}

describe("hobo.manifest/v1 CUE gate", () => {
	const cueBin = resolveCueBinary();

	for (const file of readdirSync(goldenDir).filter((name) =>
		name.endsWith(".json"),
	)) {
		it(`accepts golden fixture ${file}`, () => {
			expect(vetFixture(cueBin, join(goldenDir, file))).toBe(0);
		});
	}

	for (const file of readdirSync(invalidDir).filter((name) =>
		name.endsWith(".json"),
	)) {
		it(`rejects invalid fixture ${file}`, () => {
			expect(vetFixture(cueBin, join(invalidDir, file))).not.toBe(0);
		});
	}

	it("rejects corrupted golden fixture when db.port is removed", () => {
		const golden = JSON.parse(
			readFileSync(join(goldenDir, "db-api-site.json"), "utf8"),
		);
		delete golden.resources.db.port;
		const tempPath = join(
			packageRoot,
			"test/fixtures/manifests/invalid/.tmp-missing-port-runtime.json",
		);
		writeFileSync(tempPath, JSON.stringify(golden));
		try {
			expect(vetFixture(cueBin, tempPath)).not.toBe(0);
		} finally {
			if (existsSync(tempPath)) {
				unlinkSync(tempPath);
			}
		}
	});
});
