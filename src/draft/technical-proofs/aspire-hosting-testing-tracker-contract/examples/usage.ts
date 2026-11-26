/**
 * Runnable example for aspire-hosting-testing-tracker-contract. The draft-artifact gate
 * EXECUTES this with `node --import tsx` and diffs stdout against usage.expected.txt.
 *
 * Proves HOBO-705: the tracker row for `Aspire.Hosting.Testing` in docs/competitors/
 * aspire.md cannot overclaim — a ✅ or ◐ claim without the Plan 09 whole-graph harness
 * iteration hook in docs/design/generated-stack.md is parsed as "overclaimed" and fails.
 * The acceptance case runs against the REAL committed repo docs.
 */
import { strict as assert } from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	assertAspireHostingTestingTracker,
	evaluateAspireHostingTestingTracker,
	loadRepoAspireHostingTestingTracker,
} from "../src/aspire-hosting-testing-tracker.ts";

const wholeGraphHook = `
### Whole-graph in-process test harness (iteration hook)

Aspire-shaped harness gap documented.
`;

// 1) A ✅ parity claim without a whole-graph harness spec is OVERCLAIMED.
const overclaimedParity = evaluateAspireHostingTestingTracker({
	aspireMarkdown:
		"| `Aspire.Hosting.Testing` | Conformance suites + E2E replay tests | ✅ | [09](../design/generated-stack.md#plan-09) |",
	generatedStackMarkdown: "## Plan 09\n\n### Testing strategy (the pyramid)\n",
});
assert.equal(overclaimedParity.ok, false);
assert.equal(overclaimedParity.status, "overclaimed");
console.log(`parity without harness spec: ok=${overclaimedParity.ok} status=${overclaimedParity.status}`);

// 2) A ◐ deferred claim still requires the Plan 09 iteration hook.
const overclaimedDeferred = evaluateAspireHostingTestingTracker({
	aspireMarkdown:
		"| `Aspire.Hosting.Testing` | Conformance suites + per-port replay | ◐ | [09](../design/generated-stack.md#plan-09) |",
	generatedStackMarkdown: "## Plan 09\n\n### Testing strategy (the pyramid)\n",
});
assert.equal(overclaimedDeferred.status, "overclaimed");
assert.match(overclaimedDeferred.reason, /without the Plan 09 whole-graph harness iteration hook/);
console.log(`deferred without hook: ok=${overclaimedDeferred.ok} status=${overclaimedDeferred.status}`);

// 3) ◐ plus the documented hook parses cleanly as "deferred".
const deferred = assertAspireHostingTestingTracker({
	aspireMarkdown:
		"| `Aspire.Hosting.Testing` | Conformance suites + per-port replay; whole-graph in-process harness not yet specified | ◐ | [09](../design/generated-stack.md#plan-09) |",
	generatedStackMarkdown: `## Plan 09\n${wholeGraphHook}`,
});
assert.equal(deferred.ok, true);
assert.equal(deferred.status, "deferred");
assert.equal(deferred.hasWholeGraphHarnessSpec, true);
console.log(
	`deferred with hook: ok=${deferred.ok} status=${deferred.status} harnessSpec=${deferred.hasWholeGraphHarnessSpec}`,
);

// 4) Acceptance: the REAL committed repo docs satisfy HOBO-705.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const repoResult = loadRepoAspireHostingTestingTracker(repoRoot);
assert.equal(repoResult.ok, true);
assert.equal(repoResult.status, "deferred");
assert.equal(repoResult.hasWholeGraphHarnessSpec, true);
console.log(
	`repo docs: ok=${repoResult.ok} status=${repoResult.status} harnessSpec=${repoResult.hasWholeGraphHarnessSpec}`,
);

console.log("CONTRACT HELD: tracker parity claims are parsed, not trusted");
