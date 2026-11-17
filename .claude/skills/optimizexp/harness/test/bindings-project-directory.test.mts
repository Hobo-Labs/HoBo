import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { buildImplementationsFromDiscovery } from "../lib/bindings-gen.mts";
import type { DiscoveredBinding, DiscoveryReport } from "../lib/code-discovery.mts";

const binding: DiscoveredBinding = {
	kind: "package-script",
	id: "inspect",
	command: "npm run inspect --silent",
	confidence: "high",
	reason: "fixture package script",
	implementsSteps: ["I exercise the surface as this persona would"],
};
const report: DiscoveryReport = {
	featureId: "demo",
	seed: "fixture",
	scannedAt: "2026-01-01T00:00:00.000Z",
	bindings: [binding],
	packageScripts: ["inspect"],
	notes: [],
};

function fixture(run: (input: { root: string; project: string; outer: string }) => void): void {
	const outer = mkdtempSync(path.join(tmpdir(), "hobo-binding-project-"));
	const root = path.join(outer, "repo");
	const project = path.join(root, "packages", "widget app");
	try {
		mkdirSync(path.join(root, ".git"), { recursive: true });
		mkdirSync(project, { recursive: true });
		for (const [dir, output] of [[root, "ROOT"], [project, "PROJECT"]]) {
			writeFileSync(path.join(dir!, "package.json"), JSON.stringify({
				type: "module",
				scripts: { inspect: `node -e "console.log('${output}')"` },
			}));
		}
		run({ root, project, outer });
	} finally {
		rmSync(outer, { recursive: true, force: true });
	}
}

function generated(projectRoot: string, projectDir?: string, primary: DiscoveredBinding = binding): string {
	const feature = path.join(projectRoot, ".optimizexp/features/demo");
	const steps = path.join(feature, "steps");
	mkdirSync(steps, { recursive: true });
	const generated = buildImplementationsFromDiscovery({
		featureId: "demo",
		report,
		primaryOverride: primary,
		projectDir,
	});
	const module = path.join(steps, "implementations.ts");
	writeFileSync(module, generated.implementations);
	return module;
}

function exercise(module: string, cwd: string, env: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
	const script = `
const impl = await import(${JSON.stringify(pathToFileURL(module).href)});
const world = {featureId: "demo", personaId: null, lastExitCode: null, lastStdout: "", lastStderr: "", lastCommand: null, notes: [], statusClear: false, nextActionObvious: false, errorActionable: false, evidencePath: null};
impl.exerciseSurface(world);
impl.onCriticalPath(world);
console.log(JSON.stringify(world));
`;
	return spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
		cwd,
		encoding: "utf8",
		timeout: 30_000,
		env: { ...process.env, ...env, GH_TOKEN: undefined, NODE_TEST_CONTEXT: undefined },
	});
}

describe("generated binding project directory", () => {
	it("uses the caller's PATH and environment without reading a login profile", () => {
		fixture(({ root, outer }) => {
			const callerBin = path.join(outer, "caller-bin");
			const profileBin = path.join(outer, "profile-bin");
			const home = path.join(outer, "home");
			for (const dir of [callerBin, profileBin, home]) mkdirSync(dir);
			writeFileSync(path.join(callerBin, "pnpm"), '#!/bin/sh\nprintf "caller:%s\\n" "$HOBO_BINDING_MARKER"\n', { mode: 0o755 });
			writeFileSync(path.join(profileBin, "pnpm"), '#!/bin/sh\nprintf "profile\\n"\n', { mode: 0o755 });
			writeFileSync(path.join(home, ".bash_profile"), `export PATH=${JSON.stringify(`${profileBin}${path.delimiter}${process.env.PATH ?? ""}`)}\n`);
			const primary = { ...binding, command: "pnpm --version" };
			const module = generated(root, undefined, primary);
			const result = exercise(module, root, {
				HOME: home,
				PATH: `${callerBin}${path.delimiter}${process.env.PATH ?? ""}`,
				BASH_ENV: undefined,
				HOBO_BINDING_MARKER: "preserved",
			});
			assert.equal(result.status, 0, String(result.stderr));
			const world = JSON.parse(String(result.stdout)) as { lastExitCode: number; lastStdout: string };
			assert.equal(world.lastExitCode, 0);
			assert.match(world.lastStdout, /caller:preserved/);
			assert.doesNotMatch(world.lastStdout, /profile/);
		});
	});

	it("runs the selected project's script and finds its feature from the repository root", () => {
		fixture(({ root, project }) => {
			const module = generated(project, "packages/widget app");
			writeFileSync(path.join(project, ".optimizexp/features/demo/feature.json"), "{}\n");
			const result = exercise(module, root);
			assert.equal(result.status, 0, String(result.stderr));
			const world = JSON.parse(String(result.stdout)) as { lastExitCode: number; lastStdout: string; notes: string[] };
			assert.equal(world.lastExitCode, 0);
			assert.match(world.lastStdout, /PROJECT/);
			assert.doesNotMatch(world.lastStdout, /ROOT/);
			assert.ok(world.notes.includes("critical path: feature seed/metadata present"));
		});
	});

	it("anchors project and default-root commands to the checkout, even when invoked elsewhere", () => {
		fixture(({ root, project, outer }) => {
			const scoped = generated(project, "packages/widget app");
			const defaultRoot = generated(root);
			for (const cwd of [root, project, outer]) {
				const projectRun = exercise(scoped, cwd);
				assert.equal(projectRun.status, 0, String(projectRun.stderr));
				assert.match(String(projectRun.stdout), /PROJECT/);
				const rootRun = exercise(defaultRoot, cwd);
				assert.equal(rootRun.status, 0, String(rootRun.stderr));
				assert.match(String(rootRun.stdout), /ROOT/);
				assert.doesNotMatch(String(rootRun.stdout), /PROJECT/);
			}
		});
	});

	it("rejects escaping project paths and refuses a project redirected after generation", () => {
		for (const projectDir of ["../other", "packages/../../other", "/tmp/other", "C:\\outside"]) {
			assert.throws(() => buildImplementationsFromDiscovery({ featureId: "demo", report, projectDir }), /projectDir must be relative/);
		}
		fixture(({ root, project, outer }) => {
			const module = generated(root, "packages/widget app");
			rmSync(project, { recursive: true });
			const redirected = path.join(outer, "redirected");
			mkdirSync(redirected);
			writeFileSync(path.join(redirected, "package.json"), JSON.stringify({ scripts: { inspect: "echo WRONG" } }));
			symlinkSync(redirected, project, "dir");
			const result = exercise(module, root);
			assert.notEqual(result.status, 0);
			assert.match(String(result.stderr), /project directory is no longer valid/);
			assert.doesNotMatch(String(result.stdout), /WRONG/);
		});
	});
});
