import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { measureWorkDirInodeBreakdown } from "../src/isolated-worker/work-dir-inode-breakdown.js";
import { workDirLocalInodeEstimate } from "../src/isolated-worker/work-dir-local-inodes.js";

describe("work dir inode breakdown", () => {
	let root: string | undefined;

	afterEach(async () => {
		if (root) {
			const { rm } = await import("node:fs/promises");
			await rm(root, { recursive: true, force: true });
			root = undefined;
		}
	});

	it("classifies git and skips symlinked node_modules", async () => {
		root = await mkdtemp(join(tmpdir(), "hobo-inode-"));
		const checkout = join(root, "HoBo", "HoBo");
		await mkdir(join(checkout, ".git", "objects", "ab"), {
			recursive: true,
		});
		await writeFile(join(checkout, ".git", "objects", "ab", "cdef"), "obj");
		await writeFile(join(checkout, "README.md"), "hi");
		await symlink(
			"/opt/hobo-deps/node_modules",
			join(checkout, "node_modules"),
		);
		const breakdown = await measureWorkDirInodeBreakdown(root);
		expect(breakdown.linkedNodeModules).toBe(1);
		expect(breakdown.git).toBeGreaterThan(0);
		expect(workDirLocalInodeEstimate(breakdown)).toBeLessThan(
			breakdown.entries,
		);
	});
});
