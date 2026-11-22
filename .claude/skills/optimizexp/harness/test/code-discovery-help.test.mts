import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { discoverCode, pickPrimaryCommand } from "../lib/code-discovery.mts";

function fixture(run: (root: string, featureDir: string) => void) {
	const root = mkdtempSync(path.join(tmpdir(), "hobo-discovery-help-"));
	const featureDir = path.join(root, ".optimizexp/features/example");
	mkdirSync(path.join(root, ".git"));
	mkdirSync(featureDir, { recursive: true });
	writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
	try { run(root, featureDir); } finally { rmSync(root, { recursive: true, force: true }); }
}

function primary(root: string, featureDir: string, seed: string, surfaces: string[] = []) {
	const report = discoverCode({ root, featureDir, featureId: "example", seed, surfaces });
	return pickPrimaryCommand(report)?.command ?? null;
}

it("recognizes a quoted or standalone default help command", () => {
	fixture((root, dir) => {
		assert.equal(primary(root, dir, "Run `hobo --help`"), "hobo --help");
		assert.equal(primary(root, dir, "Discover the product", ["hobo --help"]), "hobo --help");
		assert.equal(primary(root, dir, "hobo -h"), "hobo -h");
		assert.equal(primary(root, dir, "Run `hobo doctor --json`"), "hobo doctor --json");
	});
});

it("retains literal quoted and escaped arguments for documented commands", () => {
	fixture((root, dir) => {
		const commands = [
			'hobo access request --env production --reason "preview and review" --duration 30m',
			"hobo access request --reason 'review; locally'",
			String.raw`hobo access request --reason "a \"quoted\" value"`,
			"hobo access request --reason preview\\ locally",
		];
		for (const command of commands) assert.equal(primary(root, dir, `Run \`${command}\``), command);
	});
});

it("does not promote prose, other flags, or shell expressions as help", () => {
	fixture((root, dir) => {
		for (const seed of [
			"Read about hobo --help before starting",
			"`hobo --helpfulness`",
			"`hobo --help; echo wrong`",
			"`hobo --help && echo wrong`",
			"`hobo --help$(echo wrong)`",
			"`hobo --help\necho wrong`",
			"`hobo status && echo wrong`",
			"Run hobo status; echo wrong",
			'`hobo access --reason "$(echo wrong)"`',
			'`hobo access --reason "$HOME"`',
		]) assert.equal(primary(root, dir, seed), null, seed);
	});
});
