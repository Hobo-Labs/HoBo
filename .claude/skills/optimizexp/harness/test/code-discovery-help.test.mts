import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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

it("generates and runs the default help binding end to end", () => {
	fixture((root, dir) => {
		const personaDir = path.join(root, ".optimizexp/personas");
		const binDir = path.join(root, "bin");
		mkdirSync(personaDir, { recursive: true });
		mkdirSync(binDir);
		writeFileSync(path.join(personaDir, "developer.md"), "---\nid: developer\nexperiences: [dx]\ninterfaces: [cli]\n---\nUses the CLI.\n");
		const bin = path.join(binDir, "hobo");
		writeFileSync(bin, '#!/bin/sh\nprintf "observed help: %s\\n" "$*"\n');
		chmodSync(bin, 0o755);
		const harness = fileURLToPath(new URL("../generate-feature.mts", import.meta.url));
		const env = { ...process.env, HOME: root, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
		const scaffold = spawnSync(process.execPath, ["--experimental-strip-types", harness, "--mode=scaffold", "--project=root", "--id=example", "--seed=Run `hobo --help`", "--personas=developer", "--force-low-quality"], { cwd: root, env, encoding: "utf8" });
		assert.equal(scaffold.status, 0, scaffold.stderr);
		const feature = JSON.parse(readFileSync(path.join(dir, "feature.json"), "utf8")) as { primaryCommand?: string; implementationStatus?: string };
		assert.equal(feature.primaryCommand, "hobo --help");
		assert.equal(feature.implementationStatus, "wired");
		const implementations = pathToFileURL(path.join(dir, "steps/implementations.ts")).href;
		const world = pathToFileURL(path.join(dir, "steps/world.ts")).href;
		const script = `import { createWorld } from ${JSON.stringify(world)}; import { exerciseSurface } from ${JSON.stringify(implementations)}; const w=createWorld("example"); exerciseSurface(w); console.log(JSON.stringify({exit:w.lastExitCode,output:w.lastStdout}));`;
		const run = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: root, env, encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		const observed = JSON.parse(run.stdout) as { exit: number | null; output: string };
		assert.equal(observed.exit, 0);
		assert.match(observed.output, /observed help: --help/);
	});
});
