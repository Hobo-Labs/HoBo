import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pruneStrayWorkspacePackages } from "../ci/prune-stray-workspace-packages.mts";

describe("pruneStrayWorkspacePackages", () => {
	it("removes a packages/* directory without package.json", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-prune-packages-"));
		try {
			const stray = join(root, "packages", "hobo-code");
			mkdirSync(stray, { recursive: true });
			writeFileSync(join(stray, "README.md"), "leftover\n");
			const removed = pruneStrayWorkspacePackages(root);
			assert.deepEqual(removed, [stray]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a real package directory", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-prune-packages-"));
		try {
			const pkg = join(root, "packages", "core");
			mkdirSync(pkg, { recursive: true });
			writeFileSync(join(pkg, "package.json"), "{}\n");
			const removed = pruneStrayWorkspacePackages(root);
			assert.deepEqual(removed, []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
