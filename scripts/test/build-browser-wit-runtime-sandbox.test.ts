import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	assertGuestSourceUnderWorkRoot,
	assertSandboxWitBeforeComponentize,
	BROWSER_WIT_GUEST_SOURCE_NAME,
	componentizeWitDirUnderWorkRoot,
	copyHostWitTreeIntoWorkRoot,
	guestSourcePathInWorkRoot,
	resolveComponentizeHostWitPath,
	witPathIsUnderWorkRoot,
} from "../lib/browser-wit-componentize-sandbox.mts";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const hostWitDir = path.join(repoRoot, "examples", "browser-runtime", "wit");

describe("browser WIT componentize sandbox", () => {
	it("repo wit path is outside a temp workRoot", () => {
		const workRoot = path.join(tmpdir(), "hobo-browser-wit-test");
		expect(witPathIsUnderWorkRoot(hostWitDir, workRoot)).toBe(false);
		expect(
			witPathIsUnderWorkRoot(
				componentizeWitDirUnderWorkRoot(workRoot),
				workRoot,
			),
		).toBe(true);
	});

	it("build script uses inline witWorld for splicer (no witPath file read)", () => {
		const source = readFileSync(
			path.join(repoRoot, "site/scripts/build-browser-wit-runtime.mts"),
			"utf8",
		);
		expect(source).toMatch(/readInlineComponentizeWit/);
		expect(source).toMatch(/witWorld:\s*inlineWit/);
		expect(source).not.toMatch(/witPath:\s*/);
		expect(source).toMatch(/process\.chdir\(workRoot\)/);
		expect(source).toMatch(/sourcePath:\s*BROWSER_WIT_GUEST_SOURCE_NAME/);
		expect(source).toMatch(/await resolveComponentizeHostWitPath/);
		expect(source).toMatch(/copyHostWitTreeIntoWorkRoot/);
		expect(source).toMatch(/assertSandboxWitBeforeComponentize/);
		expect(source).toMatch(/createBrowserWitComponentizeWorkRoot/);
		expect(source).toMatch(/logBrowserWitReleaseEnvironment/);
		expect(source).not.toMatch(/mkdtemp\(path\.join\(tmpdir\(\)/);
	});

	it("resolveComponentizeHostWitPath returns an absolute real path under workRoot", async () => {
		const workRoot = await import("node:fs/promises").then((fs) =>
			fs.mkdtemp(path.join(tmpdir(), "hobo-browser-wit-test-")),
		);
		try {
			const sandbox = componentizeWitDirUnderWorkRoot(workRoot);
			await mkdir(sandbox, { recursive: true });
			await writeFile(
				path.join(sandbox, "station.wit"),
				"package browser:station;\n",
				"utf8",
			);
			const resolved = await resolveComponentizeHostWitPath(sandbox);
			expect(path.isAbsolute(resolved)).toBe(true);
			expect(path.basename(resolved)).toBe("station.wit");
			expect(witPathIsUnderWorkRoot(resolved, workRoot)).toBe(true);
		} finally {
			await import("node:fs/promises").then((fs) =>
				fs.rm(workRoot, { recursive: true, force: true }),
			);
		}
	});

	it("guest source must use the fixed name under workRoot", () => {
		const workRoot = path.join(tmpdir(), "guest-under-root");
		const guest = guestSourcePathInWorkRoot(workRoot);
		expect(path.basename(guest)).toBe(BROWSER_WIT_GUEST_SOURCE_NAME);
		expect(() => assertGuestSourceUnderWorkRoot(guest, workRoot)).not.toThrow();
		expect(() =>
			assertGuestSourceUnderWorkRoot(
				path.join(workRoot, "other.mjs"),
				workRoot,
			),
		).toThrow(/must be station-guest\.mjs/);
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
