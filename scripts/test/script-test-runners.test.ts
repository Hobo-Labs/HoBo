import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	globSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gitEnvironment } from "../ci/local-attest.mts";
import { nodeTestArguments } from "../lib/node-test-arguments.ts";
import { isNodeTestFile } from "../lib/unit-test-selection.ts";
import { selectRelevantChecks } from "../relevant-check-policy.ts";

const root = join(import.meta.dirname, "..", "..");
const scriptTests = globSync("scripts/test/*.test.ts", { cwd: root }).sort();
/** `node --test` loads a file written for node:test; Vitest loads the rest. */
const runnerFor = (file: string) =>
	isNodeTestFile(join(root, file)) ? "node --test" : "vitest";

describe("script test runners", () => {
	it("runs and reports a node-only scripts shard without requiring Vitest", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-node-only-shard-"));
		try {
			const env = gitEnvironment({
				NODE_TEST_CONTEXT: undefined,
				HOBO_TEST_MAX_WORKERS: "1",
			});
			const git = (...args: string[]) => {
				const result = spawnSync("git", args, {
					cwd: dir,
					env,
					encoding: "utf8",
				});
				assert.equal(result.status, 0, result.stderr);
			};
			git("init", "-q");
			mkdirSync(join(dir, "scripts/test"), { recursive: true });
			symlinkSync(
				join(root, "node_modules"),
				join(dir, "node_modules"),
				"junction",
			);
			const file = join(dir, "scripts/test/only.test.ts");
			writeFileSync(
				file,
				'import { test } from "node:test";\ntest("node-only", () => {});\n',
			);
			git("add", "scripts/test/only.test.ts");
			const run = () =>
				spawnSync(
					process.execPath,
					[
						"--import",
						"tsx",
						join(root, "scripts/run-tests.ts"),
						"--category=scripts",
						"--shard=0/1",
						"--final",
					],
					{
						cwd: dir,
						env,
						encoding: "utf8",
						timeout: 30_000,
					},
				);
			const success = run();
			assert.equal(success.status, 0, `${success.stdout}\n${success.stderr}`);
			assert.match(success.stdout, /node-only/u);
			writeFileSync(
				file,
				'import { test } from "node:test";\ntest("node-only failure", () => { throw new Error("expected failure"); });\n',
			);
			const failure = run();
			assert.notEqual(failure.status, 0);
			assert.match(`${failure.stdout}\n${failure.stderr}`, /expected failure/u);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs every node:test file within the configured worker budget", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-node-test-workers-"));
		try {
			const events = join(dir, "events.jsonl");
			const files = Array.from({ length: 6 }, (_, index) => {
				const file = join(dir, `${index}.test.mjs`);
				writeFileSync(
					file,
					`
import { appendFileSync } from "node:fs";
import { test } from "node:test";
test("fixture ${index}", async () => {
  appendFileSync(${JSON.stringify(events)}, JSON.stringify({ index: ${index}, event: "start" }) + "\\n");
  await new Promise((resolve) => setTimeout(resolve, 300));
  appendFileSync(${JSON.stringify(events)}, JSON.stringify({ index: ${index}, event: "end" }) + "\\n");
});\n`,
				);
				return file;
			});
			const run = spawnSync(process.execPath, nodeTestArguments(files, 2), {
				cwd: root,
				encoding: "utf8",
				env: { ...process.env, NODE_TEST_CONTEXT: undefined },
				timeout: 30_000,
			});
			assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
			const records = readFileSync(events, "utf8")
				.trim()
				.split("\n")
				.map((line): { index: number; event: string } => JSON.parse(line));
			const active = new Set<number>();
			const completed = new Set<number>();
			for (const record of records) {
				if (record.event === "start") {
					assert.ok(!active.has(record.index));
					active.add(record.index);
					assert.ok(active.size <= 2, "node:test exceeded the worker budget");
				} else {
					assert.equal(record.event, "end");
					assert.ok(active.delete(record.index));
					completed.add(record.index);
				}
			}
			assert.equal(active.size, 0);
			assert.deepEqual([...completed].sort(), [0, 1, 2, 3, 4, 5]);
			const runner = readFileSync(join(root, "scripts/run-tests.ts"), "utf8");
			assert.match(
				runner,
				/nodeTestArguments\(shardedRootNodeTestFiles, maxWorkers\)/u,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("gives every scripts test exactly one runner, and test:scripts runs both", () => {
		assert.ok(scriptTests.length > 0);
		for (const file of scriptTests) {
			if (runnerFor(file) === "node --test") continue;
			// What is not a node:test file has to be one Vitest can run.
			assert.match(
				readFileSync(join(root, file), "utf8"),
				/from "vitest"/u,
				`${file} imports neither node:test nor vitest`,
			);
		}
		// One command for the directory. A bare `node --test scripts/test/*`
		// cannot load a Vitest-style file and fails once for each of them.
		const scripts: { scripts: Record<string, string> } = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		);
		assert.equal(
			scripts.scripts["test:scripts"],
			"node --import tsx scripts/run-tests.ts --category=scripts",
		);
		const runner = readFileSync(join(root, "scripts/run-tests.ts"), "utf8");
		assert.match(runner, /scripts: \["scripts\/test\/\*\.test\.ts"\]/u);
		assert.match(runner, /file\.startsWith\("scripts\/test\/"\)/u);
	});

	it("runs each scripts test a workflow names under the runner test:scripts gives it", () => {
		// Workflows name single files (`node --import tsx --test <file>`,
		// `pnpm exec vitest run <files>`). Within a step, a scripts test that
		// follows one of those two commands is run by it; one that follows
		// neither is a path filter.
		const invocations: string[] = [];
		for (const workflow of globSync(".github/workflows/*.yml", { cwd: root })) {
			const lines = readFileSync(join(root, workflow), "utf8").split("\n");
			const starts = lines.flatMap((line, index) =>
				/^\s+- [a-z-]+:/u.test(line) ? [index] : [],
			);
			for (const [position, start] of starts.entries()) {
				const step = lines.slice(start, starts[position + 1]).join("\n");
				let runner: string | undefined;
				for (const match of step.matchAll(
					/--test(?=\s|$)|vitest run(?=\s|$)|scripts\/test\/[\w.-]+\.test\.ts/gmu,
				)) {
					const token = match[0];
					if (token === "--test") runner = "node --test";
					else if (token === "vitest run") runner = "vitest";
					else if (runner !== undefined) {
						invocations.push(`${workflow}: ${token}`);
						assert.ok(scriptTests.includes(token), `${workflow}: ${token}`);
						assert.equal(runnerFor(token), runner, `${workflow}: ${token}`);
					}
				}
			}
		}
		// Both forms are in use; finding neither means the scan broke.
		assert.ok(
			invocations.some((entry) =>
				entry.startsWith(".github/workflows/hobo-ci.yml"),
			),
		);
		assert.ok(
			invocations.some((entry) =>
				entry.startsWith(".github/workflows/release-hobo.yml"),
			),
		);
	});

	it("selects agent-plugin:check when the portable plugin surface changes", () => {
		const { checks } = selectRelevantChecks({
			files: ["plugins/hobo/skills/hobo-deploy/SKILL.md"],
			base: "origin/main",
		});
		assert.ok(
			checks.some(
				(check) =>
					check.args[0] === "run" && check.args[1] === "agent-plugin:check",
			),
		);
	});

	it("runs each scripts test the relevant-check policy selects under that runner too", () => {
		const policy = readFileSync(
			join(root, "scripts/relevant-check-policy.ts"),
			"utf8",
		);
		const named = [
			...new Set(policy.match(/scripts\/test\/[\w.-]+\.test\.ts/gu) ?? []),
		];
		assert.ok(named.length > 0);
		let selected = 0;
		for (const changed of named) {
			assert.ok(scriptTests.includes(changed), changed);
			const { checks } = selectRelevantChecks({
				files: [changed],
				base: "origin/main",
			});
			for (const check of checks) {
				const files = check.args.filter((arg) => scriptTests.includes(arg));
				if (files.length === 0) continue;
				const runner =
					check.command === "node" && check.args.includes("--test")
						? "node --test"
						: check.args.includes("vitest")
							? "vitest"
							: undefined;
				assert.ok(runner, `${check.command} ${check.args.join(" ")}`);
				for (const file of files) {
					selected += 1;
					assert.equal(runnerFor(file), runner, file);
				}
			}
		}
		assert.ok(selected > 0);
	});
});
