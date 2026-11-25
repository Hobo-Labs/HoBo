import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
	join(import.meta.dirname, "..", "..", ".github/workflows/hobo-ci.yml"),
	"utf8",
);

describe("HoBo CI Fabric concurrency", () => {
	it("queues main pushes, cancels stale pull_request and merge_group runs", () => {
		expect(workflow).toContain(`concurrency:
  group: >-
    \${{ github.event_name == 'merge_group' && format('{0}-merge-group-{1}', github.workflow, github.event.merge_group.head_ref) ||
    format('{0}-{1}-{2}', github.workflow, github.event_name, github.ref) }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' || github.event_name == 'merge_group' }}`);
	});

	it("does not put PR sidecars in a shared canceling group", () => {
		expect(workflow).not.toContain("pr-sidecar");
		for (const id of [
			"ci-deps-image",
			"pr-offpath",
			"artifact-trust",
			"dev-cold-loop-gate",
			"data-live",
			"ci-guard",
			"secret-scan",
		]) {
			const block = new RegExp(
				`\\n  ${id}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]+:\\n|$)`,
				"u",
			).exec(workflow)?.[1];
			expect(block, id).toBeDefined();
			expect(block, id).not.toContain("concurrency:");
			expect(block, id).not.toContain("cancel-in-progress:");
		}
	});
});
