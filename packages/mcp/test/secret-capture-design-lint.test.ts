import { describe, expect, it } from "vitest";
import visualTokenContract from "../../../scripts/visual-token-contract.json" with {
	type: "json",
};
import { renderSecretCaptureHtml } from "../src/index.js";

const APP = renderSecretCaptureHtml({ mode: "mcp-app" });
const PAGE = renderSecretCaptureHtml({
	mode: "loopback",
	nonce: "fixture-nonce",
	ticket: {
		ticketId: "cap_AAAAAAAAAAAAAAAAAAAAAA",
		name: "VERCEL_TOKEN",
		label:
			"Vercel deploy token </script><script>alert(1)</script>&>\u2028\u2029",
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

describe("secret-capture form design lint (HoBo Rubberhose)", () => {
	it("uses exactly the palette approved by the independent token contract", () => {
		const approved = new Set(
			Object.values(visualTokenContract.mcp.tokens).map((hex) =>
				hex.toLowerCase(),
			),
		);
		for (const html of [APP, PAGE]) {
			const rendered = new Set(
				(html.match(/#[0-9a-fA-F]{6}\b/gu) ?? []).map((hex) =>
					hex.toLowerCase(),
				),
			);
			expect(rendered).toEqual(approved);
		}
	});

	it("loads nothing from the network: no external script, style, font or image", () => {
		for (const html of [APP, PAGE]) {
			expect(html).not.toMatch(/\bsrc=|<link\b|@import|url\(|https?:\/\//u);
		}
	});

	it("renders dynamic content through textContent without HTML parsing sinks", () => {
		for (const html of [APP, PAGE]) {
			expect(html).not.toMatch(
				/\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/u,
			);
			for (const assignment of [
				"function say(text) { error.textContent = text;",
				'el("capture-label").textContent = next.label || next.name;',
				'el("capture-purpose").textContent = next.purpose || "";',
				'el("capture-name").textContent = next.name;',
				"done.textContent = handoff",
			])
				expect(html).toContain(assignment);
			expect(html).not.toContain("answer.ref");
			expect(html).not.toContain("handoff://");
			expect(html).toContain("Handed to the waiting run. You can close this.");
			expect(html).toContain(
				"Writes authorized for this session. You can close this.",
			);
			expect(html).toContain("Stored in the secret store. You can close this.");
		}
	});

	it("clears both fields immediately after reading the submitted value", () => {
		for (const html of [APP, PAGE]) {
			expect(html).toContain(
				'function clearFields() { line.value = ""; multi.value = ""; }',
			);
			expect(html).toMatch(/var value = field\(\)\.value;\s*clearFields\(\);/u);
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
		const config =
			/<script type="application\/json" id="hobo-capture-config">(.*?)<\/script>/su.exec(
				PAGE,
			)?.[1];
		expect(PAGE).not.toContain("</script><script>alert(1)");
		expect(PAGE).toContain("\\u003c/script\\u003e");
		expect(config).toContain(
			"Vercel deploy token \\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e\\u0026\\u003e\\u2028\\u2029",
		);
		expect(PAGE).toContain('<script nonce="fixture-nonce">');
		expect(PAGE).toContain('<style nonce="fixture-nonce">');
	});
});
