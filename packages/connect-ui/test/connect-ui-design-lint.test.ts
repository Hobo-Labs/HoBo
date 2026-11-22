import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import visualTokenContract from "../../../scripts/visual-token-contract.json" with {
	type: "json",
};
import { escapeHtml, renderConnectPageShell } from "../src/server.js";

const styles = readFileSync(
	new URL("../src/client/styles.css", import.meta.url),
	"utf8",
);
const client = readFileSync(
	new URL("../src/client/main.tsx", import.meta.url),
	"utf8",
);

describe("connect-ui design requirements", () => {
	it("renders delayed or unknown status in faint gray, never green", () => {
		expect(client).toContain(
			'if (envelope === null) return <p className="hobo-loading">Loading…</p>;',
		);
		const rule = /\.hobo-loading\s*\{([^}]*)\}/u.exec(styles);
		expect(rule?.[1]).toContain("color: var(--faint)");
		expect(rule?.[1]).not.toContain("var(--go)");
	});

	it("pins rendered error text contrast in the independent token contract", () => {
		expect(visualTokenContract["connect-ui"].contrast).toEqual(
			expect.arrayContaining([
				{ foreground: "--spark", background: "--paper" },
			]),
		);
		expect(styles).toContain(".hobo-error {\n\tcolor: var(--spark);\n}");
		const dark =
			/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/u.exec(
				styles,
			);
		expect(dark?.[1]).toContain("--spark: #ff7a63");
	});

	it("escapes every interpolated shell value", () => {
		const base = `/s/"><script>alert('xss')</script>&/`;
		const escaped = escapeHtml(base);
		const html = renderConnectPageShell(base);
		expect(html).not.toContain("<script>alert('xss')</script>");
		expect(html).toContain(`href="${escaped}connect.css"`);
		expect(html).toContain(`data-base="${escaped}"`);
		expect(html).toContain(`src="${escaped}connect.js"`);
	});

	it("escapeHtml covers the five metacharacters", () => {
		expect(escapeHtml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&#39;");
	});
});
