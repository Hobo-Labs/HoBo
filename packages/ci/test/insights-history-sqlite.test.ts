import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqliteInsightStore } from "../src/insights/history-sqlite.js";
import type { InsightRun } from "../src/insights/types.js";
import { insightStoreConformance } from "../src/runner-order/testing.js";

function run(id: number, attempt: number, createdAtMs: number): InsightRun {
	return {
		id,
		attempt,
		repository: "octo/app",
		workflow: "CI",
		workflowPath: ".github/workflows/ci.yml",
		event: "pull_request",
		branch: "feature",
		defaultBranch: "main",
		headSha: "0123456789abcdef0123456789abcdef01234567",
		actor: "octocat",
		conclusion: "failure",
		createdAtMs,
		completedAtMs: createdAtMs + 120_000,
		title: "fix: a thing",
		changedPaths: ["src/a.ts"],
		jobs: [
			{
				id: id * 10,
				name: "test",
				labels: ["self-hosted", "linux"],
				runnerName: "box-1",
				runnerGroup: "Default",
				conclusion: "timed_out",
				queuedAtMs: createdAtMs,
				startedAtMs: createdAtMs + 5_000,
				completedAtMs: createdAtMs + 65_000,
				steps: [
					{
						name: "Set up job",
						number: 1,
						conclusion: "success",
						startedAtMs: createdAtMs + 5_000,
						completedAtMs: createdAtMs + 6_000,
					},
					{ name: "Run tests", number: 2, conclusion: "cancelled" },
				],
				needs: ["build"],
				billed: false,
				relay: true,
			},
		],
	};
}

describe("SqliteInsightStore", () => {
	it("keeps the insight store's rules", () =>
		insightStoreConformance(() => SqliteInsightStore.open(":memory:")));

	it("reads a run back field for field, steps, time-outs and needs included", async () => {
		const store = SqliteInsightStore.open(":memory:");
		const kept = run(7, 1, 10_000);
		await store.ingest(kept);
		const [back] = await store.runs({
			repository: "octo/app",
			sinceMs: 0,
			limit: 5,
		});
		expect(back).toEqual(kept);
		expect(await store.attempt("OCTO/app", 7, 1)).toEqual(kept);
		expect(await store.attempt("octo/app", 7, 2)).toBeUndefined();
	});

	it("survives being opened again on the same database", async () => {
		const db = new DatabaseSync(":memory:");
		await new SqliteInsightStore(db).ingest(run(1, 1, 1_000));
		const again = new SqliteInsightStore(db);
		expect(
			await again.runs({ repository: "octo/app", sinceMs: 0, limit: 5 }),
		).toHaveLength(1);
	});

	it("reads nothing for a limit of zero or less", async () => {
		const store = SqliteInsightStore.open(":memory:");
		await store.ingest(run(1, 1, 1_000));
		expect(
			await store.runs({ repository: "octo/app", sinceMs: 0, limit: 0 }),
		).toEqual([]);
		expect(
			await store.runs({ repository: "octo/app", sinceMs: 0, limit: -3 }),
		).toEqual([]);
	});

	it("refuses a run its record rules reject", async () => {
		const store = SqliteInsightStore.open(":memory:");
		await expect(
			store.ingest({ ...run(1, 1, 1_000), headSha: "not-a-sha" }),
		).rejects.toThrow(/headSha/);
	});
});
