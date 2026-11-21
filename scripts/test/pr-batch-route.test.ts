import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	type JsonValue,
	main,
	PROBE_WORKFLOW_PATH,
} from "../ci/route-runner.mts";

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
const release = {
	GITHUB_EVENT_NAME: "merge_group",
	GITHUB_WORKFLOW_REF:
		"Hobo-Labs/HoBo/.github/workflows/release-hobo.yml@refs/heads/main",
};
const at = (secondsAgo: number) =>
	new Date(Date.now() - secondsAgo * 1_000).toISOString();
const trunkPickup = {
	run_id: 40,
	status: "completed",
	labels: ["hobo-trunk"],
	runner_name: "runner-1",
	created_at: at(65),
	started_at: at(60),
};
type Answer = (path: string) => JsonValue;
const queue =
	(jobs: readonly JsonValue[] = []): Answer =>
	(path) => {
		const runId = path.match(/\/actions\/runs\/(\d+)\/jobs/u)?.[1];
		if (runId !== undefined) return { jobs: runId === "40" ? jobs : [] };
		if (path.includes("/actions/runs"))
			return {
				workflow_runs:
					jobs.length === 0
						? []
						: [
								{
									id: 40,
									path: PROBE_WORKFLOW_PATH,
									status: "completed",
									created_at: at(65),
									updated_at: at(50),
								},
							],
			};
		return {};
	};
const githubFetch =
	(
		apiUrl: string,
		answer: Answer,
		repo: JsonValue = publicRepo,
	): typeof fetch =>
	async (url) => {
		const text = String(url);
		if (text === "https://api.github.com/repos/Hobo-Labs/HoBo")
			return Response.json(repo);
		if (text.endsWith("/git/ref/hobo/routing-slip"))
			return Response.json({ message: "Not Found" }, { status: 404 });
		if (text.startsWith(apiUrl)) {
			const parsed = new URL(text);
			return Response.json(answer(`${parsed.pathname}${parsed.search}`));
		}
		return Response.json({ message: "unexpected" }, { status: 500 });
	};
function isAddressInfo(
	address: AddressInfo | string | null,
): address is AddressInfo {
	return address !== null && "port" in Object(address);
}
const withGithub = async <T>(
	answer: Answer,
	run: (apiUrl: string) => Promise<T>,
) => {
	const server = createServer((request, response) => {
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify(answer(request.url ?? "")));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!isAddressInfo(address))
		throw new Error("the test server did not bind a TCP port");
	const { port } = address;
	try {
		return await run(`http://127.0.0.1:${port}`);
	} finally {
		await new Promise((done) => server.close(done));
	}
};

