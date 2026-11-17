/**
 * `hobo ci init --relay`, `--undo` and `--check` (ADR-0183): gauntlet cases
 * S03 (init writes relay jobs and never commits) and S09 (a clean way to
 * remove it). A checkout is a temporary directory; git is a fake that
 * records every call, so a test can see nothing was committed.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	RELAY_JOB_EVALUATOR,
	RELAY_JOB_WORKFLOW,
} from "@hobo/ci-gh-actions/relay-job-assets";
import { createHoboCli } from "@hobo/cli";
import { afterEach, describe, expect, it } from "vitest";
import { createCiCommand } from "../src/ci-command.js";
import { runCiInit } from "../src/ci-init.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

const CI = `name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm test
  build:
    needs: test
    strategy:
      matrix:
        node: [20, 22, 24]
    runs-on: ubuntu-24.04 # pinned
    steps:
      - run: pnpm build
  mac:
    runs-on: macos-15
    steps:
      - run: swift build
`;

const WORKFLOW = join(".github", "workflows");
const RELAY_WORKFLOW = join(WORKFLOW, "hobo-relay.yml");
const EVALUATOR = join(".hobo-ci", "relay.mjs");

async function exists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

async function checkout() {
	const root = await mkdtemp(join(tmpdir(), "hobo-ci-init-relay-"));
	directories.push(root);
	await mkdir(join(root, WORKFLOW), { recursive: true });
	await writeFile(join(root, WORKFLOW, "ci.yml"), CI);
	const gitCalls: string[][] = [];
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: {},
				git: async (args) => {
					gitCalls.push([...args]);
					if (args[0] === "rev-parse") return root;
					return "git@github.com:acme/app.git";
				},
			}),
		},
	});
	const init = async (...args: readonly string[]) => {
		const result = await cli.run(["ci", "init", ...args, "--json"], {
			cwd: root,
		});
		return { exitCode: result.exitCode, envelope: JSON.parse(result.stdout) };
	};
	const direct = (options: Readonly<Record<string, string | boolean>>) =>
		runCiInit({ cwd: root, args: [], options });
	const file = (path: string) => readFile(join(root, path), "utf8");
	return { root, init, direct, file, gitCalls };
}

describe("hobo ci init --relay (S03)", () => {
	it("plans relay jobs by default and changes nothing", async () => {
		const { init, file } = await checkout();
		const { exitCode, envelope } = await init("--relay", "job");
		expect(exitCode).toBe(0);
		expect(envelope.data.mode).toBe("job");
		const message: string = envelope.message;
		expect(message).toContain("Relay mode: job. 2 ready, 0 behind a relay.");
		expect(message).toContain("  test  [ubuntu-latest]  ready");
		expect(message).toContain("  mac  [macos-15]  skipped (not_linux_x64)");
		expect(message).toContain("hobo ci init --relay job --apply all");
		expect(await file(join(WORKFLOW, "ci.yml"))).toBe(CI);
		expect(await exists(join(WORKFLOW, "hobo-relay.yml"))).toBe(false);
	});

	it("puts jobs behind relays, writes the generated files and commits nothing", async () => {
		const { init, file, gitCalls } = await checkout();
		const { exitCode, envelope } = await init(
			"--relay",
			"job",
			"--apply",
			"all",
			"--machine",
			"self-hosted",
		);
		expect(exitCode).toBe(0);
		expect(envelope.data.changed).toEqual([
			{ file: ".github/workflows/ci.yml", job: "test" },
			{ file: ".github/workflows/ci.yml", job: "build" },
		]);
		expect(envelope.data.written).toEqual([RELAY_WORKFLOW, EVALUATOR]);
		expect(envelope.message).toContain(
			"Put 2 job(s) behind a relay (job mode). Nothing was committed; review the diff.",
		);
		const ci = await file(join(WORKFLOW, "ci.yml"));
		expect(ci).toContain(
			"  relay-build:\n    uses: ./.github/workflows/hobo-relay.yml\n    permissions:\n      actions: read\n      contents: read\n    with:\n      machine: self-hosted\n      github: ubuntu-24.04\n  build:\n    needs: [relay-build, test]\n",
		);
		expect(ci).toContain(
			"    runs-on: ${{ needs.relay-build.outputs.runner }} # pinned\n",
		);
		expect(await file(RELAY_WORKFLOW)).toBe(RELAY_JOB_WORKFLOW);
		expect(await file(EVALUATOR)).toBe(RELAY_JOB_EVALUATOR);
		// Only the checkout's root and remote were read; nothing was added or committed.
		expect(gitCalls.map((call) => call[0])).toEqual(
			expect.not.arrayContaining(["add", "commit", "push"]),
		);
		// The relay's own workflow is never planned as a job to move.
		const plan = await init("--relay", "job");
		expect(plan.envelope.message).not.toContain("hobo-relay.yml");
		expect(plan.envelope.message).toContain(
			"  build  [${{ needs.relay-build.outputs.runner }}]  behind relay-build (github: ubuntu-24.04)",
		);
		const fleet = await init();
		expect(
			fleet.envelope.data.plans.map((entry: { file: string }) => entry.file),
		).toEqual([".github/workflows/ci.yml"]);
	});

	it("writes only the relay workflow, on the relay label, in relay mode", async () => {
		const { root, init, file } = await checkout();
		const { envelope } = await init("--relay", "relay", "--apply", "test");
		expect(envelope.data.changed).toEqual([
			{ file: ".github/workflows/ci.yml", job: "test" },
		]);
		expect(envelope.data.written).toEqual([RELAY_WORKFLOW]);
		expect(await file(RELAY_WORKFLOW)).toContain("\n    runs-on: hobo-relay\n");
		expect(await exists(join(root, EVALUATOR))).toBe(false);
		expect(envelope.message).toContain("set relayJobs.answer to true");
		const check = await runCiInit({
			cwd: root,
			args: [],
			options: { check: true },
		});
		expect(check.message).toContain(
			"The relay files are current (relay mode).",
		);
		const undone = await runCiInit({
			cwd: root,
			args: [],
			options: { undo: true },
		});
		expect(undone.data?.removed).toEqual([RELAY_WORKFLOW]);
		expect(await file(join(WORKFLOW, "ci.yml"))).toBe(CI);
	});

	it("refuses usage it cannot honour", async () => {
		const { init, direct } = await checkout();
		expect((await init("--relay", "bogus")).envelope.code).toBe(
			"HOBO_CLI_USAGE",
		);
		expect(
			(await init("--relay", "job", "--github", "ubuntu-latest")).envelope.code,
		).toBe("HOBO_CLI_USAGE");
		expect(
			(await init("--relay", "job", "--machine", "a b")).envelope.code,
		).toBe("HOBO_CLI_USAGE");
		expect((await direct({ undo: true, relay: "job" })).code).toBe(
			"HOBO_CLI_USAGE",
		);
		expect((await direct({ check: true, undo: true })).code).toBe(
			"HOBO_CLI_USAGE",
		);
		const refused = await init("--relay", "job", "--apply", "mac");
		expect(refused.exitCode).not.toBe(0);
		expect(refused.envelope.code).toBe("HOBO_CI_INIT_NOTHING_APPLIED");
	});
});

describe("hobo ci init --undo (S09)", () => {
	it("gives back the original bytes, removes the generated files, and applies again byte for byte", async () => {
		const { init, direct, file, root } = await checkout();
		await init("--relay", "job", "--apply", "all");
		const applied = await file(join(WORKFLOW, "ci.yml"));
		const undone = await direct({ undo: true });
		expect(undone.ok).not.toBe(false);
		expect(undone.data?.restored).toEqual([
			{ file: ".github/workflows/ci.yml", job: "test" },
			{ file: ".github/workflows/ci.yml", job: "build" },
		]);
		expect(undone.data?.removed).toEqual([RELAY_WORKFLOW, EVALUATOR]);
		expect(await file(join(WORKFLOW, "ci.yml"))).toBe(CI);
		expect(await exists(join(root, RELAY_WORKFLOW))).toBe(false);
		expect(await exists(join(root, EVALUATOR))).toBe(false);
		await init("--relay", "job", "--apply", "all");
		expect(await file(join(WORKFLOW, "ci.yml"))).toBe(applied);
		expect(await file(RELAY_WORKFLOW)).toBe(RELAY_JOB_WORKFLOW);
		expect(await file(EVALUATOR)).toBe(RELAY_JOB_EVALUATOR);
	});

	it("refuses a relay edited since, names its lines, and keeps the files it still needs", async () => {
		const { init, direct, file, root } = await checkout();
		await init("--relay", "job", "--apply", "all");
		const path = join(root, WORKFLOW, "ci.yml");
		const edited = (await file(join(WORKFLOW, "ci.yml"))).replace(
			"      github: ubuntu-latest\n",
			"      github: ubuntu-latest\n      first: depot\n      # tried depot first\n",
		);
		await writeFile(path, edited);
		const undone = await direct({ undo: true });
		expect(undone.data?.restored).toEqual([
			{ file: ".github/workflows/ci.yml", job: "build" },
		]);
		expect(undone.data?.refused).toEqual([
			{
				file: ".github/workflows/ci.yml",
				job: "test",
				why: "the relay relay-test changed since hobo ci init wrote it",
				lines: [4, 12],
			},
		]);
		expect(undone.message).toContain("(lines 4-12)");
		expect(undone.data?.removed).toEqual([]);
		expect(await exists(join(root, RELAY_WORKFLOW))).toBe(true);
	});

	it("keeps the generated files while a hand-written job still calls the relay", async () => {
		const { init, direct, file, root } = await checkout();
		await init("--relay", "job", "--apply", "all");
		const other = `name: other
on: [push]
jobs:
  route:
    uses: ./.github/workflows/hobo-relay.yml
    with:
      github: ubuntu-latest
  build:
    needs: route
    runs-on: \${{ needs.route.outputs.runner }}
    steps:
      - run: make
`;
		await writeFile(join(root, WORKFLOW, "other.yml"), other);
		const undone = await direct({ undo: true });
		expect(undone.ok).not.toBe(false);
		expect(undone.data?.restored).toEqual([
			{ file: ".github/workflows/ci.yml", job: "test" },
			{ file: ".github/workflows/ci.yml", job: "build" },
		]);
		expect(undone.data?.removed).toEqual([]);
		expect(undone.data?.stillUsedBy).toEqual([".github/workflows/other.yml"]);
		expect(undone.message).toContain(
			"  .github/workflows/other.yml: names ./.github/workflows/hobo-relay.yml",
		);
		expect(await file(join(WORKFLOW, "ci.yml"))).toBe(CI);
		expect(await file(join(WORKFLOW, "other.yml"))).toBe(other);
		expect(await file(RELAY_WORKFLOW)).toBe(RELAY_JOB_WORKFLOW);
		expect(await file(EVALUATOR)).toBe(RELAY_JOB_EVALUATOR);
	});

	it("keeps the generated files while a workflow cannot be read", async () => {
		const { init, direct, root } = await checkout();
		await init("--relay", "job", "--apply", "all");
		// A directory named like a workflow cannot be read as one.
		await mkdir(join(root, WORKFLOW, "broken.yml"));
		const undone = await direct({ undo: true });
		expect(undone.ok).not.toBe(false);
		expect(undone.data?.removed).toEqual([]);
		expect(undone.data?.stillUsedBy).toEqual([".github/workflows/broken.yml"]);
		expect(undone.message).toContain(
			"  .github/workflows/broken.yml: could not be read",
		);
		expect(await exists(join(root, RELAY_WORKFLOW))).toBe(true);
		expect(await exists(join(root, EVALUATOR))).toBe(true);
	});

	it("says so when there is nothing to take out", async () => {
		const { direct } = await checkout();
		const undone = await direct({ undo: true });
		expect(undone.ok).not.toBe(false);
		expect(undone.message).toContain("No relay job was taken out.");
	});
});

describe("hobo ci init --check", () => {
	it("passes on current files and fails with HOBO_CI_RELAY_FILES_STALE otherwise", async () => {
		const { init, direct, root } = await checkout();
		const missing = await direct({ check: true });
		expect(missing.code).toBe("HOBO_CI_RELAY_FILES_STALE");
		await init("--relay", "job", "--apply", "all");
		const current = await direct({ check: true });
		expect(current.ok).not.toBe(false);
		expect(current.message).toContain(
			"The relay files are current (job mode).",
		);
		await writeFile(join(root, EVALUATOR), `${RELAY_JOB_EVALUATOR}// edited\n`);
		const edited = await direct({ check: true });
		expect(edited.ok).toBe(false);
		expect(edited.code).toBe("HOBO_CI_RELAY_FILES_STALE");
		expect(edited.message).toContain("edited: .hobo-ci/relay.mjs was edited");
	});
});
