import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function vitestFiles(workflowRel: string): string[] {
	const workflow = readFileSync(join(root, workflowRel), "utf8");
	const match = workflow.match(
		/pnpm exec vitest run\s+([\s\S]*?)(?:\n {6}[A-Za-z]|\n      - name:)/,
	);
	const block = match?.[1];
	expect(block, `${workflowRel} vitest list`).toBeTruthy();
	return block!
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.endsWith(".test.ts"));
}

describe("release contract vitest scope", () => {
	it("keeps full @hobo/hobo deploy integration out of release workflows", () => {
		const blocked =
			"scripts/test/stage-release-oci-app.deploy-integration.test.ts";
		for (const workflow of [".github/workflows/release-hobo.yml"]) {
			const files = vitestFiles(workflow);
			expect(files).not.toContain(blocked);
		}
	});
});
