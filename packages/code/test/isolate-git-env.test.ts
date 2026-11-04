import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("test git isolation", () => {
	it("does not inherit global or system commit signing config", () => {
		expect(process.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
		expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");

		const root = mkdtempSync(join(tmpdir(), "hobo-code-git-env-"));
		try {
			const initialized = spawnSync("git", ["init", "-q"], {
				cwd: root,
				encoding: "utf8",
			});
			if (initialized.status !== 0) throw new Error(initialized.stderr);

			const signing = spawnSync("git", ["config", "--get", "commit.gpgsign"], {
				cwd: root,
				encoding: "utf8",
			});
			expect(signing.error).toBeUndefined();
			expect(signing.stdout.trim()).not.toBe("true");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
