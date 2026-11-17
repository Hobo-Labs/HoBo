/**
 * Design lint for the dashboard (DESIGN.md, HoBo Rubberhose, ADR-0149): the
 * page and every view use only palette hexes, sticker shadows sit on
 * pressables only, outlines are thick, and the text colours the views use
 * meet WCAG AA contrast on their grounds by day and by night.
 */
import { describe, expect, it } from "vitest";
import {
	blankQuestion,
	DASHBOARD_FORBIDDEN_HEX,
	DASHBOARD_TOKEN_VALUES,
	DASHBOARD_TOKENS,
	dashboardCss,
	renderDashboardPage,
	renderHistory,
	renderRouter,
	renderRunners,
} from "../src/index.js";
import {
	decided,
	failedRun,
	machine,
	NOW,
	order,
	REPOSITORY,
} from "./support/records.js";

const committed = order(
	JSON.stringify({ steps: [{ key: "machine" }, { key: "github" }] }),
);
const surface = [
	renderDashboardPage({ basePath: "/dashboard" }),
	renderRunners({
		nowMs: NOW,
		machines: [machine({ id: "m-a", lastSeenMs: 1 })],
		routes: [],
	}),
	renderRouter({
		nowMs: NOW,
		order: committed,
		routes: [
			decided({ minutesAgo: 3, step: "github", runner: "ubuntu-24.04" }),
		],
		question: blankQuestion(REPOSITORY, committed.order),
		answer: undefined,
	}),
	renderHistory({ nowMs: NOW, runs: [failedRun()], selected: failedRun() }),
].join("\n");
const css = dashboardCss();

function rule(selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	return (
		new RegExp(`(?:^|\\})${escaped}\\{([^}]*)\\}`, "mu").exec(css)?.[1] ?? ""
	);
}

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
	const channel = (offset: number) => {
		const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(foreground: string, background: string): number {
	const [light, dark] = [luminance(foreground), luminance(background)].sort(
		(left, right) => right - left,
	);
	return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe("dashboard design lint (HoBo Rubberhose)", () => {
	it("uses only DESIGN.md palette hexes", () => {
		const styling = [
			...[...surface.matchAll(/<style>([^<]*)<\/style>/gu)].map(
				(match) => match[1] ?? "",
			),
			...[...surface.matchAll(/style="([^"]*)"/gu)].map(
				(match) => match[1] ?? "",
			),
		].join("\n");
		expect(styling).toContain(DASHBOARD_TOKENS.spark);
		for (const hex of styling.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/gu) ??
			[])
			expect(
				DASHBOARD_TOKEN_VALUES.has(hex.toLowerCase()),
				`non-token hex ${hex}`,
			).toBe(true);
	});

	it("bans the SaaS palette", () => {
		for (const hex of DASHBOARD_FORBIDDEN_HEX)
			expect(surface.toLowerCase()).not.toContain(hex);
	});

	it("uses hard sticker shadows, never soft elevation", () => {
		expect(css).toContain("box-shadow:4px 4px 0 var(--ink)");
		expect(css).not.toContain("rgba(");
		expect(css).not.toMatch(/box-shadow:[^;}]*\d+px\s+\d+px\s+\d+px/u);
	});

	it("uses thick ink outlines, never 1px hairlines", () => {
		expect(css).toContain("border:3px solid var(--ink)");
		expect(css).not.toMatch(/border[^;{}]*:\s*1px/u);
		expect(css).not.toMatch(/\b1px\s+solid\b/u);
	});

	it("keeps inert chrome flat: only pressables are raised", () => {
		for (const selector of [
			".lamp",
			".attention li",
			".diagnosis",
			".answer",
			".badge",
			".table-wrap",
			".trend .bar",
		])
			expect(rule(selector), `${selector} must not be raised`).not.toContain(
				"box-shadow",
			);
		expect(rule("button,.action")).toContain("box-shadow:4px 4px 0");
	});

	it("ships the Rubberhose typography, day/night inversion and reduced motion", () => {
		expect(css).toContain("font-family:Chewy");
		expect(css).toContain("ui-monospace");
		expect(css).toContain("prefers-color-scheme: dark");
		expect(css).toContain(':root[data-theme="dark"]');
		expect(css).toContain("prefers-reduced-motion: reduce");
		expect(css).toContain("fractalNoise");
	});

	it("shows a visible focus ring on everything focusable", () => {
		expect(css).toMatch(
			/button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,main:focus-visible\{outline:3px solid var\(--spark\)/u,
		);
	});

	it("meets WCAG AA contrast for the text colours on their grounds, by day and by night", () => {
		const {
			ink,
			paper,
			cream,
			mute,
			faint,
			spark,
			go,
			inset,
			nightBg,
			nightRaised,
			borderStrong,
		} = DASHBOARD_TOKENS;
		const day: readonly (readonly [string, string, string])[] = [
			["ink on paper", ink, paper],
			["ink on cream", ink, cream],
			["ink on inset", ink, inset],
			["mute on paper", mute, paper],
			["mute on cream", mute, cream],
			["faint on paper", faint, paper],
			["paper on spark (hovered button)", paper, spark],
			["paper on ink (current view)", paper, ink],
		];
		const night: readonly (readonly [string, string, string])[] = [
			["cream on night raised", cream, nightRaised],
			["cream on night ground", cream, nightBg],
			["mute (border-strong) on night raised", borderStrong, nightRaised],
		];
		for (const [name, foreground, background] of [...day, ...night])
			expect(contrast(foreground, background), name).toBeGreaterThanOrEqual(
				4.5,
			);
		// Lamps are not text, but they must stand apart from their ground (WCAG 1.4.11, 3:1).
		for (const lamp of [go, spark])
			expect(contrast(lamp, paper)).toBeGreaterThanOrEqual(3);
	});
});
