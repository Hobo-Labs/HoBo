import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const workflow = readFileSync(
	join(import.meta.dirname, "..", "..", ".github/workflows/hobo-ci.yml"),
	"utf8",
);

describe("HoBo CI Fabric concurrency", () => {
	// Finding 113: cancelling the running main push on every new push meant no
	// main run finished while the merge queue landed faster than a run takes.
	it("isolates merge groups by SHA and cancels only older pull request runs", () => {
		const block =
			/\nconcurrency:\n {2}group: (.+)\n {2}cancel-in-progress: (.+)\n/u.exec(
				workflow,
			);
		assert.equal(
			block?.[1],
			"${{ github.workflow }}-${{ github.event_name }}-${{ github.event_name == 'merge_group' && github.sha || github.ref }}",
		);
		assert.equal(block?.[2], "${{ github.event_name == 'pull_request' }}");
	});
});