describe("PR batch routing", () => {
	it("routes merge-group release batches to hobo-trunk on a healthy pickup", async () => {
		await withGithub(queue([trunkPickup]), async (apiUrl) => {
			for (const args of [[], ["--include-own-run", "true"]]) {
				const decision = await main(
					args,
					{ ...env, ...release, GITHUB_API_URL: apiUrl },
					{
						routingConfig: routing("auto"),
						fetch: githubFetch(apiUrl, queue([trunkPickup])),
					},
				);
				assert.deepEqual(
					[decision.tier, decision.runner],
					["fleet", "hobo-trunk"],
				);
				assert.match(decision.reason, /merge-group trunk confirmation/u);
			}
		});
	});

	it("refuses the merge-group release fallback when public compute cannot be verified", async () => {
		await withGithub(queue(), async (apiUrl) => {
			await assert.rejects(
				main(
					[],
					{ ...env, ...release, GITHUB_API_URL: apiUrl },
					{
						routingConfig: routing("auto"),
						fetch: githubFetch(apiUrl, queue(), {
							...publicRepo,
							private: true,
							visibility: "private",
						}),
					},
				),
				/merge-group.*public compute evidence is unavailable/u,
			);
		});
	});

	it("refuses merge-group release auto routing without committed policy", async () => {
		await assert.rejects(
			main([], { ...env, ...release }, { routingConfig: "{}" }),
			/merge-group Fabric routing requires a valid committed policy/u,
		);
	});

	it("preserves an explicit merge-group fleet pin", async () => {
		const decision = await main(
			[],
			{ ...env, ...release },
			{
				routingConfig: routing("fleet"),
				fetch: async () => {
					throw new Error("unexpected read");
				},
			},
		);
		assert.deepEqual([decision.tier, decision.runner], ["fleet", "hobo-trunk"]);
	});

	it("does not send an optional box into an unreserved merge-group release batch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "merge-batch-route-"));
		try {
			const output = join(dir, "output");
			writeFileSync(output, "");
			await withGithub(queue([trunkPickup]), async (apiUrl) => {
				await main(
					[],
					{
						...env,
						...release,
						GITHUB_API_URL: apiUrl,
						GITHUB_OUTPUT: output,
					},
					{
						routingConfig: JSON.stringify({
							...config,
							runnerRouting: {
								...config.runnerRouting,
								pin: "auto",
								boxRunner: true,
							},
						}),
						fetch: githubFetch(apiUrl, queue([trunkPickup])),
					},
				);
			});
			assert.match(readFileSync(output, "utf8"), /^box_runner=$/mu);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("routes a same-repository PR batch to the verified public standard runner without capacity or trunk pickup", async () => {
		await withGithub(queue(), async (apiUrl) => {
			const decision = await main(
				[],
				{ ...env, GITHUB_API_URL: apiUrl },
				{
					routingConfig: routing("auto"),
					fetch: githubFetch(apiUrl, queue()),
				},
			);
			assert.deepEqual(
				[decision.tier, decision.runner],
				["github", "ubuntu-24.04"],
			);
			assert.match(
				decision.reason,
				/no verified fleet capacity or healthy trunk pickup/u,
			);
		});
	});

	it("routes a same-repository PR batch to hobo-trunk on a healthy pickup", async () => {
		await withGithub(queue([trunkPickup]), async (apiUrl) => {
			const decision = await main(
				[],
				{ ...env, GITHUB_API_URL: apiUrl },
				{
					routingConfig: routing("auto"),
					fetch: githubFetch(apiUrl, queue([trunkPickup])),
				},
			);
			assert.deepEqual(
				[decision.tier, decision.runner],
				["fleet", "hobo-trunk"],
			);
			assert.match(decision.reason, /healthy hobo-trunk queue pickup/u);
		});
	});

	it("routes a fork PR batch to GitHub-hosted without asking the fleet", async () => {
		const decision = await main([], env, {
			routingConfig: routing("auto"),
			fetch: githubFetch("https://api.github.com", queue([trunkPickup])),
			eventPayload: {
				pull_request: {
					head: { repo: { full_name: "someone/HoBo" } },
					base: { repo: { full_name: "Hobo-Labs/HoBo" } },
				},
			},
			verifyPrBatchCapacity: async () => {
				throw new Error("a fork batch must not ask for fleet capacity");
			},
		});
		assert.deepEqual(
			[decision.tier, decision.runner],
			["github", "ubuntu-24.04"],
		);
		assert.match(decision.reason, /fork PR batch must not use the fleet/u);
	});

	it("routes the separate release PR fan-out before its jobs are queued", async () => {
		await withGithub(queue(), async (apiUrl) => {
			const releasePr = {
				...env,
				GITHUB_WORKFLOW_REF:
					"Hobo-Labs/HoBo/.github/workflows/release-hobo.yml@refs/pull/1/merge",
				GITHUB_API_URL: apiUrl,
			};
			const fallback = await main([], releasePr, {
				routingConfig: routing("auto"),
				fetch: githubFetch(apiUrl, queue()),
			});
			assert.equal(fallback.runner, "ubuntu-24.04");
			let verified = false;
			const selected = await main([], releasePr, {
				routingConfig: routing("auto"),
				verifyPrBatchCapacity: async (scope) => {
					assert.equal(
						scope.workflowPath,
						".github/workflows/release-hobo.yml",
					);
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
		await withGithub(queue(), async (apiUrl) => {
			for (const verify of [
				async () => false,
				async () => {
					throw new Error("unavailable");
				},
			]) {
				const decision = await main(
					[],
					{ ...env, GITHUB_API_URL: apiUrl },
					{
						routingConfig: routing("auto"),
						fetch: githubFetch(apiUrl, queue()),
						verifyPrBatchCapacity: verify,
					},
				);
				assert.equal(decision.runner, "ubuntu-24.04");
			}
		});
	});

	it("does not use a capacity answer returned after the routing decision expires", async () => {
		await withGithub(queue([trunkPickup]), async (apiUrl) => {
			let clock = 1_000;
			const decision = await main(
				[],
				{ ...env, GITHUB_API_URL: apiUrl },
				{
					routingConfig: routing("auto"),
					fetch: githubFetch(apiUrl, queue([trunkPickup])),
					now: () => clock,
					verifyPrBatchCapacity: async (scope) => {
						assert.equal(scope.decisionDeadlineMs, 121_000);
						assert.equal(scope.maxQueueWaitSeconds, 120);
						clock = scope.decisionDeadlineMs;
						return true;
					},
				},
			);
			assert.equal(decision.runner, "ubuntu-24.04");
		});
	});

	it("does not accept a missing run identity or an unverified public repository", async () => {
		await withGithub(queue(), async (apiUrl) => {
			let called = false;
			const invalid = { ...env, GITHUB_RUN_ID: "0", GITHUB_API_URL: apiUrl };
			const decision = await main([], invalid, {
				routingConfig: routing("auto"),
				fetch: githubFetch(apiUrl, queue()),
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
					main(
						[],
						{ ...env, GITHUB_API_URL: apiUrl },
						{
							routingConfig: routing("auto"),
							fetch: githubFetch(apiUrl, queue(), repo),
						},
					),
					/public compute evidence is unavailable/u,
				);
			await assert.rejects(
				main(
					[],
					{ ...env, GITHUB_API_URL: apiUrl },
					{
						routingConfig: routing("auto"),
						fetch: async (url) =>
							String(url) === "https://api.github.com/repos/Hobo-Labs/HoBo"
								? new Response("", { status: 403 })
								: githubFetch(apiUrl, queue())(url),
					},
				),
				/public compute evidence is unavailable/u,
			);
			await assert.rejects(
				main(
					[],
					{ ...env, GITHUB_API_URL: apiUrl },
					{
						routingConfig: "{}",
						fetch: githubFetch(apiUrl, queue()),
					},
				),
				/valid committed policy/u,
			);
		});
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

	it("stops the action rather than silently selecting Ubuntu if batch routing fails", () => {
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
			for (const event of ["pull_request", "merge_group"])
				for (const workflow of ["hobo-ci.yml", "release-hobo.yml"]) {
					const result = spawnSync("bash", ["-c", script], {
						cwd: dir,
						encoding: "utf8",
						env: {
							PATH: process.env.PATH ?? "",
							GITHUB_OUTPUT: output,
							GITHUB_EVENT_NAME: event,
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
