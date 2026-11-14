import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../ci/route-runner.mts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const config = JSON.parse(readFileSync(join(root, ".hobo/ci.json"), "utf8"));
const routing = (pin: string) =>
	JSON.stringify({
		...config,
		runnerRouting: { ...config.runnerRouting, pin },
	});
const env = {
	GITHUB_WORKSPACE: root,
	GITHUB_EVENT_NAME: "pull_request",
	GITHUB_WORKFLOW_REF:
		"Hobo-Labs/HoBo/.github/workflows/hobo-ci.yml@refs/pull/1/merge",
	GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
	GITHUB_REPOSITORY_ID: "1274791462",
	GITHUB_REPOSITORY_OWNER_ID: "344805935",
	GITHUB_RUN_ID: "73",
	GITHUB_RUN_ATTEMPT: "2",
	GITHUB_SHA: "a".repeat(40),
	GITHUB_TOKEN: "token",
};
const publicRepo = {
	id: 1274791462,
	owner: { id: 344805935 },
	private: false,
	visibility: "public",
	disabled: false,
	archived: false,
};
const readPublic: typeof fetch = async (url) => {
	assert.equal(String(url), "https://api.github.com/repos/Hobo-Labs/HoBo");
	return Response.json(publicRepo);
};

describe("PR batch routing", () => {
	it("routes the whole batch to the verified public standard runner without a capacity claim", async () => {
		const decision = await main([], env, {
			routingConfig: routing("auto"),
			fetch: readPublic,
		});
		assert.deepEqual(
			[decision.tier, decision.runner],
			["github", "ubuntu-24.04"],
		);
		assert.match(decision.reason, /full PR batch.*no verified fleet capacity/u);
	});

	it("routes the separate release PR fan-out before its jobs are queued", async () => {
		const release = {
			...env,
			GITHUB_WORKFLOW_REF:
				"Hobo-Labs/HoBo/.github/workflows/release-hobo.yml@refs/pull/1/merge",
		};
		const fallback = await main([], release, {
			routingConfig: routing("auto"),
			fetch: readPublic,
		});
		assert.equal(fallback.runner, "ubuntu-24.04");
		let verified = false;
		const selected = await main([], release, {
			routingConfig: routing("auto"),
			verifyPrBatchCapacity: async (scope) => {
				assert.equal(scope.workflowPath, ".github/workflows/release-hobo.yml");
				assert.equal(
					scope.workflow,
					readFileSync(join(root, scope.workflowPath), "utf8"),
				);
				verified = true;
				return true;
			},
		});
		assert.equal(verified, true);
		assert.equal(selected.runner, "hobo");
	});

	it("passes the exact run and complete workflow to an independently installed claim verifier", async () => {
		let verified = false;
		const decision = await main([], env, {
			routingConfig: routing("auto"),
			fetch: async () => {
				throw new Error("unexpected GitHub read");
			},
			verifyPrBatchCapacity: async (scope) => {
				assert.equal(scope.repositoryId, 1274791462);
				assert.equal(scope.ownerId, 344805935);
				assert.equal(scope.runId, 73);
				assert.equal(scope.runAttempt, 2);
				assert.equal(scope.revision, "a".repeat(40));
				assert.equal(scope.workflowPath, ".github/workflows/hobo-ci.yml");
				assert.equal(scope.runner, "hobo");
				assert.equal(scope.boxRunner, "");
				assert.equal(
					scope.workflow,
					readFileSync(join(root, ".github/workflows/hobo-ci.yml"), "utf8"),
				);
				verified = true;
				return true;
			},
		});
		assert.equal(verified, true);
		assert.deepEqual([decision.tier, decision.runner], ["fleet", "hobo"]);
	});

	it("uses the public fallback when a claim cannot be verified, including an authority error", async () => {
		for (const verify of [
			async () => false,
			async () => {
				throw new Error("unavailable");
			},
		]) {
			const decision = await main([], env, {
				routingConfig: routing("auto"),
				fetch: readPublic,
				verifyPrBatchCapacity: verify,
			});
			assert.equal(decision.runner, "ubuntu-24.04");
		}
	});

	it("does not use a capacity answer returned after the routing decision expires", async () => {
		let clock = 1_000;
		const decision = await main([], env, {
			routingConfig: routing("auto"),
			fetch: readPublic,
			now: () => clock,
			verifyPrBatchCapacity: async (scope) => {
				assert.equal(scope.decisionDeadlineMs, 121_000);
				assert.equal(scope.maxQueueWaitSeconds, 120);
				clock = scope.decisionDeadlineMs;
				return true;
			},
		});
		assert.equal(decision.runner, "ubuntu-24.04");
	});

	it("does not accept a missing run identity or an unverified public repository", async () => {
		let called = false;
		const invalid = { ...env, GITHUB_RUN_ID: "0" };
		const decision = await main([], invalid, {
			routingConfig: routing("auto"),
			fetch: readPublic,
			verifyPrBatchCapacity: async () => {
				called = true;
				return true;
			},
		});
		assert.equal(called, false);
		assert.equal(decision.runner, "ubuntu-24.04");
		for (const repo of [
			{ ...publicRepo, private: true, visibility: "private" },
			{ ...publicRepo, id: 999 },
			{ ...publicRepo, owner: { id: 999 } },
		])
			await assert.rejects(
				main([], env, {
					routingConfig: routing("auto"),
					fetch: async () => Response.json(repo),
				}),
				/public compute evidence is unavailable/u,
			);
		await assert.rejects(
			main([], env, {
				routingConfig: routing("auto"),
				fetch: async () => new Response("", { status: 403 }),
			}),
			/public compute evidence is unavailable/u,
		);
		await assert.rejects(
			main([], env, { routingConfig: "{}", fetch: readPublic }),
			/valid committed policy/u,
		);
	});

	it("preserves explicit pins without reading public or capacity evidence", async () => {
		for (const pin of ["fleet", "github", "local"]) {
			const decision = await main([], env, {
				routingConfig: routing(pin),
				fetch: async () => {
					throw new Error("unexpected read");
				},
				verifyPrBatchCapacity: async () => {
					throw new Error("unexpected claim");
				},
			});
			assert.equal(decision.slip?.kind, "unasked");
			assert.equal(
				decision.slip?.kind === "unasked" && decision.slip.why,
				"pinned",
			);
		}
	});

	it("stops the action rather than silently selecting Ubuntu if PR routing fails", () => {
		const action = readFileSync(
			join(root, ".github/actions/route-runner/action.yml"),
			"utf8",
		).split("\n");
		const start = action.indexOf("    - id: route");
		const run = action.indexOf("      run: |", start);
		const body: string[] = [];
		for (const line of action.slice(run + 1)) {
			if (line.trim() && !line.startsWith("        ")) break;
			body.push(line.slice(8));
		}
		const script = body
			.join("\n")
			.replace(/^route='\$\{\{.*\}\}'$/m, "route='auto'")
			.replace(/^include_own_run='\$\{\{.*\}\}'$/m, "include_own_run='false'")
			.replace(/^attested='\$\{\{.*\}\}'$/m, "attested='false'");
		const dir = mkdtempSync(join(tmpdir(), "pr-batch-route-"));
		try {
			const output = join(dir, "output");
			writeFileSync(output, "");
			for (const workflow of ["hobo-ci.yml", "release-hobo.yml"]) {
				const result = spawnSync("bash", ["-c", script], {
					cwd: dir,
					encoding: "utf8",
					env: {
						PATH: process.env.PATH ?? "",
						GITHUB_OUTPUT: output,
						GITHUB_EVENT_NAME: "pull_request",
						GITHUB_WORKFLOW_REF: `Hobo-Labs/HoBo/.github/workflows/${workflow}@refs/pull/1/merge`,
					},
				});
				assert.notEqual(result.status, 0);
				assert.doesNotMatch(readFileSync(output, "utf8"), /runner=/u);
				assert.match(result.stdout, /no batch was queued/u);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prevents routed jobs with always-style conditions from starting after route failure", () => {
		const workflow = readFileSync(
			join(root, ".github/workflows/hobo-ci.yml"),
			"utf8",
		);
		for (const job of [
			"ci-deps-image",
			"pr_gate_validation",
			"workspace_tests",
			"pr_affected",
			"scripts-tests",
		]) {
			const body =
				workflow.split(`  ${job}:`)[1]?.split(/\n  [A-Za-z0-9_-]+:/u)[0] ?? "";
			assert.match(body, /needs\.route\.result == 'success'/u, job);
		}
	});

	it("checks out the exact workflow bytes for both batch scopes", () => {
		for (const name of ["hobo-ci.yml", "release-hobo.yml"]) {
			const source = readFileSync(
				join(root, ".github/workflows", name),
				"utf8",
			);
			const route =
				source.split("\n  route:")[1]?.split(/\n  [A-Za-z0-9_-]+:/u)[0] ?? "";
			assert.ok(
				route.includes(`            .github/workflows/${name}\n`),
				name,
			);
		}
	});
});
