import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

const workflow = readFileSync(
	join(import.meta.dirname, "../../.github/workflows/release-hobo.yml"),
	"utf8",
);

test("a required SDK publication that did not succeed makes the workflow fail", () => {
	const guard =
		workflow
			.split("  release-npm-required:")[1]
			?.split("  release-pages-gate:")[0] ?? "";
	assert.match(guard, /needs\.release-main-train-gate\.outputs\.run == 'true'/);
	assert.match(guard, /startsWith\(github\.ref, 'refs\/tags\/sdk-v'\)/);
	assert.match(
		guard,
		/github\.event_name == 'workflow_dispatch' && inputs\.push_images/,
	);
	assert.match(guard, /needs\.release-npm\.result != 'success'/);
	assert.doesNotMatch(guard, /vars\.HOBO_NPM_PUBLISH/);
	const script = guard.split("        run: |\n")[1];
	assert.ok(script);
	const result = spawnSync("bash", ["-c", script], {
		env: { PATH: "/usr/bin:/bin" },
	});
	assert.equal(result.status, 1);
});

test("release tags require npm success except an independent CLI tag", () => {
	const main =
		workflow.split("  release-tag:")[1]?.split("  release-github:")[0] ?? "";
	const independent =
		workflow
			.split("  release-github:")[1]
			?.split("  release-integration-measure-gate:")[0] ?? "";
	assert.match(main, /needs\.release-npm\.result == 'success'/);
	assert.doesNotMatch(main, /vars\.HOBO_NPM_PUBLISH != 'true'/);
	assert.match(
		independent,
		/startsWith\(github\.ref, 'refs\/tags\/cli-v'\) \|\| needs\.release-npm\.result == 'success'/,
	);
	assert.doesNotMatch(independent, /vars\.HOBO_NPM_PUBLISH != 'true'/);
});
