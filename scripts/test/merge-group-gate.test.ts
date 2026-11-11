import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
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
import { GIT_LOCATION_VARIABLES } from "../ci/local-attest.mts";

// Git sets GIT_DIR, GIT_INDEX_FILE and the like for the hooks it runs. These
// tests run from pre-commit too, and every git command they start (their own
// or a script's) must act on its own repository, never the one being committed.
for (const name of GIT_LOCATION_VARIABLES) delete process.env[name];

const workflow = readFileSync(".github/workflows/hobo-ci.yml", "utf8");
const cacheAction = readFileSync(
	".github/actions/turbo-cache/action.yml",
	"utf8",
);

function job(name: string): string {
	const lines = workflow.split("\n");
	const start = lines.indexOf(`  ${name}:`);
	assert.ok(start >= 0, `missing job ${name}`);
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^  [A-Za-z0-9_-]+:$/u.test(line));
	return rest.slice(0, end < 0 ? rest.length : end).join("\n");
}

function shellForStep(block: string, name: string): string {
	const start = block.indexOf(`      - name: ${name}\n`);
	assert.ok(start >= 0, `missing step ${name}`);
	const step = block.slice(start);
	const match = step.match(/\n        run: \|\n((?: {10}[^\n]*\n?)+)/u);
	const body = match?.[1];
	assert.ok(body !== undefined, `missing shell for ${name}`);
	return body.replace(/^ {10}/gmu, "");
}

function stepTimeoutMinutes(block: string, name: string): number {
	const start = block.indexOf(`      - name: ${name}\n`);
	assert.ok(start >= 0, `missing step ${name}`);
	const next = block.indexOf("\n      - ", start + 1);
	const step = block.slice(start, next < 0 ? block.length : next);
	const minutes = step.match(/^ {8}timeout-minutes: (\d+)$/mu)?.[1];
	assert.ok(minutes !== undefined, `step ${name} has no timeout-minutes`);
	return Number(minutes);
}

