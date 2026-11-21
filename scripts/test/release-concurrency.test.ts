import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const workflow = readFileSync(
	join(import.meta.dirname, "..", "..", ".github/workflows/release-hobo.yml"),
	"utf8",
);

describe("release workflow concurrency", () => {
	it("isolates merge groups by SHA and preserves the workflow_run train", () => {
		const block =
			/\nconcurrency:\n {2}group: (.+)\n {2}cancel-in-progress: (.+)\n/u.exec(
				workflow,
			);
		assert.equal(
			block?.[1],
			"${{ github.event_name == 'workflow_run' && format('hobo-release-train-{0}-{1}', github.event.workflow_run.event, github.event.workflow_run.conclusion) || format('hobo-release-{0}-{1}', github.workflow, github.event_name == 'merge_group' && github.sha || github.ref) }}",
		);
		assert.equal(block?.[2], "${{ github.event_name == 'pull_request' }}");
	});
});
