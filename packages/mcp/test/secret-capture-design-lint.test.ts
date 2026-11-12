/**
 * Design-lint gate for the secret-capture form (packages/mcp/DESIGN.md, HoBo
 * Rubberhose tokens from site/DESIGN.md). Token-only hexes, nothing loaded
 * from the network, a label and a description on every field, one sticker
 * shadow on the one pressable, motion that survives reduced motion.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	renderSecretCaptureHtml,
	SECRET_CAPTURE_TOKEN_VALUES,
} from "../src/index.js";

const APP = renderSecretCaptureHtml({ mode: "mcp-app" });
const PAGE = renderSecretCaptureHtml({
	mode: "loopback",
	nonce: "fixture-nonce",
	ticket: {
		ticketId: "cap_AAAAAAAAAAAAAAAAAAAAAA",
		name: "VERCEL_TOKEN",
		label: "Vercel deploy token </script><script>alert(1)</script>",
		purpose: "The deploy workflow deploys the relay with it.",
		charset: "printable-line",
		maxBytes: 4096,
		expiresAt: "2026-11-12T10:10:00.000Z",
		key: {
			kty: "EC",
			crv: "P-256",
			x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
			y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
		},
	},
});

const designMd = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "..", "DESIGN.md"),
	"utf8",
);

describe("secret-capture form design lint (HoBo Rubberhose)", () => {
	it("uses only DESIGN.md palette hexes, and DESIGN.md declares each", () => {
		for (const html of [APP, PAGE])
			for (const hex of html.match(/#[0-9a-fA-F]{6}\b/gu) ?? [])
				expect(
					SECRET_CAPTURE_TOKEN_VALUES.has(hex.toLowerCase()),
					`non-token hex ${hex}`,
				).toBe(true);
		for (const hex of SECRET_CAPTURE_TOKEN_VALUES)
			expect(designMd.toLowerCase()).toContain(`"${hex}"`);
	});

	it("loads nothing from the network: no external script, style, font or image", () => {
		for (const html of [APP, PAGE]) {
			expect(html).not.toMatch(/\bsrc=|<link\b|@import|url\(|https?:\/\//u);
		}
	});

	it("gives every field a label and a description, and reports errors as alerts", () => {
		for (const html of [APP, PAGE]) {
			expect(html).toContain(
				'<label id="capture-field-label" for="capture-line">',
			);
			for (const id of ["capture-line", "capture-multi"])
				expect(html).toMatch(
					new RegExp(
						`id="${id}"[^>]*aria-describedby="capture-help capture-error"`,
						"u",
					),
				);
			expect(html).toContain('role="alert"');
			expect(html).toContain('role="status" aria-live="polite"');
			expect(html).toMatch(
				/:focus-visible[^}]*outline: 3px solid var\(--spark\)/su,
			);
			expect(html).toContain('<html lang="en">');
		}
	});

	it("keeps password managers, spellcheck and autofill away from the value", () => {
		for (const html of [APP, PAGE])
			for (const id of ["capture-line", "capture-multi"])
				expect(html).toMatch(
					new RegExp(
						`id="${id}"[^>]*autocomplete="off"[^>]*spellcheck="false"`,
						"u",
					),
				);
		expect(APP).toContain('type="password"');
	});

	it("puts the sticker shadow on the button only, and drops motion when asked", () => {
		const shadows = APP.match(/box-shadow:[^;]+;/gu) ?? [];
		expect(shadows.length).toBe(2);
		expect(APP).toMatch(/button \{[^}]*box-shadow: 4px 4px 0/su);
		expect(APP).toMatch(
			/prefers-reduced-motion: reduce\)[^}]*transition: none/su,
		);
		expect(APP).not.toMatch(/blur\(|backdrop-filter|linear-gradient/u);
	});

	it("inverts to paper-on-ink at night with the declared night tokens", () => {
		expect(APP).toMatch(
			/:root\[data-theme="dark"\] \{[^}]*--paper: #0a0a0a;[^}]*--ink: #f2f1ec;/su,
		);
	});

	it("embeds the loopback page's ticket so it cannot close its script element", () => {
		expect(PAGE).not.toContain("</script><script>alert(1)");
		expect(PAGE).toContain("\\u003c/script\\u003e");
		expect(PAGE).toContain('<script nonce="fixture-nonce">');
		expect(PAGE).toContain('<style nonce="fixture-nonce">');
	});
});
