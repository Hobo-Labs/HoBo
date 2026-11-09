import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const source = readFileSync(
	join(root, "scripts/ci/build-release-oci-image.mts"),
	"utf8",
);

describe("build-release-oci-image cleanup", () => {
	it("does not builder-prune while keepCandidate is set (live contract inspects :candidate)", () => {
		expect(source).toMatch(
			/if\s*\(\s*!options\.keepCandidate[\s\S]*?\)\s*\{[\s\S]*?builder", "prune"/,
		);
		expect(source).not.toMatch(
			/keepCandidate[\s\S]{0,400}builder", "prune"[\s\S]{0,80}\}\s*\}\s*export function buildReleaseImage/s,
		);
	});

	it("runs a single builder prune at end of hobo-mcp cleanup chain when not keeping", () => {
		const chainStart = source.indexOf("function cleanupReleaseOciBuildChain");
		const chainEnd = source.indexOf("export type BuiltReleaseImage");
		expect(chainStart).toBeGreaterThan(-1);
		expect(chainEnd).toBeGreaterThan(chainStart);
		const chain = source.slice(chainStart, chainEnd);
		expect(chain).toMatch(/deferBuilderPrune/);
		expect((chain.match(/builder", "prune"/g) ?? []).length).toBe(1);
	});
});
