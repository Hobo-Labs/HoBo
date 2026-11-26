import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const linker = join(root, "scripts/ensure-ts-autocode-links.mts");

describe("scripts/ensure-ts-autocode-links.mts", () => {
	it("fetches pins before install and only installs when still unlinked", () => {
		const source = readFileSync(linker, "utf8");
		assert.match(source, /pins:fetch/);
		assert.doesNotMatch(
			source,
			/execFile\s*\(\s*["']pnpm["'],\s*\[\s*["']install["']/,
		);
		assert.doesNotMatch(
			source,
			/join\(\s*root,\s*["']node_modules\/ts-autocode-grounding/,
		);
		assert.match(
			source,
			/packages\/runtime\/node_modules\/ts-autocode-grounding/,
		);
	});

	it("passes when sibling link markers are present", () => {
		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", linker],
			{ cwd: root, encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr || result.stdout);
	});
});
