import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  # unit tests
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test
  build:
    runs-on: ubuntu-24.04 # pinned
    steps:
      - run: pnpm build
  mac:
    runs-on: macos-15
    steps:
      - run: swift build
  deploy:
    runs-on: ubuntu-24.04
    environment: production
    steps:
      - run: ./deploy.sh
        env:
          TOKEN: \${{ secrets.DEPLOY_TOKEN }}
`;

const RELEASE = `name: release
on: workflow_dispatch
jobs:
  test:
    runs-on: hobo
    steps:
      - run: pnpm test
  publish:
    uses: ./.github/workflows/publish.yml
`;

async function repository(
	workflows: Readonly<Record<string, string>> = {
		"ci.yml": CI,
		"release.yaml": RELEASE,
	},
) {
	const root = await mkdtemp(join(tmpdir(), "hobo-ci-init-"));
	directories.push(root);
	const directory = join(root, ".github", "workflows");
	await mkdir(directory, { recursive: true });
	for (const [name, text] of Object.entries(workflows))
		await writeFile(join(directory, name), text);
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: {},
				git: async (args) => {
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
	const workflow = (name: string) => readFile(join(directory, name), "utf8");
	return { root, init, workflow };
}

describe("hobo ci init", () => {
	it("plans by default and changes nothing", async () => {
		const { init, workflow } = await repository();
		const { exitCode, envelope } = await init();
		expect(exitCode).toBe(0);
		const message: string = envelope.message;
		expect(message).toContain(
			"Fleet label: hobo. 2 ready, 1 already on the fleet, 3 skipped.",
		);
		expect(message).toContain(".github/workflows/ci.yml");
		expect(message).toContain("  test  [ubuntu-latest]  ready (moving_image)");
		expect(message).toContain("  build  [ubuntu-24.04]  ready");
		expect(message).toContain("  mac  [macos-15]  skipped (not_linux_x64)");
		expect(message).toContain(
			"  deploy  [ubuntu-24.04]  skipped (uses_secrets)",
		);
		expect(message).toContain("  test  [hobo]  already on the fleet");
		expect(message).toContain(
			"  publish  [no runs-on]  skipped (reusable_workflow)",
		);
		expect(message).toMatch(
			/Skipped:\n {2}not_linux_x64: .+\n {2}uses_secrets: .+\n {2}reusable_workflow: /u,
		);
		expect(message).toContain("Warnings:\n  moving_image: ");
		expect(message).toContain("hobo ci init --apply all");
		expect(
			envelope.data.plans.map((plan: { file: string }) => plan.file),
		).toEqual([".github/workflows/ci.yml", ".github/workflows/release.yaml"]);
		expect(await workflow("ci.yml")).toBe(CI);
	});

	it("rewrites only the runs-on of every ready job with --apply all", async () => {
		const { init, workflow } = await repository();
		const { exitCode, envelope } = await init("--apply", "all");
		expect(exitCode).toBe(0);
		expect(envelope.data.changed).toEqual([
			{ file: ".github/workflows/ci.yml", job: "test" },
			{ file: ".github/workflows/ci.yml", job: "build" },
		]);
		expect(envelope.data.refused).toEqual([]);
		expect(envelope.message).toContain(
			"Rewrote runs-on to hobo for 2 job(s). Nothing was committed; review the diff.",
		);
		const after = await workflow("ci.yml");
		expect(after).toBe(
			CI.replace(
				"runs-on: ubuntu-latest",
				"runs-on: hobo # was ubuntu-latest",
			).replace("runs-on: ubuntu-24.04 # pinned", "runs-on: hobo # pinned"),
		);
		expect(await workflow("release.yaml")).toBe(RELEASE);

		const again = await init("--apply", "all");
		expect(again.envelope.data.changed).toEqual([]);
		expect(await workflow("ci.yml")).toBe(after);
	});

	it("does not overwrite a workflow edited after it was planned", async () => {
		const edited = `${CI}\n# another edit\n`;
		let contents = CI;
		let reads = 0;
		let writes = 0;
		const result = await runCiInit({
			cwd: "/repo",
			args: [],
			options: { apply: "test" },
			files: {
				list: async () => ["ci.yml"],
				read: async () => {
					if (++reads === 2) contents = edited;
					return contents;
				},
				write: async (_path, text) => {
					writes++;
					contents = text;
				},
			},
		});
		expect(writes).toBe(0);
		expect(contents).toBe(edited);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("changed since it was planned");
	});

	it("does not recreate a workflow that disappears after planning", async () => {
		let reads = 0;
		let writes = 0;
		const result = await runCiInit({
			cwd: "/repo",
			args: [],
			options: { apply: "test" },
			files: {
				list: async () => ["ci.yml"],
				read: async () => {
					if (++reads > 1) throw new Error("removed");
					return CI;
				},
				write: async () => {
					writes++;
				},
			},
		});
		expect(writes).toBe(0);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("cannot be read");
	});

	it("applies named jobs, by id or by file:id, and says what it refused", async () => {
		const { init, workflow } = await repository();
		const { exitCode, envelope } = await init(
			"--apply",
			"ci.yml:build,mac",
			"--apply",
			"nope",
		);
		expect(exitCode).not.toBe(0);
		expect(envelope.code).toBe("HOBO_CI_INIT_PARTIAL");
		expect(envelope.data.changed).toEqual([
			{ file: ".github/workflows/ci.yml", job: "build" },
		]);
		expect(
			envelope.data.refused.map((entry: { job: string }) => entry.job),
		).toEqual(["mac", "nope"]);
		expect(envelope.message).toContain("Not rewritten:");
		expect(envelope.message).toContain("nope: no such job");
		const after = await workflow("ci.yml");
		expect(after).toContain("runs-on: ubuntu-latest\n");
		expect(after).toContain("runs-on: hobo # pinned");
	});

	it("reports a missing scoped job even when another file has the same job id", async () => {
		const { init } = await repository();
		const { envelope } = await init("--apply", "ci.yml:test,missing.yml:test");
		expect(envelope.data.changed).toEqual([
			{ file: ".github/workflows/ci.yml", job: "test" },
		]);
		expect(envelope.data.refused).toContainEqual({
			file: "",
			job: "missing.yml:test",
			why: "no such job",
		});
	});

	it("fails when nothing asked for could be rewritten", async () => {
		const { init, workflow } = await repository();
		const { exitCode, envelope } = await init("--apply", "deploy");
		expect(exitCode).not.toBe(0);
		expect(envelope.code).toBe("HOBO_CI_INIT_NOTHING_APPLIED");
		expect(await workflow("ci.yml")).toBe(CI);
	});

	it("moves a job that uses secrets only when asked to", async () => {
		const { init, workflow } = await repository();
		const { envelope } = await init(
			"--apply",
			"deploy",
			"--include-secret-jobs",
			"--fleet-label",
			"hobo-trunk",
		);
		expect(envelope.data.changed).toEqual([
			{ file: ".github/workflows/ci.yml", job: "deploy" },
		]);
		expect(await workflow("ci.yml")).toContain(
			"runs-on: hobo-trunk # was ubuntu-24.04\n    environment: production",
		);
	});

	it("reports a workflow that is not YAML and still plans the rest", async () => {
		const { init } = await repository({
			"broken.yml": "jobs:\n  a: [unclosed\n",
			"ci.yml": CI,
		});
		const { exitCode, envelope } = await init();
		expect(exitCode).toBe(0);
		expect(envelope.message).toMatch(
			/\.github\/workflows\/broken\.yml\n {2}cannot be read: /u,
		);
		expect(envelope.message).toContain("2 ready");
	});

	it("reports a workflow directory read failure", async () => {
		const result = await runCiInit({
			cwd: "/repo",
			args: [],
			options: {},
			files: {
				list: async () => {
					throw new Error("permission denied");
				},
				read: async () => CI,
				write: async () => {},
			},
		});
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_WORKFLOWS_UNREADABLE",
		});
	});

	it("reports an unreadable workflow and fails a partial apply", async () => {
		const writes: string[] = [];
		const result = await runCiInit({
			cwd: "/repo",
			args: [],
			options: { apply: "all" },
			files: {
				list: async () => ["broken.yml", "ci.yml"],
				read: async (path) => {
					if (path.includes("broken.yml")) throw new Error("permission denied");
					return CI;
				},
				write: async (path) => {
					writes.push(path);
				},
			},
		});
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_INIT_PARTIAL",
			data: {
				changed: [
					{ file: ".github/workflows/ci.yml", job: "test" },
					{ file: ".github/workflows/ci.yml", job: "build" },
				],
				refused: [
					{
						file: ".github/workflows/broken.yml",
						job: "(workflow)",
						why: "the file cannot be read",
					},
				],
			},
		});
		expect(writes).toEqual(["/repo/.github/workflows/ci.yml"]);
	});

	it("says so when the repository has no workflows", async () => {
		const { init } = await repository({});
		const { exitCode, envelope } = await init();
		expect(exitCode).not.toBe(0);
		expect(envelope.code).toBe("HOBO_CI_NO_WORKFLOWS");
	});

	it.each([
		[["--plan", "--apply", "all"], "Pass --plan or --apply, not both."],
		[["--apply", ","], "--apply takes job ids"],
		[["--fleet-label", "two labels"], "--fleet-label takes one runs-on label."],
		[["extra"], "takes no positional arguments"],
	])("reports a usage error for %j", async (args, message) => {
		const { init } = await repository();
		const { exitCode, envelope } = await init(...args);
		expect(exitCode).not.toBe(0);
		expect(envelope.code).toBe("HOBO_CLI_USAGE");
		expect(envelope.message).toContain(message);
	});
});
