import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
	join(import.meta.dirname, "..", "..", ".github/workflows/hobo-ci.yml"),
	"utf8",
);

describe("HoBo CI Fabric concurrency", () => {
	// Finding 113: cancelling the running main push on every new push meant no
	// main run finished while the merge queue landed faster than a run takes.
	it("queues main pushes, cancels stale pull_request and merge_group runs", () => {
		expect(workflow).toMatch(
			/cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \|\| github\.event_name == 'merge_group' \}\}/u,
		);
		expect(workflow).toMatch(
			/github\.event_name == 'merge_group' && format\('\{0\}-merge-group-\{1\}', github\.workflow, github\.event\.merge_group\.head_ref\)/u,
		);
		expect(workflow).not.toMatch(
			/cancel-in-progress: \$\{\{ github\.event_name == 'push' \}\}/u,
		);
	});
});
