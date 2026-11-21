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

	it("gives PR sidecar jobs one hosted runner so they cannot starve the gate", () => {
		const group = "${{ github.workflow }}-pr-sidecar-${{ github.ref }}";
		const sidecars = [
			"ci-deps-image",
			"pr-offpath",
			"artifact-trust",
			"dev-cold-loop-gate",
			"data-live",
			"ci-guard",
			"secret-scan",
		];
		for (const id of sidecars) {
			const start = workflow.indexOf(`\n  ${id}:\n`);
			expect(start, id).toBeGreaterThan(-1);
			const rest = workflow.slice(start + 1);
			const end = rest.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/);
			const job = end < 0 ? rest : rest.slice(0, end + 1);
			expect(job, id).toContain(`group: ${group}`);
			expect(job, id).toContain("cancel-in-progress: false");
		}
		const scriptsStart = workflow.indexOf("\n  scripts-tests:\n");
		const scriptsRest = workflow.slice(scriptsStart + 1);
		const scriptsEnd = scriptsRest.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/);
		const scripts =
			scriptsEnd < 0 ? scriptsRest : scriptsRest.slice(0, scriptsEnd + 1);
		expect(scripts).not.toContain("pr-sidecar");
	});
});
