/**
 * Encapsulation gate: published Trails .d.ts must never import foreign packages.
 * Consumers only see Trails-owned types/DTOs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(packageRoot, "dist");

describe("Trails public surface is sealed", () => {
	it("does not expose a receiver before its native Camp lock exists", async () => {
		const api = await import("../dist/index.js");
		expect("createDurableHandoverRouter" in api).toBe(false);
	}, 30_000);
	it("dist declarations import no @hobo/* or other external packages", () => {
		const files = readdirSync(distDir).filter((f) => f.endsWith(".d.ts"));
		expect(files.length).toBeGreaterThan(0);
		const leaks: string[] = [];
		for (const file of files) {
			const content = readFileSync(join(distDir, file), "utf8");
			// Absolute package imports in declarations = public surface leak.
			const matches = content.match(
				/from\s+["'](@hobo\/[^"']+|[^./][^"']*)["']/g,
			);
			if (matches) {
				for (const m of matches) {
					leaks.push(`${file}: ${m}`);
				}
			}
			// Also catch import type { X } from "@hobo/..."
			if (/import\s+.*from\s+["']@hobo\//.test(content)) {
				leaks.push(`${file}: contains @hobo/ import`);
			}
		}
		expect(leaks, leaks.join("\n")).toEqual([]);
	});

	it("package entry re-exports do not name identity types in index.d.ts", () => {
		const index = readFileSync(join(distDir, "index.d.ts"), "utf8");
		expect(index).not.toMatch(/IdentityMigrationControlPlane/);
		expect(index).not.toMatch(/FeatureFlagStore/);
		expect(index).not.toMatch(/ControlPlaneProgress/);
		expect(index).not.toMatch(/CanMigrateResult/);
		expect(index).not.toMatch(/DualIdentityFixtures/);
		expect(index).not.toMatch(/@hobo\/identity/);
		expect(index).not.toMatch(/@hobo\/core/);
	});
});
