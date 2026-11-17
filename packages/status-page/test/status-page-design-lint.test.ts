/**
 * Design-lint gate for the rendered status-page surface (DESIGN.md).
 * Token-only hexes, no SaaS palette, no soft elevation, sticker shadows on
 * pressables only.
 */
import { describe, expect, it } from "vitest";

import {
	createStatusPageProjection,
	parseStatusScope,
	renderStatusPageHtml,
	STATUS_PAGE_FORBIDDEN_HEX,
	STATUS_PAGE_TOKEN_VALUES,
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

describe("status-page design lint (HoBo Rubberhose)", () => {
	it("uses only DESIGN.md palette hexes", () => {
		const hexes = html.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
		for (const hex of hexes) {
			expect(
				STATUS_PAGE_TOKEN_VALUES.has(hex.toLowerCase()),
				`non-token hex ${hex}`,
			).toBe(true);
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
		// 1px hairline borders are banned; the 1px pressed-state shadow is canon.
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

	it("ships day/night inversion and reduced-motion parity", () => {
		expect(html).toContain("color-scheme:light");
		expect(html).toContain("prefers-color-scheme: dark");
		expect(html).toContain('data-theme="dark"');
		expect(html).toContain("theme-toggle");
		expect(html).toContain("hobo-theme");
		expect(html).toContain("prefers-reduced-motion: reduce");
	});

	it("keeps the film grain and ink-on-paper ground", () => {
		expect(html).toContain("fractalNoise");
		expect(html).toContain("--cream:");
		expect(html).toContain("--ink:");
	});
});
