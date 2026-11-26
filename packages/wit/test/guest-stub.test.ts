import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = join(import.meta.dirname, "..");
const requireFromPackage = createRequire(join(PACKAGE_ROOT, "package.json"));

describe("guest stub", () => {
	it("typechecks a no-op guest importing every generated interface", () => {
		const tscPath = requireFromPackage.resolve("typescript/bin/tsc");
		const outDir = mkdtempSync(join(tmpdir(), "hobo-wit-guest-"));

		try {
			expect(() =>
				execFileSync(
					process.execPath,
					[
						tscPath,
						"--ignoreConfig",
						"--strict",
						"--skipLibCheck",
						"--module",
						"NodeNext",
						"--moduleResolution",
						"NodeNext",
						"--target",
						"ES2022",
						"--outDir",
						outDir,
						join(PACKAGE_ROOT, "test", "guest-stub.ts"),
					],
					{ cwd: PACKAGE_ROOT, stdio: "pipe" },
				),
			).not.toThrow();
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
