import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	assertSandboxWitBeforeComponentize,
	componentizeWitDirUnderWorkRoot,
	copyHostWitTreeIntoWorkRoot,
	witPathIsUnderWorkRoot,
} from "../lib/browser-wit-componentize-sandbox.mts";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const hostWitDir = path.join(repoRoot, "examples", "browser-runtime", "wit");

describe("browser WIT componentize sandbox (run 45546344117)", () => {
	it("repo wit path is outside a temp workRoot (WASI cannot preopen it)", () => {
		const workRoot = path.join(tmpdir(), "hobo-browser-wit-test");
		expect(witPathIsUnderWorkRoot(hostWitDir, workRoot)).toBe(false);
		expect(
			witPathIsUnderWorkRoot(
				componentizeWitDirUnderWorkRoot(workRoot),
				workRoot,
			),
		).toBe(true);
	});

	it("build script passes sandbox wit under workRoot, not host WIT_DIR", () => {
		const source = readFileSync(
			path.join(repoRoot, "site/scripts/build-browser-wit-runtime.mts"),
			"utf8",
		);
		expect(source).toMatch(/witPath:\s*sandboxWitDir/);
		expect(source).not.toMatch(/witPath:\s*WIT_DIR/);
		expect(source).toMatch(/copyHostWitTreeIntoWorkRoot/);
		expect(source).toMatch(/assertSandboxWitBeforeComponentize/);
	});

	it("copies host wit into workRoot and asserts before componentize", async () => {
		const workRoot = await mkdtemp(path.join(tmpdir(), "hobo-wit-sandbox-"));
		try {
			const sandbox = await copyHostWitTreeIntoWorkRoot(hostWitDir, workRoot);
			await assertSandboxWitBeforeComponentize(
				sandbox,
				workRoot,
				repoRoot,
				hostWitDir,
				"HEAD",
			);
			const station = await import("node:fs/promises").then((fs) =>
				fs.readFile(path.join(sandbox, "station.wit")),
			);
			expect(station.byteLength).toBeGreaterThan(0);
		} finally {
			await rm(workRoot, { recursive: true, force: true });
		}
	});

	it("rejects componentize witPath outside workRoot even when host tree exists", async () => {
		const workRoot = await mkdtemp(path.join(tmpdir(), "hobo-wit-sandbox-"));
		try {
			await expect(
				assertSandboxWitBeforeComponentize(
					hostWitDir,
					workRoot,
					repoRoot,
					hostWitDir,
					"HEAD",
				),
			).rejects.toThrow(/must live under workRoot/);
		} finally {
			await rm(workRoot, { recursive: true, force: true });
		}
	});

	it("rejects empty sandbox station.wit after a bad copy", async () => {
		const workRoot = await mkdtemp(path.join(tmpdir(), "hobo-wit-sandbox-"));
		try {
			const sandbox = componentizeWitDirUnderWorkRoot(workRoot);
			await mkdir(sandbox, { recursive: true });
			await writeFile(path.join(sandbox, "station.wit"), "");
			await expect(
				assertSandboxWitBeforeComponentize(
					sandbox,
					workRoot,
					repoRoot,
					hostWitDir,
					"HEAD",
				),
			).rejects.toThrow(/empty/);
		} finally {
			await rm(workRoot, { recursive: true, force: true });
		}
	});
});
