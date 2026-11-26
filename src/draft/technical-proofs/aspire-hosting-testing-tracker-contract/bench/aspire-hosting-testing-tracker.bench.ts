import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bench, describe } from "vitest";

import { evaluateAspireHostingTestingTracker } from "../src/aspire-hosting-testing-tracker.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const aspireMarkdown = readFileSync(path.join(repoRoot, "docs/competitors/aspire.md"), "utf8");
const generatedStackMarkdown = readFileSync(
	path.join(repoRoot, "docs/design/generated-stack.md"),
	"utf8",
);

// Numbers are advisory; the gate only requires that declared benches EXECUTE.
describe("aspire tracker evaluation hot path", () => {
	bench("evaluateAspireHostingTestingTracker over the real repo docs", () => {
		evaluateAspireHostingTestingTracker({ aspireMarkdown, generatedStackMarkdown });
	});

	bench("evaluate over a synthetic overclaim fixture", () => {
		evaluateAspireHostingTestingTracker({
			aspireMarkdown:
				"| `Aspire.Hosting.Testing` | Conformance suites + E2E replay tests | ✅ | [09](../design/generated-stack.md#plan-09) |",
			generatedStackMarkdown: "## Plan 09\n",
		});
	});
});
