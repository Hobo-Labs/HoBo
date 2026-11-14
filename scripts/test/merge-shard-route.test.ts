import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	isPublicCaller,
	main,
	mergeShardRunner,
	shardCount,
} from "../ci/merge-shard-route.mts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const project = JSON.parse(readFileSync(join(root, ".hobo/ci.json"), "utf8"));
const routing = (pin: string) =>
	JSON.stringify({
		...project,
		runnerRouting: { ...project.runnerRouting, pin },
	});
const githubEnv = {
	GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
	GITHUB_REPOSITORY_ID: "1274791462",
	GITHUB_REPOSITORY_OWNER_ID: "344805935",
	GITHUB_TOKEN: "test-token",
};
const publicRepo = {
	id: 1274791462,
	owner: { id: 344805935 },
	private: false,
	visibility: "public",
	disabled: false,
	archived: false,
};

describe("merge-group shard routing", () => {
	it("uses the configured GitHub fallback for an automatic multi-shard batch", () => {
		assert.equal(
			mergeShardRunner({
				event: "merge_group",
				plan: "[0, 1, 2, 3, 4, 5, 6, 7]",
				publicRepository: true,
				routingConfig: routing("auto"),
			}),
			"ubuntu-24.04",
		);
	});
	it("keeps explicit pins, single shards and other workflow events on their original route", () => {
		for (const pin of ["fleet", "local", "github"]) {
			assert.equal(
				mergeShardRunner({
					event: "merge_group",
					plan: "[0, 1]",
					publicRepository: true,
					routingConfig: routing(pin),
				}),
				undefined,
			);
		}
		assert.equal(
			mergeShardRunner({
				event: "merge_group",
				plan: "[0]",
				publicRepository: true,
				routingConfig: routing("auto"),
			}),
			undefined,
		);
		assert.equal(
			mergeShardRunner({
				event: "pull_request",
				plan: "[0, 1]",
				publicRepository: true,
				routingConfig: routing("auto"),
			}),
			undefined,
		);
	});
	it("keeps the original route when the committed policy is missing or invalid", () => {
		for (const routingConfig of [undefined, "", "invalid", "{}"]) {
			assert.equal(
				mergeShardRunner({
					event: "merge_group",
					plan: "[0, 1]",
					publicRepository: true,
					routingConfig,
				}),
				undefined,
			);
		}
	});
	it("treats an invalid shard plan as a full batch", () => {
		for (const plan of ["", "[]", "[0, 0]", "[8]", "invalid"]) {
			assert.equal(shardCount(plan), 8);
			assert.equal(
				mergeShardRunner({
					event: "merge_group",
					plan,
					publicRepository: true,
					routingConfig: routing("auto"),
				}),
				"ubuntu-24.04",
			);
		}
	});
	it("does not apply the override to a private or unverified caller", () => {
		assert.equal(
			mergeShardRunner({
				event: "merge_group",
				plan: "[0, 1]",
				publicRepository: false,
				routingConfig: routing("auto"),
			}),
			undefined,
		);
		const config = JSON.parse(routing("auto"));
		config.runnerRouting.labels.github = "custom-runner";
		assert.equal(
			mergeShardRunner({
				event: "merge_group",
				plan: "[0, 1]",
				publicRepository: true,
				routingConfig: JSON.stringify(config),
			}),
			undefined,
		);
	});
	it("verifies the exact public caller using a bounded GitHub read", async () => {
		const read: typeof fetch = async (url, init) => {
			assert.equal(String(url), "https://api.github.com/repos/Hobo-Labs/HoBo");
			assert.equal(init?.method, "GET");
			assert.equal(init?.redirect, "error");
			assert.equal(
				new Headers(init?.headers).get("authorization"),
				"Bearer test-token",
			);
			return Response.json(publicRepo);
		};
		assert.equal(await isPublicCaller(githubEnv, read), true);
		for (const repo of [
			{ ...publicRepo, private: true, visibility: "private" },
			{ ...publicRepo, id: 9 },
			{ ...publicRepo, owner: { id: 9 } },
			{ ...publicRepo, disabled: true },
			{ ...publicRepo, archived: true },
			{ ...publicRepo, padding: "x".repeat(70_000) },
		])
			assert.equal(
				await isPublicCaller(githubEnv, async () => Response.json(repo)),
				false,
			);
		assert.equal(
			await isPublicCaller(
				githubEnv,
				async () => new Response("", { status: 403 }),
			),
			false,
		);
		assert.equal(
			await isPublicCaller(
				{ ...githubEnv, GITHUB_REPOSITORY: "../HoBo" },
				read,
			),
			false,
		);
	});
	it("writes the selected label before the workspace matrix is queued", async () => {
		const dir = mkdtempSync(join(tmpdir(), "merge-shard-route-"));
		try {
			const output = join(dir, "output");
			writeFileSync(output, "");
			await main(
				{
					...githubEnv,
					GITHUB_EVENT_NAME: "merge_group",
					GITHUB_OUTPUT: output,
					HOBO_PLANNED_SHARDS: "[0, 1]",
				},
				async () => Response.json(publicRepo),
			);
			assert.equal(readFileSync(output, "utf8"), "runner=ubuntu-24.04\n");
			const workflow = readFileSync(
				join(root, ".github/workflows/hobo-ci.yml"),
				"utf8",
			);
			const plan = workflow.indexOf("id: shard-plan");
			const route = workflow.indexOf("id: shard-route");
			const batch = workflow.indexOf("  workspace_tests:");
			assert.ok(plan >= 0 && plan < route && route < batch);
			assert.match(
				workflow,
				/shard_runner: \$\{\{ steps\.shard-route\.outputs\.runner \}\}/u,
			);
			assert.match(
				workflow.slice(batch),
				/runs-on: \$\{\{ needs\.pr_gate_validation\.outputs\.shard_runner \|\| needs\.route\.outputs\.runner/u,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("leaves the original route in place when the repository read is denied", async () => {
		const dir = mkdtempSync(join(tmpdir(), "merge-shard-route-"));
		try {
			const output = join(dir, "output");
			writeFileSync(output, "");
			await main(
				{
					...githubEnv,
					GITHUB_EVENT_NAME: "merge_group",
					GITHUB_OUTPUT: output,
					HOBO_PLANNED_SHARDS: "[0, 1]",
				},
				async () => new Response("", { status: 403 }),
			);
			assert.equal(readFileSync(output, "utf8"), "");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
