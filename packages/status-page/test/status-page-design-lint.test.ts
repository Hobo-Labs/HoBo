import { describe, expect, it } from "vitest";
import visualTokenContract from "../../../scripts/visual-token-contract.json" with {
	type: "json",
};

import {
	createStatusPageProjection,
	parseStatusScope,
	renderStatusPageHtml,
	STATUS_PAGE_FORBIDDEN_HEX,
	STATUS_PAGE_TOKENS,
	STATUS_SIGNAL_EVENTS,
	statusEnvelope,
	toStatusPageModel,
} from "../src/index.js";

function renderedSurface(): string {
	const projection = createStatusPageProjection();
	const row = projection.fold([
		statusEnvelope(
			STATUS_SIGNAL_EVENTS.SloMeasured,
			{
				componentId: "kit-web",
				sloName: "availability",
				attainment: 0.9995,
				target: 0.999,
				measuredAt: "2026-08-17T00:00:00.000Z",
			},
			{
				streamId: "status:test",
				seq: 1,
				ts: "2026-08-17T00:00:00.000Z",
				project: "shop",
			},
		),
		statusEnvelope(
			STATUS_SIGNAL_EVENTS.IncidentOpened,
			{
				incidentId: "INC-1",
				title: "Checkout latency",
				impact: "major",
				affectedComponents: ["kit-web"],
				currentStatus: "investigating",
			},
			{
				streamId: "status:test",
				seq: 2,
				ts: "2026-08-17T00:01:00.000Z",
				project: "shop",
			},
		),
	]).rows["project:shop"];
	return renderStatusPageHtml(
		toStatusPageModel(row, {
			scope: parseStatusScope({
				kind: "project",
				id: "shop",
				label: "Project shop",
			}),
			evaluatedAt: "2026-08-17T00:05:00.000Z",
		}),
	);
}

const html = renderedSurface();
const unknownHtml = renderStatusPageHtml(
	toStatusPageModel(undefined, {
		scope: parseStatusScope({
			kind: "project",
			id: "shop",
			label: "Project shop",
		}),
		evaluatedAt: "2026-08-17T00:05:00.000Z",
	}),
);

function cssRule(document: string, selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const rule = new RegExp(`${escaped}[^{}]*\\{([^}]*)\\}`, "u").exec(document);
	expect(rule, `missing rule for ${selector}`).not.toBeNull();
	return rule?.[1] ?? "";
}

