import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { withoutPackageManager } from "../lib/env.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const root = "/repo";
const launcher = join(root, "scripts", "run-script.mts");
const scripts = {
	build: "tsc",
	pretest: "build",
	test: "vitest",
	lint: "biome",
};
const bins = new Set(["oxlint", "turbo"]);
const posix = (command: string, args: string[]) =>
	withoutPackageManager(command, args, {
		root,
		scripts,
		platform: "linux",
		hasBin: (name) => bins.has(name),
	});

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

// The relevant-check policy names its gates as `pnpm run …` / `pnpm exec …`.
// The pre-commit hook runs them on machines with no usable pnpm, so the
// runner rewrites them to what Node and the checkout already provide.
describe("running a pnpm-shaped check without pnpm", () => {
	it("runs a script through scripts/run-script.mts, arguments after --", () => {
		assert.deepEqual(posix("pnpm", ["run", "lint", "--", "--staged"]), {
			command: process.execPath,
			args: ["--experimental-strip-types", launcher, "lint", "--", "--staged"],
		});
		assert.deepEqual(posix("pnpm", ["run", "lint"]), {
			command: process.execPath,
			args: ["--experimental-strip-types", launcher, "lint", "--"],
		});
	});

	it("puts bare script arguments after -- as pnpm would pass them", () => {
		assert.deepEqual(posix("pnpm", ["run", "lint", "--fix"]), {
			command: process.execPath,
			args: ["--experimental-strip-types", launcher, "lint", "--", "--fix"],
		});
	});

	it("hands a script an argument holding ' and ; as itself", () => {
		// `node --run lint -- "--base=main';touch PWNED;#"` ran `touch PWNED`.
		const dir = mkdtempSync(join(tmpdir(), "hobo-without-pm-"));
		scratch.push(dir);
		mkdirSync(join(dir, "scripts"));
		copyFileSync(
			join(repo, "scripts", "run-script.mts"),
			join(dir, "scripts", "run-script.mts"),
		);
		writeFileSync(
			join(dir, "record.mjs"),
			'import { writeFileSync } from "node:fs";\nwriteFileSync("args.json", JSON.stringify(process.argv.slice(2)));\n',
		);
		const manifest = { show: "node record.mjs" };
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ scripts: manifest }),
		);
		const base = "--base=main';touch${IFS}PWNED;#";
		const direct = withoutPackageManager("pnpm", ["run", "show", "--", base], {
			root: dir,
			scripts: manifest,
			platform: "linux",
			hasBin: () => false,
		});
		const result = spawnSync(direct.command, direct.args, {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, NODE_OPTIONS: "" },
		});
		assert.equal(result.status, 0, result.stderr);
		const received: string[] = JSON.parse(
			readFileSync(join(dir, "args.json"), "utf8"),
		);
		assert.deepEqual(received, [base]);
		assert.equal(existsSync(join(dir, "PWNED")), false);
	});

	it("runs an exec'd binary straight from node_modules/.bin", () => {
		assert.deepEqual(
			posix("pnpm", ["exec", "oxlint", "--deny-warnings", "a.ts"]),
			{
				command: join(root, "node_modules", ".bin", "oxlint"),
				args: ["--deny-warnings", "a.ts"],
			},
		);
	});

	it("refuses an exec it would have to guess at", () => {
		// pnpm reads these as options, a path or a PATH lookup; joining them onto
		// node_modules/.bin would run something else, or nothing.
		for (const [args, says] of [
			[
				["exec", "--filter", "./pkg", "turbo", "run", "test"],
				/plain binary name/u,
			],
			[["exec", "-r", "turbo"], /plain binary name/u],
			[["exec", "node", "-v"], /plain binary name/u],
			[["exec", "../../usr/bin/env"], /plain binary name/u],
			[["exec", "tools/oxlint"], /plain binary name/u],
			[["exec", ".."], /plain binary name/u],
			[["exec", "a..b"], /plain binary name/u],
			[["exec"], /plain binary name/u],
			[["exec", "vitest"], /node_modules\/\.bin\/vitest/u],
		] as const) {
			assert.throws(() => posix("pnpm", [...args]), says, args.join(" "));
		}
	});

	it("keeps pnpm for a script with lifecycle hooks the launcher does not run", () => {
		assert.deepEqual(posix("pnpm", ["run", "test"]), {
			command: "pnpm",
			args: ["run", "test"],
		});
	});

	it("keeps pnpm for anything that is a package-manager operation", () => {
		for (const args of [
			["install", "--frozen-lockfile"],
			["--filter", "@hobo/x", "run", "test"],
			["run", "no-such-script"],
			["run", "constructor"],
		]) {
			assert.deepEqual(posix("pnpm", args), { command: "pnpm", args });
		}
	});

	it("leaves other commands alone", () => {
		assert.deepEqual(posix("git", ["status"]), {
			command: "git",
			args: ["status"],
		});
	});
});
