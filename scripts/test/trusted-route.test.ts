import assert from "node:assert/strict";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
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
import { join } from "node:path";
import { describe, it } from "node:test";
import { asList, asObject, asText } from "../ci/attestation.mts";
import { workflowDocument } from "../lib/workflow-job-steps.mts";

const PROVEN_NONE =
	"reuse=false\nreuse-run=\nproven-base=\nproven-tree=\nproven-run=\nproven-pr=\n";

describe("base-controlled attestation verification", () => {
	for (const workflow of ["hobo-ci.yml", "release-hobo.yml"]) {
		it(`${workflow} loads the route action and verifier from the event base`, () => {
			const doc = workflowDocument(
				readFileSync(`.github/workflows/${workflow}`, "utf8"),
			);
			const route = asObject(asObject(doc.jobs)?.route);
			const steps = asList(route?.steps)?.map(asObject) ?? [];
			const checkout = steps.find(
				(step) => asObject(step?.with)?.path === ".ci-trusted",
			);
			assert.ok(checkout);
			assert.match(
				asText(checkout.uses) ?? "",
				/^actions\/checkout@[a-f0-9]{40}$/u,
			);
			const options = asObject(checkout.with);
			assert.equal(options?.ref, "${{ steps.routing-base.outputs.sha }}");
			assert.equal(options?.["persist-credentials"], false);
			const sparse = asText(options?.["sparse-checkout"]) ?? "";
			for (const path of [
				".github/actions/route-runner",
				".hobo/ci.json",
				"scripts/ci/route-runner.mts",
				"scripts/ci/runner-routing.mts",
				"scripts/ci/attestation.mts",
				"scripts/ci/verify-attestation.mts",
			])
				assert.ok(sparse.split(/\s+/u).includes(path), path);
			const routeStep = steps.find((step) => step?.id === "route");
			assert.equal(
				routeStep?.uses,
				"./.ci-trusted/.github/actions/route-runner",
			);
		});
	}

	for (const workflow of [
		"pricing-ci.yml",
		"release-pricing.yml",
		"release-ts-autocode.yml",
	]) {
		it(`${workflow} loads routing from the event base`, () => {
			const doc = workflowDocument(
				readFileSync(`.github/workflows/${workflow}`, "utf8"),
			);
			const route = asObject(asObject(doc.jobs)?.route);
			const steps = asList(route?.steps)?.map(asObject) ?? [];
			const checkout = steps.find((step) =>
				asText(step?.uses)?.startsWith("actions/checkout@"),
			);
			assert.ok(checkout);
			const options = asObject(checkout.with);
			assert.equal(options?.ref, "${{ steps.routing-base.outputs.sha }}");
			assert.equal(options?.["persist-credentials"], false);
			const sparse = asText(options?.["sparse-checkout"]) ?? "";
			for (const path of [
				".github/actions/route-runner",
				".hobo/ci.json",
				"scripts/ci/route-runner.mts",
				"scripts/ci/runner-routing.mts",
			])
				assert.ok(sparse.split(/\s+/u).includes(path), path);
			assert.equal(
				steps.find((step) => step?.id === "route")?.uses,
				"./.github/actions/route-runner",
			);
		});
	}

	it("exposes the merge-group PR Fabric reuse answer from the trusted base only (hobo-ci.yml)", () => {
		const doc = workflowDocument(
			readFileSync(".github/workflows/hobo-ci.yml", "utf8"),
		);
		const route = asObject(asObject(doc.jobs)?.route);
		const steps = asList(route?.steps)?.map(asObject) ?? [];
		const checkout = steps.find(
			(step) => asObject(step?.with)?.path === ".ci-trusted",
		);
		const sparse = asText(asObject(checkout?.with)?.["sparse-checkout"]) ?? "";
		assert.ok(
			sparse.split(/\s+/u).includes("scripts/ci/pr-fabric-reuse.mts"),
			"the trusted base checkout must hold the pr-fabric reuse script",
		);
		assert.equal(
			asObject(route?.outputs)?.["pr-fabric-green"],
			"${{ steps.route.outputs.pr-fabric-green }}",
		);
	});

	it("refuses a missing or invalid event base instead of trusting the candidate", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-routing-base-"));
		try {
			for (const workflow of [
				"hobo-ci.yml",
				"release-hobo.yml",
				"pricing-ci.yml",
				"release-pricing.yml",
				"release-ts-autocode.yml",
			]) {
				const doc = workflowDocument(
					readFileSync(`.github/workflows/${workflow}`, "utf8"),
				);
				const steps =
					asList(asObject(asObject(doc.jobs)?.route)?.steps)?.map(asObject) ??
					[];
				const step = steps.find((value) => value?.id === "routing-base");
				const shell = asText(step?.run);
				assert.ok(shell);
				for (const [event, pr, merge, expected] of [
					["pull_request", "a".repeat(40), "", "a".repeat(40)],
					["merge_group", "", "b".repeat(40), "b".repeat(40)],
					["push", "", "", "c".repeat(40)],
					["pull_request", "", "", ""],
					["merge_group", "", "", ""],
					["pull_request", "bad", "", ""],
				] as const) {
					const output = join(dir, "output");
					writeFileSync(output, "");
					const child: SpawnSyncReturns<string> = spawnSync(
						"bash",
						["-c", shell],
						{
							cwd: dir,
							encoding: "utf8",
							env: {
								PATH: process.env.PATH ?? "",
								GITHUB_EVENT_NAME: event,
								PR_BASE_SHA: pr,
								MERGE_BASE_SHA: merge,
								GITHUB_SHA: "c".repeat(40),
								GITHUB_OUTPUT: output,
							},
						},
					);
					if (expected) {
						assert.equal(child.status, 0, workflow);
						assert.equal(readFileSync(output, "utf8"), `sha=${expected}\n`);
					} else {
						assert.notEqual(child.status, 0, workflow);
						assert.equal(readFileSync(output, "utf8"), "");
					}
				}
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("routes from the base action's code and handles missing base files by route kind", () => {
		const workspace = mkdtempSync(join(tmpdir(), "hobo-trusted-batch-"));
		try {
			const action = workflowDocument(
				readFileSync(".github/actions/route-runner/action.yml", "utf8"),
			);
			const steps = asList(asObject(action.runs)?.steps)?.map(asObject) ?? [];
			const shell = asText(steps.find((step) => step?.id === "route")?.run)
				?.replace(/^route='\$\{\{.*\}\}'$/mu, "route='auto'")
				.replace(
					/^include_own_run='\$\{\{.*\}\}'$/mu,
					"include_own_run='false'",
				)
				.replace(/^attested='\$\{\{.*\}\}'$/mu, "attested='false'");
			assert.ok(shell);
			const trusted = join(workspace, ".ci-trusted");
			const actionDir = join(trusted, ".github/actions/route-runner");
			mkdirSync(actionDir, { recursive: true });
			for (const path of [
				"scripts/ci/route-runner.mts",
				"scripts/ci/runner-routing.mts",
			]) {
				const dest = join(trusted, path);
				mkdirSync(join(dest, ".."), { recursive: true });
				copyFileSync(path, dest);
			}
			const policy = JSON.parse(readFileSync(".hobo/ci.json", "utf8"));
			const trustedPolicy = join(trusted, ".hobo/ci.json");
			mkdirSync(join(trusted, ".hobo"), { recursive: true });
			mkdirSync(join(workspace, ".hobo"), { recursive: true });
			writeFileSync(
				trustedPolicy,
				JSON.stringify({
					...policy,
					runnerRouting: { ...policy.runnerRouting, pin: "github" },
				}),
			);
			writeFileSync(
				join(workspace, ".hobo/ci.json"),
				JSON.stringify({
					...policy,
					runnerRouting: { ...policy.runnerRouting, pin: "fleet" },
				}),
			);
			const candidate = join(workspace, "scripts/ci");
			mkdirSync(candidate, { recursive: true });
			const marker = join(workspace, "candidate-ran");
			writeFileSync(
				join(candidate, "route-runner.mts"),
				`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "yes");`,
			);
			const output = join(workspace, "output");
			const run = () => {
				writeFileSync(output, "");
				const child = spawnSync("bash", ["-c", shell], {
					cwd: workspace,
					encoding: "utf8",
					env: {
						PATH: process.env.PATH ?? "",
						GITHUB_ACTION_PATH: actionDir,
						GITHUB_WORKSPACE: workspace,
						GITHUB_OUTPUT: output,
						GITHUB_EVENT_NAME: "merge_group",
						GITHUB_WORKFLOW_REF:
							"Hobo-Labs/HoBo/.github/workflows/hobo-ci.yml@refs/heads/main",
					},
				});
				return { child, output: readFileSync(output, "utf8") };
			};
			const selected = run();
			assert.equal(selected.child.status, 0, selected.child.stderr);
			assert.match(selected.output, /^runner=ubuntu-24\.04$/mu);
			assert.equal(existsSync(marker), false);
			rmSync(trustedPolicy);
			const missingPolicy = run();
			assert.notEqual(missingPolicy.child.status, 0);
			assert.doesNotMatch(missingPolicy.output, /^runner=/mu);
			rmSync(join(trusted, "scripts/ci/route-runner.mts"));
			const missingScript = run();
			assert.notEqual(missingScript.child.status, 0);
			assert.doesNotMatch(missingScript.output, /^runner=/mu);
			assert.equal(existsSync(marker), false);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("fails closed when a batch fleet pin cannot be verified", () => {
		const workspace = mkdtempSync(join(tmpdir(), "hobo-fleet-pin-"));
		try {
			const action = workflowDocument(
				readFileSync(".github/actions/route-runner/action.yml", "utf8"),
			);
			const steps = asList(asObject(action.runs)?.steps)?.map(asObject) ?? [];
			const shell = asText(steps.find((step) => step?.id === "route")?.run)
				?.replace(/^route='\$\{\{.*\}\}'$/mu, "route='fleet'")
				.replace(
					/^include_own_run='\$\{\{.*\}\}'$/mu,
					"include_own_run='false'",
				)
				.replace(/^attested='\$\{\{.*\}\}'$/mu, "attested='false'");
			assert.ok(shell);
			const actionDir = join(workspace, ".github/actions/route-runner");
			mkdirSync(actionDir, { recursive: true });
			mkdirSync(join(workspace, "scripts/ci"), { recursive: true });
			writeFileSync(
				join(workspace, "scripts/ci/route-runner.mts"),
				"process.exitCode = 1;\n",
			);
			const output = join(workspace, "output");
			for (const event of [
				"merge_group",
				"pull_request",
				"workflow_dispatch",
			]) {
				writeFileSync(output, "");
				const child: SpawnSyncReturns<string> = spawnSync(
					"bash",
					["-c", shell],
					{
						cwd: workspace,
						encoding: "utf8",
						env: {
							PATH: process.env.PATH ?? "",
							GITHUB_ACTION_PATH: actionDir,
							GITHUB_WORKSPACE: workspace,
							GITHUB_OUTPUT: output,
							GITHUB_EVENT_NAME: event,
							GITHUB_WORKFLOW_REF:
								"Hobo-Labs/HoBo/.github/workflows/hobo-ci.yml@refs/heads/main",
						},
					},
				);
				const result = readFileSync(output, "utf8");
				if (event === "workflow_dispatch") {
					assert.equal(child.status, 0, child.stderr);
					assert.match(result, /^runner=hobo-trunk$/mu);
				} else {
					assert.notEqual(child.status, 0, event);
					assert.doesNotMatch(result, /^runner=/mu);
				}
			}
			writeFileSync(
				join(workspace, "scripts/ci/route-runner.mts"),
				'import { appendFileSync } from "node:fs"; appendFileSync(process.env.GITHUB_OUTPUT, "runner=hobo-trunk\\n");',
			);
			writeFileSync(output, "");
			const selected = spawnSync("bash", ["-c", shell], {
				cwd: workspace,
				encoding: "utf8",
				env: {
					PATH: process.env.PATH ?? "",
					GITHUB_ACTION_PATH: actionDir,
					GITHUB_WORKSPACE: workspace,
					GITHUB_OUTPUT: output,
					GITHUB_EVENT_NAME: "merge_group",
				},
			});
			assert.equal(selected.status, 0, selected.stderr);
			assert.match(readFileSync(output, "utf8"), /^runner=hobo-trunk$/mu);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	for (const workflow of ["hobo-ci.yml", "release-hobo.yml"]) {
		it(`${workflow} keeps merge-group routing on its pinned runners`, () => {
			const doc = workflowDocument(
				readFileSync(`.github/workflows/${workflow}`, "utf8"),
			);
			const route = asObject(asObject(doc.jobs)?.route);
			assert.equal(
				route?.["runs-on"],
				workflow === "hobo-ci.yml"
					? "${{ github.event_name == 'merge_group' && 'hobo-trunk' || 'ubuntu-24.04' }}"
					: "ubuntu-24.04",
			);
			assert.equal(asObject(doc.jobs)?.["mq-route-surface"], undefined);
			const routeStep = asList(route?.steps)
				?.map(asObject)
				.find((step) => step?.id === "route");
			const withBlock = asObject(routeStep?.with);
			assert.equal(
				asText(withBlock?.route),
				workflow === "hobo-ci.yml"
					? "${{ inputs.route || (github.event_name == 'merge_group' && 'fleet') || 'auto' }}"
					: "auto",
			);
		});
	}

	it("hobo-ci.yml leaves a full worktree after a merge-group route on a reused runner", () => {
		const doc = workflowDocument(
			readFileSync(".github/workflows/hobo-ci.yml", "utf8"),
		);
		const steps =
			asList(asObject(asObject(doc.jobs)?.route)?.steps)?.map(asObject) ?? [];
		const cleanup = steps.at(-1);
		assert.equal(
			cleanup?.name,
			"Leave a full worktree for the next job on this runner",
		);
		assert.equal(
			asText(cleanup?.if),
			"always() && github.event_name == 'merge_group'",
		);
		const script = asText(cleanup?.run);
		assert.ok(script);
		const workspace = mkdtempSync(join(tmpdir(), "hobo-route-unsparse-"));
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
		);
		const git = (...args: string[]) =>
			spawnSync("git", args, { cwd: workspace, encoding: "utf8", env });
		try {
			assert.equal(git("init", "-q").status, 0);
			git("config", "user.email", "ci@example.invalid");
			git("config", "user.name", "ci");
			mkdirSync(join(workspace, "kept"), { recursive: true });
			mkdirSync(join(workspace, "dropped"), { recursive: true });
			writeFileSync(join(workspace, "kept", "a.txt"), "a\n");
			writeFileSync(join(workspace, "dropped", "b.txt"), "b\n");
			git("add", ".");
			git("commit", "-q", "-m", "init");
			git("sparse-checkout", "set", "--no-cone", "/kept/");
			git("config", "core.sparseCheckoutCone", "true");
			mkdirSync(join(workspace, ".ci-trusted"), { recursive: true });
			assert.equal(existsSync(join(workspace, "dropped", "b.txt")), false);
			const ran = spawnSync("bash", ["-c", script], {
				cwd: workspace,
				encoding: "utf8",
				env,
			});
			assert.equal(ran.status, 0, ran.stderr);
			assert.equal(existsSync(join(workspace, "dropped", "b.txt")), true);
			assert.equal(existsSync(join(workspace, ".ci-trusted")), false);
			assert.equal(git("ls-files", "-t").stdout.includes("S "), false);
			assert.notEqual(
				git("config", "core.sparseCheckout").stdout.trim(),
				"true",
			);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("decides PR Fabric reuse beside the checked-out base action, never from the candidate's copy", () => {
		const workspace = mkdtempSync(join(tmpdir(), "hobo-pr-fabric-route-"));
		try {
			const action = workflowDocument(
				readFileSync(".github/actions/route-runner/action.yml", "utf8"),
			);
			const steps = asList(asObject(action.runs)?.steps)?.map(asObject) ?? [];
			const shell = asText(steps.find((step) => step?.id === "pr-fabric")?.run);
			assert.ok(shell);
			const actionDir = join(
				workspace,
				".ci-trusted",
				".github",
				"actions",
				"route-runner",
			);
			const trustedCi = join(workspace, ".ci-trusted", "scripts", "ci");
			const candidateCi = join(workspace, "scripts", "ci");
			mkdirSync(actionDir, { recursive: true });
			mkdirSync(trustedCi, { recursive: true });
			mkdirSync(candidateCi, { recursive: true });
			copyFileSync(
				"scripts/ci/pr-fabric-reuse.mts",
				join(trustedCi, "pr-fabric-reuse.mts"),
			);
			copyFileSync(
				"scripts/ci/runner-routing.mts",
				join(trustedCi, "runner-routing.mts"),
			);
			const marker = join(workspace, "candidate-ran");
			writeFileSync(
				join(candidateCi, "pr-fabric-reuse.mts"),
				`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "yes");`,
			);
			mkdirSync(join(workspace, ".ci-trusted", ".hobo"), { recursive: true });
			mkdirSync(join(workspace, ".hobo"), { recursive: true });
			const policy = JSON.parse(readFileSync(".hobo/ci.json", "utf8"));
			const trustedPolicy = (enabled: boolean) =>
				JSON.stringify({
					...policy,
					runnerRouting: {
						...policy.runnerRouting,
						mergeGroup: { reusePrFabric: enabled },
					},
				});
			writeFileSync(
				join(workspace, ".ci-trusted", ".hobo", "ci.json"),
				trustedPolicy(false),
			);
			writeFileSync(join(workspace, ".hobo", "ci.json"), trustedPolicy(true));
			const output = join(workspace, "output");
			const run = () => {
				writeFileSync(output, "");
				const child = spawnSync("bash", ["-c", shell], {
					cwd: workspace,
					encoding: "utf8",
					env: {
						PATH: process.env.PATH ?? "",
						GITHUB_ACTION_PATH: actionDir,
						GITHUB_OUTPUT: output,
						GITHUB_EVENT_NAME: "merge_group",
						GITHUB_REF: `refs/heads/gh-readonly-queue/main/pr-12-${"b".repeat(40)}`,
						BASE_SHA: "b".repeat(40),
						HEAD_SHA: "d".repeat(40),
						GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
					},
				});
				return {
					status: child.status,
					stdout: child.stdout + child.stderr,
					output: readFileSync(output, "utf8"),
				};
			};
			const policyOff = run();
			assert.equal(policyOff.status, 0, policyOff.stdout);
			assert.match(
				policyOff.stdout,
				/runnerRouting\.mergeGroup\.reusePrFabric is false/u,
			);
			assert.equal(policyOff.output, PROVEN_NONE);
			assert.equal(existsSync(marker), false);
			writeFileSync(
				join(workspace, ".ci-trusted", ".hobo", "ci.json"),
				trustedPolicy(true),
			);
			const unreadRuns = run();
			assert.equal(unreadRuns.status, 0, unreadRuns.stdout);
			assert.match(
				unreadRuns.stdout,
				/the workflow's pull-request runs could not be read/u,
			);
			assert.equal(unreadRuns.output, PROVEN_NONE);
			assert.equal(existsSync(marker), false);
			rmSync(join(trustedCi, "pr-fabric-reuse.mts"));
			const missing = run();
			assert.equal(missing.status, 0, missing.stdout);
			assert.match(
				missing.stdout,
				/this workflow does not reuse pull-request Fabric runs/u,
			);
			assert.equal(existsSync(marker), false);
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("keeps merge-group shards on the original route", () => {
		const workflow = workflowDocument(
			readFileSync(".github/workflows/hobo-ci.yml", "utf8"),
		);
		const jobs = asObject(workflow.jobs);
		for (const id of ["pr_gate_plan", "pr_gate_validation"]) {
			const steps = asList(asObject(jobs?.[id])?.steps)?.map(asObject) ?? [];
			assert.equal(
				steps.some((step) => step?.id === "shard-route"),
				false,
				id,
			);
		}
		assert.equal(
			asObject(jobs?.workspace_tests)?.["runs-on"],
			"${{ needs.route.result == 'success' && (needs.route.outputs.runner || 'ubuntu-24.04') || 'ubuntu-24.04' }}",
		);
	});

	it("executes the verifier beside the checked-out base action, never the tested copy", () => {
		const workspace = mkdtempSync(join(tmpdir(), "hobo-trusted-route-"));
		try {
			const action = workflowDocument(
				readFileSync(".github/actions/route-runner/action.yml", "utf8"),
			);
			const shell = asText(
				asObject(asList(asObject(action.runs)?.steps)?.[0])?.run,
			);
			assert.ok(shell);
			const actionDir = join(
				workspace,
				".ci-trusted",
				".github",
				"actions",
				"route-runner",
			);
			const trustedDir = join(workspace, ".ci-trusted", "scripts", "ci");
			const testedDir = join(workspace, "scripts", "ci");
			mkdirSync(actionDir, { recursive: true });
			mkdirSync(trustedDir, { recursive: true });
			mkdirSync(testedDir, { recursive: true });
			const marker = join(workspace, "verifier-cwd");
			const program = (value: string) =>
				`import { appendFileSync, writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, process.cwd()); appendFileSync(process.env.GITHUB_OUTPUT, "attested=${value}\\nattested-jobs=[]\\n");`;
			writeFileSync(join(testedDir, "verify-attestation.mts"), program("true"));
			writeFileSync(
				join(trustedDir, "verify-attestation.mts"),
				program("false"),
			);
			const output = join(workspace, "output");
			const run = () => {
				writeFileSync(output, "");
				const child = spawnSync("bash", ["-c", shell], {
					cwd: workspace,
					encoding: "utf8",
					env: {
						...process.env,
						GITHUB_ACTION_PATH: actionDir,
						GITHUB_OUTPUT: output,
					},
				});
				assert.equal(child.status, 0, child.stderr);
				return readFileSync(output, "utf8");
			};
			assert.equal(run(), "attested=false\nattested-jobs=[]\n");
			assert.equal(readFileSync(marker, "utf8"), workspace);
			rmSync(join(trustedDir, "verify-attestation.mts"));
			assert.equal(run(), "attested=false\nattested-jobs=[]\n");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