describe("merge-group required gate", () => {
	const validation = job("pr_gate_validation");
	const workspace = job("workspace_tests");
	const affected = job("pr_affected");
	const gate = job("pr-gate");

	it("requires validation, all workspace shards, and the PR package lanes", () => {
		assert.match(validation, /name: S0 gate set/u);
		assert.match(
			validation,
			/pnpm agent:check -- --base="\$BASE" --external-workspace-tests/u,
		);
		assert.match(
			validation,
			/merge_base: \$\{\{ steps\.merge-group-base\.outputs\.base \}\}/u,
		);
		assert.match(
			validation,
			/merge_tests: \$\{\{ steps\.merge-group-base\.outputs\.tests \}\}/u,
		);
		assert.match(workspace, /needs: \[route, pr_gate_validation\]/u);
		assert.match(workspace, /needs\.pr_gate_validation\.result == 'success'/u);
		assert.match(workspace, /needs\.pr_gate_validation\.outputs\.merge_base/u);
		assert.match(workspace, /needs\.pr_gate_validation\.outputs\.merge_tests/u);
		assert.match(workspace, /needs\.pr_gate_validation\.outputs\.pr_base/u);
		assert.match(
			validation,
			/shards: \$\{\{ steps\.shard-plan\.outputs\.shards \}\}/u,
		);
		assert.match(workspace, /fail-fast: false/u);
		assert.match(workspace, /scripts\/ci\/dependent-tests\.mts/u);
		assert.match(affected, /needs: \[route, pr_gate_validation\]/u);
		assert.match(
			affected,
			/turbo run build typecheck lint test:unit test:schema test:contract:consumer/u,
		);
		assert.match(
			gate,
			/needs: \[route, pr_gate_validation, workspace_tests, pr_affected\]/u,
		);
		assert.match(gate, /if: \$\{\{ always\(\)/u);
	});

	it("runs the planned shards, all eight when the plan is missing, and splits by job position", () => {
		const plan = validation.slice(
			validation.indexOf("name: Plan workspace test shards"),
		);
		// Every way of not having a plan keeps the eight shards.
		assert.match(plan, /shards='\[0, 1, 2, 3, 4, 5, 6, 7\]'/u);
		assert.match(plan, /--plan-shards=8\)" \|\| planned=""/u);
		assert.match(
			plan,
			/\[\[ "\$planned" =~ \^\\\[\[0-7\]\(,\\ \[0-7\]\)\*\\\]\$ \]\]/u,
		);
		assert.match(plan, /\[ "\$TESTS" = "affected" \] && \[ -n "\$BASE" \]/u);
		assert.match(
			workspace,
			/shard: \$\{\{ fromJSON\(needs\.pr_gate_validation\.outputs\.shards \|\| '\[0, 1, 2, 3, 4, 5, 6, 7\]'\) \}\}/u,
		);
		// The split follows the matrix GitHub actually built, not the plan's
		// own count: a list and a count could disagree and drop a suite.
		assert.match(workspace, /SHARD: \$\{\{ strategy\.job-index \}\}/u);
		assert.match(workspace, /SHARD_TOTAL: \$\{\{ strategy\.job-total \}\}/u);
		assert.equal(
			workspace.match(/--shard="\$SHARD\/\$SHARD_TOTAL"/gu)?.length,
			2,
		);
		assert.doesNotMatch(workspace, /--shard="\$SHARD\/8"/u);
	});

	it("never treats a failed, cancelled, skipped, or unknown prerequisite as success", () => {
		const script = shellForStep(
			gate,
			"Require successful validation and workspace tests",
		);
		const statuses = [
			"success",
			"failure",
			"cancelled",
			"skipped",
			"timed_out",
			"",
		];
		for (const event of ["pull_request", "merge_group", "push"]) {
			for (const validationResult of statuses) {
				for (const workspaceResult of statuses) {
					for (const affectedResult of statuses) {
						const run = spawnSync("bash", ["-c", script], {
							env: {
								...process.env,
								EVENT_NAME: event,
								VALIDATION_RESULT: validationResult,
								WORKSPACE_RESULT: workspaceResult,
								AFFECTED_RESULT: affectedResult,
							},
						});
						const expected =
							validationResult === "success" &&
							workspaceResult === "success" &&
							((event === "pull_request" && affectedResult === "success") ||
								(event === "merge_group" && affectedResult === "skipped"));
						assert.equal(
							run.status === 0,
							expected,
							`${event}/${validationResult}/${workspaceResult}/${affectedResult}`,
						);
					}
				}
			}
		}
	});

	// With a verified signed local run, the covered jobs are skipped, not run.
	// The gate takes a skipped job only then, and a failed job never.
	it("accepts a skipped job only when the route job succeeded and reported it attested", () => {
		const script = shellForStep(
			gate,
			"Require successful validation and workspace tests",
		);
		const statuses = ["success", "failure", "cancelled", "skipped"];
		const routes = ["success", "failure", "skipped", ""];
		const flags = ["true", "false", ""];
		const lists = [
			'["pr_gate_validation","workspace_tests","pr_affected","ci-guard"]',
			'["pr_gate_validation"]',
			'["ci-guard","secret-scan"]',
			// Ids that only contain a gate job's id are other jobs.
			'["pr_gate_validation_2","xworkspace_tests","pr_affected-old"]',
			"[]",
			"",
		];
		type Case = Readonly<{
			event: string;
			validation: string;
			workspace: string;
			affected: string;
			route: string;
			flag: string;
			list: string;
		}>;
		const cases: Case[] = [];
		for (const event of ["pull_request", "merge_group", "push"])
			for (const validation of statuses)
				for (const workspace of statuses)
					for (const affected of statuses)
						for (const route of routes)
							for (const flag of flags)
								for (const list of lists)
									cases.push({
										event,
										validation,
										workspace,
										affected,
										route,
										flag,
										list,
									});
		// One shell for the whole table: each case runs the gate's own script
		// in a subshell and prints its exit status.
		const quote = (text: string) => `'${text}'`;
		const driver = [
			"gate() {",
			'  ( export EVENT_NAME="$1" VALIDATION_RESULT="$2" WORKSPACE_RESULT="$3"',
			'    export AFFECTED_RESULT="$4" ROUTE_RESULT="$5" ATTESTED="$6" ATTESTED_JOBS="$7"',
			script,
			"  ) >/dev/null 2>&1",
			"  echo $?",
			"}",
			...cases.map(
				(entry) =>
					`gate ${[entry.event, entry.validation, entry.workspace, entry.affected, entry.route, entry.flag, entry.list].map(quote).join(" ")}`,
			),
		].join("\n");
		// From a file: the table is too long for one argument.
		const directory = mkdtempSync(join(tmpdir(), "hobo-gate-table-"));
		writeFileSync(join(directory, "table.sh"), driver);
		const run = spawnSync("bash", [join(directory, "table.sh")], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});
		rmSync(directory, { recursive: true, force: true });
		assert.equal(run.status, 0, run.stderr);
		const exits = run.stdout.trim().split("\n");
		assert.equal(exits.length, cases.length);
		let acceptedSkips = 0;
		for (const [index, entry] of cases.entries()) {
			const jobs: string[] = entry.list === "" ? [] : JSON.parse(entry.list);
			const attested = (job: string) =>
				entry.route === "success" &&
				entry.flag === "true" &&
				jobs.includes(job);
			const passed = (result: string, job: string) =>
				result === "success" || (result === "skipped" && attested(job));
			const expected =
				passed(entry.validation, "pr_gate_validation") &&
				passed(entry.workspace, "workspace_tests") &&
				((entry.event === "pull_request" &&
					passed(entry.affected, "pr_affected")) ||
					(entry.event === "merge_group" && entry.affected === "skipped"));
			const accepted = exits[index] === "0";
			assert.equal(accepted, expected, JSON.stringify(entry));
			const results = [entry.validation, entry.workspace, entry.affected];
			// A failed or cancelled job never passes, attested or not.
			if (
				results.some((result) => result === "failure" || result === "cancelled")
			)
				assert.equal(accepted, false, JSON.stringify(entry));
			// Without a route job that succeeded and said `true`, nothing changes:
			// a skipped validation or workspace job is refused as before.
			if (
				(entry.route !== "success" || entry.flag !== "true") &&
				(entry.validation !== "success" || entry.workspace !== "success")
			)
				assert.equal(accepted, false, JSON.stringify(entry));
			if (
				accepted &&
				results.includes("skipped") &&
				entry.event === "pull_request"
			)
				acceptedSkips += 1;
		}
		// The table does reach the new case: skipped jobs accepted for an attestation.
		assert.ok(acceptedSkips > 0);
	});

	it("skips each of the gate's jobs for an attestation that names it, and nothing else", () => {
		for (const [block, id] of [
			[validation, "pr_gate_validation"],
			[workspace, "workspace_tests"],
			[affected, "pr_affected"],
		] as const) {
			const condition = block.match(/^ {4}if: (.*)$/mu)?.[1] ?? "";
			assert.ok(
				condition.endsWith(
					`&& !(needs.route.outputs.attested == 'true' && contains(needs.route.outputs.attested-jobs, '"${id}"')) }}`,
				),
				id,
			);
		}
		// The gate still always runs, and reads the route job's own result.
		assert.match(gate, /ROUTE_RESULT: \$\{\{ needs\.route\.result \}\}/u);
		assert.match(
			gate,
			/ATTESTED: \$\{\{ needs\.route\.outputs\.attested \}\}/u,
		);
		assert.match(
			gate,
			/ATTESTED_JOBS: \$\{\{ needs\.route\.outputs\.attested-jobs \}\}/u,
		);
	});

	it("rejects a missing scope or an unreachable affected base", () => {
		const script = shellForStep(workspace, "Workspace tests");
		for (const [tests, base] of [
			["", ""],
			["unexpected", ""],
			["affected", ""],
			["affected", "not-a-commit"],
		]) {
			const run = spawnSync("bash", ["-c", script], {
				env: {
					...process.env,
					EVENT_NAME: "merge_group",
					MERGE_TESTS: tests,
					MERGE_BASE: base,
					SHARD: "0",
				},
			});
			assert.notEqual(run.status, 0, `${tests}/${base}`);
		}
	});

	it("fails the PR package lane if the impact planner fails", () => {
		const script = shellForStep(affected, "Affected package lanes");
		const directory = mkdtempSync(join(tmpdir(), "hobo-affected-plan-"));
		try {
			writeFileSync(
				join(directory, "git"),
				'#!/bin/sh\n[ "$1" != diff ] || echo packages/ci/src/x.ts\n',
				{ mode: 0o755 },
			);
			writeFileSync(join(directory, "node"), "#!/bin/sh\nexit 42\n", {
				mode: 0o755,
			});
			const run = spawnSync("bash", ["-c", script], {
				env: {
					...process.env,
					PATH: `${directory}:${process.env.PATH ?? ""}`,
					RUNNER_TEMP: directory,
					TURBO_SCM_BASE: "valid",
				},
			});
			assert.equal(run.status, 42);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("pins the PR merge base before passing it between jobs", () => {
		const script = shellForStep(validation, "Resolve Turbo SCM base");
		const directory = mkdtempSync(join(tmpdir(), "hobo-pr-base-"));
		try {
			const sha = "a".repeat(40);
			const eventBase = "b".repeat(40);
			const output = join(directory, "output");
			const marker = join(directory, "injected");
			writeFileSync(
				join(directory, "git"),
				`#!/bin/sh\ncase "$1" in\n  cat-file) exit 0;;\n  merge-base) printf '%s' "$2" > "$CAPTURE"; printf '${sha}';;\n  *) exit 1;;\nesac\n`,
				{ mode: 0o755 },
			);
			const run = spawnSync("bash", ["-c", script], {
				env: {
					...process.env,
					PATH: `${directory}:${process.env.PATH ?? ""}`,
					PR_BASE_SHA: eventBase,
					GITHUB_OUTPUT: output,
					CAPTURE: join(directory, "base"),
				},
			});
			assert.equal(run.status, 0, String(run.stderr));
			assert.equal(readFileSync(output, "utf8"), `base=${sha}\n`);
			assert.equal(readFileSync(join(directory, "base"), "utf8"), eventBase);
			const invalid = spawnSync("bash", ["-c", script], {
				env: {
					...process.env,
					PATH: `${directory}:${process.env.PATH ?? ""}`,
					PR_BASE_SHA: `main$(touch ${marker})`,
					GITHUB_OUTPUT: output,
					CAPTURE: join(directory, "base"),
				},
			});
			assert.notEqual(invalid.status, 0);
			assert.equal(existsSync(marker), false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("refuses external workspace coverage without an explicit CI diff base", () => {
		for (const args of [
			["--external-workspace-tests"],
			["--external-workspace-tests", "--staged", "--base=HEAD"],
		]) {
			const run = spawnSync(process.execPath, [
				"--import",
				"tsx",
				"scripts/run-relevant-checks.ts",
				...args,
			]);
			assert.equal(run.status, 2);
		}
	});

	it("builds @hobo/core and @hobo/data before the bindles schema lane", () => {
		const pkg = readFileSync("package.json", "utf8");
		const marker = pkg.indexOf('"test:schema":');
		assert.ok(marker >= 0, "missing root test:schema script");
		const script = pkg.slice(marker, pkg.indexOf("\n", marker));
		const build = script.indexOf(
			"turbo run build --filter=@hobo/core --filter=@hobo/data",
		);
		const bindles = script.indexOf("--filter @hobo/bindles run test:schema");
		assert.ok(build >= 0, "test:schema does not build core/data first");
		assert.ok(
			bindles > build,
			"bindles test:schema must run after the core/data build",
		);
	});

	it("prefers the same-run validation cache before older cache entries", () => {
		assert.match(workspace, /preferred-job: pr_gate_validation/u);
		assert.match(affected, /preferred-job: pr_gate_validation/u);
		assert.match(
			cacheAction,
			/inputs\.preferred-job.*github\.sha.*github\.run_attempt/u,
		);
		assert.match(
			cacheAction,
			/steps\.prerequisite\.outputs\.cache-hit != 'true'/u,
		);
	});
});

describe("main S0 gate set", () => {
	it("gets the same step window on main as in the merge group", () => {
		// Same commands on the same runners: a window that passes a commit in
		// the merge queue and then times it out on main fails main, not the PR.
		assert.equal(
			stepTimeoutMinutes(job("main-gate"), "S0 gate set"),
			stepTimeoutMinutes(job("pr_gate_validation"), "S0 gate set"),
		);
	});
});

describe("DCO sign-off check", () => {
	const script = shellForStep(job("pr_gate_validation"), "DCO sign-off check");
	const author = { name: "Dana Contributor", email: "dana@example.com" };

	function repository() {
		const directory = mkdtempSync(join(tmpdir(), "hobo-dco-"));
		const env = {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_AUTHOR_NAME: author.name,
			GIT_AUTHOR_EMAIL: author.email,
			GIT_COMMITTER_NAME: author.name,
			GIT_COMMITTER_EMAIL: author.email,
		};
		const git = (...args: string[]): void => {
			const run = spawnSync("git", args, { cwd: directory, env });
			assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
		};
		git("init", "--quiet", "--initial-branch=main");
		git("commit", "--quiet", "--allow-empty", "-m", "base");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		git("checkout", "--quiet", "-b", "feature");
		return {
			directory,
			git,
			check: (base = "origin/main") =>
				spawnSync("bash", ["-c", script], {
					cwd: directory,
					env: { ...env, DCO_BASE: base },
					encoding: "utf8",
				}),
		};
	}

	it("checks the commits a contributor wrote and skips merge commits", () => {
		const repo = repository();
		try {
			repo.git("commit", "--quiet", "--allow-empty", "-s", "-m", "feature");
			repo.git("checkout", "--quiet", "-b", "side", "main");
			repo.git("commit", "--quiet", "--allow-empty", "-s", "-m", "side");
			repo.git("checkout", "--quiet", "feature");
			// What GitHub's update-branch and the PR merge ref produce: a merge
			// commit with no sign-off trailer.
			repo.git("merge", "--quiet", "--no-ff", "-m", "Merge side", "side");
			const signed = repo.check();
			assert.equal(signed.status, 0, `${signed.stdout}${signed.stderr}`);
			assert.match(
				signed.stdout,
				/All commits carry a matching DCO sign-off\./u,
			);

			repo.git("commit", "--quiet", "--allow-empty", "-m", "unsigned");
			const unsigned = repo.check();
			assert.equal(unsigned.status, 1);
			assert.match(
				unsigned.stdout,
				/::warning::missing or mismatched DCO sign-off on [0-9a-f]+ unsigned /u,
			);
			assert.match(unsigned.stdout, /^1 commit\(s\) without/mu);
		} finally {
			rmSync(repo.directory, { recursive: true, force: true });
		}
	});

	it("fails rather than passing when the commit range cannot be listed", () => {
		const repo = repository();
		try {
			repo.git("commit", "--quiet", "--allow-empty", "-m", "unsigned");
			const run = repo.check("origin/missing");
			assert.notEqual(run.status, 0);
			assert.doesNotMatch(run.stdout, /All commits carry/u);
		} finally {
			rmSync(repo.directory, { recursive: true, force: true });
		}
	});
});

describe("cold dev loop gate", () => {
	const script = shellForStep(
		job("dev-cold-loop-gate"),
		"Cold hobo dev gate (network disabled)",
	);

	type Runner = {
		environment: string;
		/** The worker image is already in the runner's Docker context. */
		image: boolean;
		/** `ensure-ci-worker-image.mts --materialize-only` can pull it from GHCR. */
		pullable: boolean;
		/** The runner has `sudo` (an ARC pod does not). */
		sudo: boolean;
	};

	// Stubs record their arguments. `docker image inspect` answers from a marker
	// file that the `node` stub (standing in for the GHCR pull) creates, and
	// `docker run` drains the tree. Only these stubs and a few real tools are on
	// PATH, so a runner without `sudo` really has none.
	function run(runner: Runner) {
		const directory = mkdtempSync(join(tmpdir(), "hobo-cold-loop-"));
		try {
			const bin = join(directory, "bin");
			const tree = join(directory, "tree");
			const calls = join(directory, "calls");
			const image = join(directory, "image");
			mkdirSync(bin);
			mkdirSync(tree);
			mkdirSync(join(directory, "tmp"));
			writeFileSync(join(tree, "package.json"), "{}\n");
			if (runner.image) writeFileSync(image, "");
			for (const tool of ["sh", "bash", "tar", "mktemp", "cat", "touch"]) {
				const found = spawnSync("bash", ["-c", `command -v ${tool}`], {
					encoding: "utf8",
				}).stdout.trim();
				symlinkSync(found, join(bin, tool));
			}
			writeFileSync(
				join(bin, "docker"),
				[
					"#!/bin/sh",
					'echo "docker $*" >> "$CALLS"',
					'if [ "$1 $2" = "image inspect" ]; then [ -e "$IMAGE" ]; exit $?; fi',
					"cat > /dev/null",
					"",
				].join("\n"),
				{ mode: 0o755 },
			);
			writeFileSync(
				join(bin, "node"),
				[
					"#!/bin/sh",
					'echo "node $*" >> "$CALLS"',
					'echo "node-token ${GITHUB_TOKEN:-}" >> "$CALLS"',
					'if [ "$PULLABLE" = 1 ]; then touch "$IMAGE"; exit 0; fi',
					"exit 2",
					"",
				].join("\n"),
				{ mode: 0o755 },
			);
			if (runner.sudo) {
				writeFileSync(
					join(bin, "sudo"),
					'#!/bin/sh\necho "sudo $*" >> "$CALLS"\necho "sudo-env ${HOBO_GHCR_PULL_TOKEN:-}${GITHUB_TOKEN:-}" >> "$CALLS"\n',
					{ mode: 0o755 },
				);
			}
			const result = spawnSync(join(bin, "bash"), ["-c", script], {
				cwd: tree,
				env: {
					PATH: bin,
					HOME: directory,
					TMPDIR: join(directory, "tmp"),
					CALLS: calls,
					IMAGE: image,
					PULLABLE: runner.pullable ? "1" : "0",
					HOBO_GHCR_PULL_TOKEN: "pull-secret",
					RUNNER_ENVIRONMENT: runner.environment,
				},
				encoding: "utf8",
			});
			return {
				status: result.status,
				calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
				output: `${result.stdout}${result.stderr}`,
			};
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}

	const dockerRun =
		/^docker run -i --rm --network=none hobo-ci-worker:local bash -c /mu;
	const sudoNamespace = /^sudo --preserve-env unshare --net -- bash -c /mu;
	const materialize =
		/^node --no-warnings scripts\/ci\/ensure-ci-worker-image\.mts --materialize-only$/mu;

	it("runs in the worker image when a fleet box has it", () => {
		const { status, calls, output } = run({
			environment: "self-hosted",
			image: true,
			pullable: false,
			sudo: true,
		});
		assert.equal(status, 0, output);
		assert.match(calls, dockerRun);
		assert.doesNotMatch(calls, materialize);
		assert.doesNotMatch(calls, /^sudo /mu);
	});

	it("pulls the worker image on an ARC pod, which has Docker but no sudo", () => {
		const { status, calls, output } = run({
			environment: "self-hosted",
			image: false,
			pullable: true,
			sudo: false,
		});
		assert.equal(status, 0, output);
		assert.match(calls, materialize);
		assert.match(calls, /^node-token pull-secret$/mu);
		assert.match(calls, dockerRun);
	});

	it("falls back to a sudo namespace when the image cannot be pulled", () => {
		const { status, calls, output } = run({
			environment: "self-hosted",
			image: false,
			pullable: false,
			sudo: true,
		});
		assert.equal(status, 0, output);
		assert.match(calls, materialize);
		assert.match(calls, sudoNamespace);
		assert.doesNotMatch(calls, /^docker run /mu);
	});

	it("fails with the reason when there is no image, no pull and no sudo", () => {
		const { status, calls, output } = run({
			environment: "self-hosted",
			image: false,
			pullable: false,
			sudo: false,
		});
		assert.equal(status, 1, output);
		assert.match(
			output,
			/::error title=Cold dev loop cannot isolate the network::/u,
		);
		assert.doesNotMatch(calls, /^docker run /mu);
		assert.doesNotMatch(output, /command not found/u);
	});

	it("uses the sudo namespace on a GitHub-hosted runner without pulling", () => {
		const { status, calls, output } = run({
			environment: "github-hosted",
			image: true,
			pullable: true,
			sudo: true,
		});
		assert.equal(status, 0, output);
		assert.match(calls, sudoNamespace);
		assert.doesNotMatch(calls, /^docker /mu);
		assert.doesNotMatch(calls, materialize);
		// The cold loop exits when it finds a credential in its environment.
		assert.match(calls, /^sudo-env $/mu);
	});
});

describe("release required gate", () => {
	const release = readFileSync(".github/workflows/release-hobo.yml", "utf8");
	const lines = release.split("\n");
	const start = lines.indexOf("  release-pr-gate:");
	assert.ok(start >= 0, "missing job release-pr-gate");
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^  [A-Za-z0-9_-]+:$/u.test(line));
	const gate = rest.slice(0, end < 0 ? rest.length : end).join("\n");
	const script = shellForStep(gate, "Fail closed when release contract is red");

	it("uses the same attested() helper as the PR impact gate", () => {
		const helper = (text: string) => {
			const from = text.indexOf("attested() {");
			assert.ok(from >= 0);
			return text.slice(from, text.indexOf("\n}\n", from) + 2);
		};
		const prGate = shellForStep(
			job("pr-gate"),
			"Require successful validation and workspace tests",
		);
		assert.equal(helper(script), helper(prGate));
		assert.match(gate, /needs: \[route, release-contract\]/u);
	});

	it("accepts a skipped contract only for a route job that succeeded and attested it", () => {
		const results = ["success", "failure", "cancelled", "skipped", ""];
		const routes = ["success", "failure", "skipped", ""];
		const flags = ["true", "false", "TRUE", ""];
		const lists = [
			'["release-contract"]',
			'["ci-guard","release-contract"]',
			'["ci-guard"]',
			'["release-contract-old"]',
			"[]",
			"",
		];
		const directory = mkdtempSync(join(tmpdir(), "hobo-release-gate-"));
		try {
			for (const contract of results)
				for (const route of routes)
					for (const flag of flags)
						for (const list of lists) {
							const run = spawnSync("bash", ["-c", script], {
								env: {
									...process.env,
									CONTRACT_RESULT: contract,
									ROUTE_RESULT: route,
									ATTESTED: flag,
									ATTESTED_JOBS: list,
								},
							});
							const attested =
								route === "success" &&
								flag === "true" &&
								list.includes('"release-contract"');
							const expected =
								route === "success" &&
								(contract === "success" ||
									(contract === "skipped" && attested));
							const label = JSON.stringify({ contract, route, flag, list });
							assert.equal(run.status === 0, expected, label);
							// A failed or cancelled contract never passes, attested or not.
							if (contract === "failure" || contract === "cancelled")
								assert.notEqual(run.status, 0, label);
						}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
