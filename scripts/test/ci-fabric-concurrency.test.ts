import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
	join(import.meta.dirname, "..", "..", ".github/workflows/hobo-ci.yml"),
	"utf8",
);

describe("HoBo CI Fabric concurrency", () => {
	it("queues main pushes and cancels only a pull request's older run", () => {
		const block =
			/\nconcurrency:\n {2}group: (.+)\n {2}cancel-in-progress: (.+)\n/u.exec(
				workflow,
			);
		expect(block?.[1]).toBe(
			"${{ github.workflow }}-${{ github.event_name }}-${{ github.ref }}",
		);
		expect(block?.[2]).toBe("${{ github.event_name == 'pull_request' }}");
	});
});
