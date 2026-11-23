import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listExperienceProofs } from "../list-experience-proofs.mts";

function runInventory(...args: string[]) {
	return spawnSync(
		process.execPath,
		["--import", "tsx", "scripts/list-experience-proofs.mts", ...args],
		{
			cwd: process.cwd(),
			encoding: "utf8",
		},
	);
}

test("lists only packages in the selected type in deterministic order", () => {
	const root = mkdtempSync(path.join(tmpdir(), "hobo-experience-inventory-"));
	try {
		const parent = path.join(root, "src/draft/exp-proofs/ux");
		for (const slug of ["zebra", "alpha", "no-manifest"]) {
			mkdirSync(path.join(parent, slug), { recursive: true });
			if (slug !== "no-manifest")
				writeFileSync(path.join(parent, slug, "package.json"), "{}\n");
		}
		symlinkSync(path.join(parent, "alpha"), path.join(parent, "linked"), "dir");
		assert.deepEqual(listExperienceProofs(root, "ux"), [
			{
				type: "ux",
				audience: "End users",
				slug: "alpha",
				path: "src/draft/exp-proofs/ux/alpha",
			},
			{
				type: "ux",
				audience: "End users",
				slug: "zebra",
				path: "src/draft/exp-proofs/ux/zebra",
			},
		]);
		assert.throws(() => listExperienceProofs(root, "dx"), /ENOENT/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inventory CLI reports real UX packages and actionable invalid-type errors", () => {
	const result = runInventory("--type", "ux", "--json");
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout);
	assert.ok(Array.isArray(output.proofs));
	assert.ok(output.proofs.length > 0);
	for (const proof of output.proofs) {
		assert.equal(proof.type, "ux");
		assert.equal(proof.audience, "End users");
		assert.match(proof.path, /^src\/draft\/exp-proofs\/ux\//u);
	}
	const invalid = runInventory("--type", "invalid");
	assert.equal(invalid.status, 2);
	assert.match(invalid.stderr, /choose dx, ux, cx, ax, api/u);
	assert.equal(runInventory("--unexpected").status, 2);
	assert.match(runInventory("--help").stdout, /--type/u);
});