describe("status-page design lint (HoBo Rubberhose)", () => {
	it("uses exactly the palette approved by the independent token contract", () => {
		expect(STATUS_PAGE_TOKENS).toEqual(
			visualTokenContract["status-page"].tokens,
		);
		const approved = new Set(
			Object.values(visualTokenContract["status-page"].tokens),
		);
		const rendered = new Set(
			(html.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? []).map((hex) =>
				hex.toLowerCase(),
			),
		);
		expect(rendered.size).toBeGreaterThan(0);
		for (const hex of rendered)
			expect(approved.has(hex), `non-contract hex ${hex}`).toBe(true);
	});

	it("pins rendered accent text pairs with an accessible night palette", () => {
		expect(visualTokenContract["status-page"].contrast).toEqual(
			expect.arrayContaining([
				{ foreground: "go", background: "inset" },
				{ foreground: "go", background: "paper" },
				{ foreground: "spark", background: "inset" },
				{ foreground: "spark", background: "paper" },
				{ foreground: "spark", background: "cream" },
				{ foreground: "paper", background: "spark" },
				{ foreground: "nightGo", background: "nightRaised" },
				{ foreground: "nightSpark", background: "nightRaised" },
				{ foreground: "nightSpark", background: "nightBg" },
				{ foreground: "nightRaised", background: "nightSpark" },
			]),
		);
		for (const theme of [
			':root[data-theme="dark"]',
			'@media (prefers-color-scheme: dark){:root:not([data-theme="light"])',
		]) {
			const start = html.indexOf(theme);
			expect(start).toBeGreaterThanOrEqual(0);
			const declarations = html.slice(start, html.indexOf("}", start));
			expect(declarations).toContain(
				`--spark:${STATUS_PAGE_TOKENS.nightSpark}`,
			);
			expect(declarations).toContain(`--go:${STATUS_PAGE_TOKENS.nightGo}`);
		}
	});

	it("bans the forbidden SaaS/Catppuccin palette", () => {
		for (const hex of STATUS_PAGE_FORBIDDEN_HEX) {
			expect(html.toLowerCase()).not.toContain(hex.toLowerCase());
		}
	});

	it("uses hard sticker shadows, never soft rgba elevation", () => {
		expect(html).toContain("box-shadow:4px 4px 0");
		expect(html).not.toContain("rgba(");
		expect(html).not.toMatch(/box-shadow:[^;}]*\d+px\s+\d+px\s+\d+px/);
	});

	it("uses thick ink outlines, never 1px hairlines", () => {
		expect(html).toContain("border:3px solid");
		expect(html).not.toMatch(/border[^;{}]*:\s*1px/);
		expect(html).not.toMatch(/\b1px\s+solid\b/);
	});

	it("keeps inert status chrome flat (pressable = raised law)", () => {
		for (const selector of [".banner .lamp", ".component", ".uptime i"]) {
			const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const rule = html.match(new RegExp(`${escaped}\\{([^}]*)\\}`));
			expect(rule, `missing rule for ${selector}`).not.toBeNull();
			expect(rule?.[1] ?? "").not.toContain("box-shadow");
		}
	});

	it("ships the Rubberhose typography stack", () => {
		expect(html).toContain("font-family:Chewy");
		expect(html).toContain("system-ui");
		expect(html).toContain("ui-monospace");
	});

	it("ships day/night inversion", () => {
		expect(html).toContain("color-scheme:light");
		expect(html).toContain("prefers-color-scheme: dark");
		expect(html).toContain('data-theme="dark"');
		expect(html).toContain("theme-toggle");
		expect(html).toContain("hobo-theme");
	});

	it("keeps the film grain and ink-on-paper ground", () => {
		expect(html).toContain("fractalNoise");
		expect(html).toContain("--cream:");
		expect(html).toContain("--ink:");
	});

	it("renders delayed and unknown status in faint gray, never green", () => {
		for (const selector of [
			'.banner[data-indicator="unknown"] .lamp',
			'.component[data-state="unknown"]',
		]) {
			const declarations = cssRule(unknownHtml, selector);
			expect(declarations).toContain("var(--faint)");
			expect(declarations).not.toContain("var(--go)");
		}
		expect(unknownHtml).toContain('data-indicator="unknown"');
		expect(unknownHtml).toContain("Status delayed / unknown");
	});

	it("maps uptime cells to go, spark, and border-strong status tokens", () => {
		expect(cssRule(html, ".uptime i")).toContain("background:var(--go)");
		expect(cssRule(html, '.uptime i[data-day="degraded"]')).toContain(
			"background:var(--spark)",
		);
		expect(cssRule(html, '.uptime i[data-day="unknown"]')).toContain(
			"background:var(--border-strong)",
		);
	});

	it("disables motion and film grain under prefers-reduced-motion", () => {
		const start = html.indexOf("@media (prefers-reduced-motion: reduce)");
		const end = html.indexOf("html{color-scheme:light dark}", start);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		const reduced = html.slice(start, end);
		expect(reduced).toContain("animation-duration:.01ms");
		expect(reduced).toContain("animation-delay:0s");
		expect(reduced).toContain("transition-duration:.01ms");
		expect(reduced).toContain("transition-delay:0s");
		expect(reduced).toContain("h1{transform:none}");
		expect(reduced).toContain("button:active,.action:active{transform:none}");
		expect(reduced).toContain("body::after{opacity:0}");
	});

	it("uses 3px spark focus rings with 3px offsets", () => {
		const declarations = cssRule(html, "button:focus-visible");
		expect(declarations).toContain("outline:3px solid var(--spark)");
		expect(declarations).toContain("outline-offset:3px");
	});

	it("labels sections by headings and announces the banner as status", () => {
		for (const match of html.matchAll(/<section\b[^>]*>/gu))
			expect(match[0]).toContain("aria-labelledby=");
		expect(html).toContain('id="components-heading"');
		expect(html).toContain('id="incidents-heading"');
		expect(html).toContain('role="status"');
	});
});
