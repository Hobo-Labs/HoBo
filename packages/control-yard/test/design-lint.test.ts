import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkRepositoryVisualTokens } from "../../../scripts/check-visual-tokens.mts";
import { loadAssetIndex } from "../src/index.js";

const css = readFileSync(
	new URL("../public/yard.css", import.meta.url),
	"utf8",
);

function declarationsFor(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const rule = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css);
	expect(rule, `missing rule for ${selector}`).not.toBeNull();
	return rule?.[1] ?? "";
}

describe("control-yard design requirements", () => {
	it("passes the independent repository palette and contrast contract", () => {
		expect(checkRepositoryVisualTokens()).toEqual([]);
	});

	it("keeps the Rubberhose type, thick outlines, and zero-blur sticker shadows", () => {
		expect(css).toContain('font-family: "Chewy"');
		expect(css).toContain("--font-sans:");
		expect(css).toContain("system-ui");
		expect(css).toContain("--font-mono:");
		expect(css).toContain("ui-monospace");
		expect(css).toContain("border: 3px solid var(--ink)");
		expect(css).toContain("--sticker: 4px 4px 0 var(--ink)");
		expect(css).not.toMatch(/box-shadow\s*:[^;]*\d+px\s+\d+px\s+\d+px/su);
	});

	it("uses 2.5px spark focus rings with 2px offsets", () => {
		const declarations = declarationsFor("button:focus-visible");
		expect(declarations).toContain("outline: 2.5px solid var(--spark)");
		expect(declarations).toContain("outline-offset: 2px");
	});

	it("reduces CSS motion and removes film grain when requested", () => {
		const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
		expect(start).toBeGreaterThanOrEqual(0);
		const reduced = css.slice(start);
		expect(reduced).toContain("animation-duration: 0.01ms");
		expect(reduced).toContain("animation-delay: 0s");
		expect(reduced).toContain("transition-duration: 0.01ms");
		expect(reduced).toContain("transition-delay: 0s");
		expect(reduced).toContain("transform: none");
		expect(reduced).toContain("body::after");
		expect(reduced).toContain("opacity: 0");
	});

	it("limits scenery to the supplied reviewed site plates", () => {
		expect(Object.keys(loadAssetIndex().backgrounds ?? {}).sort()).toEqual([
			"poles",
			"sky-cloud",
			"trail",
			"trail-front",
		]);
	});
});
