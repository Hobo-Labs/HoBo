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
				"packages/ci/src/fleet-overflow.ts",
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
				"packages/ci/src/fleet-overflow.ts",
			])
				assert.ok(sparse.split(/\s+/u).includes(path), path);
			assert.equal(
				steps.find((step) => step?.id === "route")?.uses,
				"./.github/actions/route-runner",
			);
		});
	}

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
				"packages/ci/src/fleet-overflow.ts",
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
					runnerRouting: { ...policy.runnerRouting, pin: "fleet" },
				}),
			);
			writeFileSync(
				join(workspace, ".hobo/ci.json"),
				JSON.stringify({
					...policy,
					runnerRouting: { ...policy.runnerRouting, pin: "github" },
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
			assert.match(selected.output, /^runner=hobo-trunk$/mu);
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
			"${{ needs.route.outputs.runner || 'ubuntu-24.04' }}",
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

describe("pr-fabric reuse routing", () => {
	const hoboCi = readFileSync(".github/workflows/hobo-ci.yml", "utf8");
	const routeAction = workflowDocument(
		readFileSync(".github/actions/route-runner/action.yml", "utf8"),
	);

	const routeJob = () =>
		asObject(asObject(workflowDocument(hoboCi).jobs)?.route);

	const routeSteps = () => asList(routeJob()?.steps)?.map(asObject) ?? [];

	const compositeSteps = () =>
		asList(asObject(routeAction.runs)?.steps)?.map(asObject) ?? [];

	it("limits the hobo-ci route job to reading Actions, contents, and pull requests", () => {
		assert.deepEqual(asObject(routeJob()?.permissions), {
			actions: "read",
			contents: "read",
			"pull-requests": "read",
		});
		const keys = Object.keys(asObject(routeJob()?.permissions) ?? {});
		assert.deepEqual(keys.sort(), ["actions", "contents", "pull-requests"]);
	});

	it("invokes the route action only from the trusted base checkout", () => {
		const routeStep = routeSteps().find((step) => step?.id === "route");
		assert.equal(routeStep?.uses, "./.ci-trusted/.github/actions/route-runner");
	});

	it("loads pr-fabric-reuse only from the trusted base sparse checkout", () => {
		const steps = routeSteps();
		const trusted = steps.find(
			(step) => asObject(step?.with)?.path === ".ci-trusted",
		);
		const candidate = steps.find(
			(step) =>
				asText(step?.uses)?.startsWith("actions/checkout@") &&
				!asObject(step?.with)?.path,
		);
		assert.ok(trusted && candidate);
		assert.equal(
			asText(asObject(trusted.with)?.ref),
			"${{ steps.routing-base.outputs.sha }}",
		);
		const trustedSparse =
			asText(asObject(trusted.with)?.["sparse-checkout"]) ?? "";
		const candidateSparse =
			asText(asObject(candidate.with)?.["sparse-checkout"]) ?? "";
		assert.ok(
			trustedSparse.split(/\s+/u).includes("scripts/ci/pr-fabric-reuse.mts"),
		);
		assert.equal(
			candidateSparse.includes("scripts/ci/pr-fabric-reuse.mts"),
			false,
		);
	});

	it("maps the composite pr-fabric reuse bit to the route job output", () => {
		assert.match(
			hoboCi,
			/^\s+pr-fabric-green: \$\{\{ steps\.route\.outputs\.pr-fabric-green \}\}/mu,
		);
		const outputs = asObject(routeAction.outputs);
		assert.equal(
			asText(asObject(outputs?.["pr-fabric-green"])?.value),
			"${{ steps.pr-fabric.outputs.reuse || 'false' }}",
		);
	});

	it("runs pr-fabric reuse after attestation and only on merge groups", () => {
		const ids = compositeSteps().map((step) => asText(step?.id));
		const attestAt = ids.indexOf("attest");
		const prFabricAt = ids.indexOf("pr-fabric");
		assert.ok(attestAt >= 0 && prFabricAt > attestAt);
		const prFabricStep = compositeSteps().find(
			(step) => step?.id === "pr-fabric",
		);
		assert.match(
			asText(prFabricStep?.if),
			/github\.event_name == 'merge_group'/u,
		);
		const shell = asText(prFabricStep?.run);
		assert.ok(shell);
		assert.match(
			shell,
			/script="\$\{action_root\}\/scripts\/ci\/pr-fabric-reuse\.mts"/u,
		);
		assert.match(shell, /"\$\{node_bin\}" --no-warnings "\$\{script\}"/u);
		assert.doesNotMatch(
			shell,
			/"[^"]*" --no-warnings scripts\/ci\/pr-fabric-reuse\.mts/u,
		);
		assert.match(
			shell,
			/action_root="\$\(cd "\$\{GITHUB_ACTION_PATH\}\/\.\.\/\.\.\/\.\." && pwd -P\)"/u,
		);
		const env = asObject(
			compositeSteps().find((step) => step?.id === "pr-fabric")?.env,
		);
		assert.equal(asText(env?.GITHUB_TOKEN), "${{ inputs.token }}");
	});

	it("reads mergeGroup reuse policy from the trusted-base script tree", () => {
		const source = readFileSync("scripts/ci/pr-fabric-reuse.mts", "utf8");
		assert.match(
			source,
			/join\(import\.meta\.dirname, "\.\.", "\.\.", RUNNER_ROUTING_PATH\)/u,
		);
	});
});
