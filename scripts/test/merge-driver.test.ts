import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";

import { SHADOW_PLAN_PATH, SHADOW_WORKFLOW_PATH } from "../ci/attestation.mts";
import {
	CATALOG_PATH,
	collectCodes,
	renderCatalog,
} from "../ci/error-catalog.mts";
import { PINS_PATH, readPins, writePins } from "../ci/merge-driver.mts";

const root = resolve(import.meta.dirname, "../..");
const driver = join(root, "scripts/ci/merge-driver.mts");

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const inherited = new Set([
	"CI",
	"HOBO_SKIP_HOOKS",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"HOBO_MERGE_DRIVER_NESTED",
]);
const env = {
	...Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !inherited.has(name) && !name.startsWith("GITHEAD_"),
		),
	),
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "merge-driver-test",
	GIT_AUTHOR_EMAIL: "merge-driver-test@example.invalid",
	GIT_COMMITTER_NAME: "merge-driver-test",
	GIT_COMMITTER_EMAIL: "merge-driver-test@example.invalid",
};

function git(cwd: string, args: readonly string[]) {
	return spawnSync("git", args, { cwd, encoding: "utf8", env });
}

function ok(cwd: string, args: readonly string[]): string {
	const result = git(cwd, args);
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

function put(repo: string, path: string, text: string): void {
	mkdirSync(dirname(join(repo, path)), { recursive: true });
	writeFileSync(join(repo, path), text);
}

function read(repo: string, path: string): string {
	return readFileSync(join(repo, path), "utf8");
}

const ZERO = "0".repeat(40);
const workflow = (lines: readonly string[]) => `${lines.join("\n")}\n`;
const BASE_WORKFLOW = [
	"name: HoBo CI",
	"jobs:",
	"  first:",
	"    runs-on: ubuntu-24.04",
	"  middle:",
	"    runs-on: ubuntu-24.04",
	"  last:",
	"    runs-on: ubuntu-24.04",
];

function pinsFile(workflowBlob: string, planBlob: string, tail = ""): string {
	return [
		'export const GATE = "pr-gate";',
		`export const SHADOW_WORKFLOW_BLOB = "${workflowBlob}";`,
		`export const SHADOW_PLAN_BLOB = "${planBlob}";`,
		`export const TAIL = "${tail}";`,
		"",
	].join("\n");
}

function codeSource(code: string, message: string): string {
	return `export function refuse() {\n\treturn { ok: false, code: "${code}", message: "${message}" };\n}\n`;
}

function hashOf(repo: string, path: string): string {
	return ok(repo, ["hash-object", "--", path]);
}

function pinCurrent(repo: string): void {
	put(
		repo,
		PINS_PATH,
		writePins(read(repo, PINS_PATH), {
			[SHADOW_WORKFLOW_PATH]: hashOf(repo, SHADOW_WORKFLOW_PATH),
			[SHADOW_PLAN_PATH]: hashOf(repo, SHADOW_PLAN_PATH),
		}),
	);
}

function catalogOf(sources: ReadonlyMap<string, string>): string {
	return renderCatalog(collectCodes(sources));
}

function commitAll(repo: string, message: string): void {
	ok(repo, ["add", "-A"]);
	ok(repo, ["commit", "--quiet", "--no-verify", "-m", message]);
}

function repository(registerDrivers: boolean): string {
	const repo = mkdtempSync(join(tmpdir(), "hobo-merge-driver-"));
	scratch.push(repo);
	ok(repo, ["init", "--quiet", "--initial-branch=main"]);
	mkdirSync(join(repo, ".githooks"));
	mkdirSync(join(repo, "scripts"), { recursive: true });
	copyFileSync(
		join(root, "scripts/ensure-hooks-path.sh"),
		join(repo, "scripts/ensure-hooks-path.sh"),
	);
	copyFileSync(join(root, ".gitattributes"), join(repo, ".gitattributes"));
	put(repo, SHADOW_WORKFLOW_PATH, workflow(BASE_WORKFLOW));
	put(repo, SHADOW_PLAN_PATH, '{"jobs":["first"]}\n');
	put(repo, PINS_PATH, pinsFile(ZERO, ZERO));
	put(
		repo,
		"packages/ci/src/a.ts",
		codeSource("HOBO_CI_ALPHA", "Alpha failed."),
	);
	pinCurrent(repo);
	put(
		repo,
		CATALOG_PATH,
		catalogOf(
			new Map([
				["packages/ci/src/a.ts", codeSource("HOBO_CI_ALPHA", "Alpha failed.")],
			]),
		),
	);
	commitAll(repo, "base");
	if (registerDrivers) {
		const registered = spawnSync("sh", ["scripts/ensure-hooks-path.sh"], {
			cwd: repo,
			encoding: "utf8",
			env,
		});
		assert.equal(registered.status, 0, registered.stderr);
		for (const name of ["hobo-attestation-pins", "hobo-error-catalog"]) {
			const configured = ok(repo, ["config", `merge.${name}.driver`]);
			assert.match(configured, /scripts\/ci\/merge-driver\.mts/u);
			ok(repo, [
				"config",
				`merge.${name}.driver`,
				configured.replace("scripts/ci/merge-driver.mts", driver),
			]);
		}
	}
	return repo;
}

function divergeOnWorkflow(repo: string): void {
	ok(repo, ["checkout", "--quiet", "-b", "side"]);
	const theirs = [...BASE_WORKFLOW];
	theirs[7] = "    runs-on: ubuntu-24.04-arm";
	put(repo, SHADOW_WORKFLOW_PATH, workflow(theirs));
	put(repo, "packages/ci/src/b.ts", codeSource("HOBO_CI_BETA", "Beta failed."));
	pinCurrent(repo);
	put(
		repo,
		CATALOG_PATH,
		catalogOf(
			new Map([
				["packages/ci/src/a.ts", codeSource("HOBO_CI_ALPHA", "Alpha failed.")],
				["packages/ci/src/b.ts", codeSource("HOBO_CI_BETA", "Beta failed.")],
			]),
		),
	);
	commitAll(repo, "side changes the last job and adds a code");
	ok(repo, ["checkout", "--quiet", "main"]);
	const ours = [...BASE_WORKFLOW];
	ours[3] = "    runs-on: ubuntu-24.04-arm";
	put(repo, SHADOW_WORKFLOW_PATH, workflow(ours));
	put(
		repo,
		"packages/ci/src/c.ts",
		codeSource("HOBO_CI_GAMMA", "Gamma failed."),
	);
	pinCurrent(repo);
	put(
		repo,
		CATALOG_PATH,
		catalogOf(
			new Map([
				["packages/ci/src/a.ts", codeSource("HOBO_CI_ALPHA", "Alpha failed.")],
				["packages/ci/src/c.ts", codeSource("HOBO_CI_GAMMA", "Gamma failed.")],
			]),
		),
	);
	commitAll(repo, "main changes the first job and adds a code");
}

describe("merge drivers for the attestation pins and the error catalog", () => {
	it("declares both drivers in .gitattributes", () => {
		const attributes = readFileSync(join(root, ".gitattributes"), "utf8");
		assert.match(
			attributes,
			/^scripts\/ci\/attestation\.mts merge=hobo-attestation-pins$/mu,
		);
		assert.match(
			attributes,
			/^docs\/ci\/errors\.md merge=hobo-error-catalog$/mu,
		);
	});

	it("reads and rewrites only the two pins", () => {
		const text = pinsFile("1".repeat(40), "2".repeat(40), "kept");
		assert.deepEqual(readPins(text), {
			[SHADOW_WORKFLOW_PATH]: "1".repeat(40),
			[SHADOW_PLAN_PATH]: "2".repeat(40),
		});
		assert.equal(
			writePins(text, {
				[SHADOW_WORKFLOW_PATH]: "3".repeat(40),
				[SHADOW_PLAN_PATH]: "4".repeat(40),
			}),
			pinsFile("3".repeat(40), "4".repeat(40), "kept"),
		);
	});

	it("without the drivers, two branches that change the workflow conflict on the pins and catalog", () => {
		const repo = repository(false);
		divergeOnWorkflow(repo);
		const merged = git(repo, ["merge", "--no-edit", "side"]);
		assert.notEqual(merged.status, 0);
		const conflicted = ok(repo, ["diff", "--name-only", "--diff-filter=U"]);
		assert.deepEqual(conflicted.split("\n").sort(), [CATALOG_PATH, PINS_PATH]);
	});

	it("with the drivers, the merge resolves with pins of the merged workflow and plan and a regenerated catalog", () => {
		const repo = repository(true);
		divergeOnWorkflow(repo);
		const merged = git(repo, ["merge", "--no-edit", "side"]);
		assert.equal(merged.status, 0, merged.stdout + merged.stderr);
		assert.equal(ok(repo, ["status", "--porcelain"]), "");
		const workflowText = read(repo, SHADOW_WORKFLOW_PATH);
		assert.match(workflowText, /first:\n {4}runs-on: ubuntu-24\.04-arm/u);
		assert.match(workflowText, /last:\n {4}runs-on: ubuntu-24\.04-arm/u);
		assert.deepEqual(readPins(read(repo, PINS_PATH)), {
			[SHADOW_WORKFLOW_PATH]: hashOf(repo, SHADOW_WORKFLOW_PATH),
			[SHADOW_PLAN_PATH]: hashOf(repo, SHADOW_PLAN_PATH),
		});
		assert.equal(
			read(repo, CATALOG_PATH),
			catalogOf(
				new Map(
					["a", "b", "c"].map((name) => [
						`packages/ci/src/${name}.ts`,
						read(repo, `packages/ci/src/${name}.ts`),
					]),
				),
			),
		);
		assert.match(
			read(repo, CATALOG_PATH),
			/HOBO_CI_BETA[\s\S]*HOBO_CI_GAMMA|HOBO_CI_GAMMA[\s\S]*HOBO_CI_BETA/u,
		);
	});

	it("keeps a real conflict in the pinned workflow a conflict", () => {
		const repo = repository(true);
		ok(repo, ["checkout", "--quiet", "-b", "side"]);
		const theirs = [...BASE_WORKFLOW];
		theirs[3] = "    runs-on: ubuntu-22.04";
		put(repo, SHADOW_WORKFLOW_PATH, workflow(theirs));
		pinCurrent(repo);
		commitAll(repo, "side");
		ok(repo, ["checkout", "--quiet", "main"]);
		const ours = [...BASE_WORKFLOW];
		ours[3] = "    runs-on: ubuntu-24.04-arm";
		put(repo, SHADOW_WORKFLOW_PATH, workflow(ours));
		pinCurrent(repo);
		commitAll(repo, "main");
		const merged = git(repo, ["merge", "--no-edit", "side"]);
		assert.notEqual(merged.status, 0);
		const conflicted = ok(repo, ["diff", "--name-only", "--diff-filter=U"]);
		assert.deepEqual(conflicted.split("\n").sort(), [
			SHADOW_WORKFLOW_PATH,
			PINS_PATH,
		]);
		assert.match(merged.stderr + merged.stdout, /merge-driver\.mts refresh/u);
	});
});
