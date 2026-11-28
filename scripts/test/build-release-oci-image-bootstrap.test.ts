import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

describe("release image bootstrap", () => {
	it("starts in a checkout without installed workspace dependencies", () => {
		const fixture = mkdtempSync(join(tmpdir(), "hobo-oci-bootstrap-"));
		try {
			for (const dir of ["ci", "lib"]) {
				cpSync(join(root, "scripts", dir), join(fixture, "scripts", dir), {
					recursive: true,
				});
			}
			const result = spawnSync(
				process.execPath,
				[
					"--no-warnings",
					join(fixture, "scripts/ci/build-release-oci-image.mts"),
				],
				{ cwd: fixture, encoding: "utf8", timeout: 30_000 },
			);
			expect(result.status, result.stderr).toBe(2);
			expect(result.stderr).toContain(
				"usage: node scripts/ci/build-release-oci-image.mts",
			);
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});
});
