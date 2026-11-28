import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { EXISTING_INTENTS } from "./fixtures/existing-intents.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function squash(value: string): string {
	return value.replace(/\s+/gu, "");
}

const sourceCache = new Map<string, string>();

function sourceOf(relativePath: string): string {
	const cached = sourceCache.get(relativePath);
	if (cached !== undefined) return cached;
	const contents = squash(readFileSync(`${REPO_ROOT}${relativePath}`, "utf8"));
	sourceCache.set(relativePath, contents);
	return contents;
}

describe("fixture provenance", () => {
	it("cites at least one intent from each of the four upstream sources", () => {
		expect(new Set(EXISTING_INTENTS.map((entry) => entry.source))).toEqual(
			new Set([
				"packages/cloud/test/placement.test.ts",
				"packages/cloud/test/registry.test.ts",
				"packages/cloud/contracts/consumer/control-plane-boundaries.test.ts",
				"packages/cloud/src/intent.ts",
			]),
		);
	});

	it("gives every fixture a unique id", () => {
		const ids = EXISTING_INTENTS.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	for (const entry of EXISTING_INTENTS) {
		it(`${entry.id} is still present in ${entry.source}`, () => {
			expect(sourceOf(entry.source)).toContain(squash(entry.anchor));
		});
	}

	it("the hello-bindle intents match the manifest fixture they are lowered from", () => {
		// SAFETY: this is the repository-owned hello-bindle manifest fixture.
		const manifest = JSON.parse(
			readFileSync(
				`${REPO_ROOT}packages/cloud/test/fixtures/hello-bindle.manifest.json`,
				"utf8",
			),
			// SAFETY: this fixture is the repository-owned manifest shape under test.
		) as { resources: Record<string, { bind?: string[] }> };

		const helloBindle = EXISTING_INTENTS.filter((entry) =>
			entry.id.startsWith("hello-bindle/"),
		);
		expect(helloBindle.map((entry) => entry.value.name).sort()).toEqual(
			Object.keys(manifest.resources).sort(),
		);

		for (const entry of helloBindle) {
			const resource = manifest.resources[entry.value.name];
			expect(resource).toBeTypeOf("object");
			expect(entry.value.deps).toEqual([...(resource?.bind ?? [])].sort());
		}
	});
});
