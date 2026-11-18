import { existsSync } from "node:fs";
import { renderSecretCaptureHtml } from "@hobo/mcp";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { renderStoreChoiceHtml } from "../src/mcp-store-choice.js";

const usePlaywrightManagedHeadlessShell =
	process.env.PLAYWRIGHT_BROWSERS_PATH !== undefined;
const executable = [chromium.executablePath(), "/usr/bin/chromium"].find(
	(path) => existsSync(path),
);
const skipVisualTest =
	!usePlaywrightManagedHeadlessShell && executable === undefined;

describe.skipIf(skipVisualTest)("store selection form", () => {
	it("labels owner hand-offs with their human-readable purpose", async () => {
		const browser = await chromium.launch({
			executablePath: usePlaywrightManagedHeadlessShell
				? undefined
				: executable,
			headless: true,
			args: ["--no-sandbox"],
		});
		try {
			const page = await browser.newPage({
				viewport: { width: 390, height: 844 },
			});
			await page.setContent(renderSecretCaptureHtml({ mode: "mcp-app" }));
			await page.evaluate(() => {
				window.postMessage(
					{
						jsonrpc: "2.0",
						method: "ui/notifications/tool-result",
						params: {
							structuredContent: {
								ticketId: "fixture-ticket",
								name: "OP_SERVICE_ACCOUNT_TOKEN",
								target: "handoff",
								label: "existing 1Password token",
								purpose:
									"Use an existing vault-scoped credential for this session.",
								charset: "printable-line",
								maxBytes: 16384,
								key: { kty: "EC", crv: "P-256", x: "fixture", y: "fixture" },
							},
						},
					},
					"*",
				);
			});
			const label = page.locator("#capture-field-label");
			await page.locator("#capture-form").waitFor({ state: "visible" });
			expect(await label.innerText()).toBe("Value of existing 1Password token");
			expect(
				await label
					.locator("#capture-name")
					.evaluate((element) => getComputedStyle(element).fontFamily),
			).toBe(
				await label.evaluate((element) => getComputedStyle(element).fontFamily),
			);
			expect(
				await page.getByLabel("Value of existing 1Password token").isVisible(),
			).toBe(true);
			expect(
				await page
					.locator("#capture-line")
					.evaluate((element) => element === document.activeElement),
			).toBe(true);
			await page.keyboard.press("Tab");
			expect(
				await page
					.locator("#capture-submit")
					.evaluate((element) => element === document.activeElement),
			).toBe(true);
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth),
			).toBeLessThanOrEqual(390);
			await page.evaluate(() => {
				window.postMessage(
					{
						jsonrpc: "2.0",
						method: "ui/notifications/tool-result",
						params: {
							structuredContent: {
								ticketId: "fixture-store-ticket",
								name: "HOBO_SAMPLE_SECRET",
								target: "store",
								label: "sample secret",
								charset: "printable-line",
								maxBytes: 100,
								key: { kty: "EC", crv: "P-256", x: "fixture", y: "fixture" },
							},
						},
					},
					"*",
				);
			});
			await page.waitForFunction(
				() =>
					document.getElementById("capture-name")?.textContent ===
					"HOBO_SAMPLE_SECRET",
			);
			expect(await label.innerText()).toBe("Value of HOBO_SAMPLE_SECRET");
			expect(
				await label
					.locator("#capture-name")
					.evaluate((element) => getComputedStyle(element).fontFamily),
			).toContain("monospace");
		} finally {
			await browser.close();
		}
	}, 60_000);

	it("shows only the selected store's fields without overflowing mobile", async () => {
		const browser = await chromium.launch({
			executablePath: usePlaywrightManagedHeadlessShell
				? undefined
				: executable,
			headless: true,
			args: ["--no-sandbox"],
		});
		try {
			const page = await browser.newPage({
				viewport: { width: 390, height: 844 },
			});
			await page.setContent(renderStoreChoiceHtml());
			for (const store of ["infisical", "1password", "bitwarden"]) {
				await page.locator(`input[value="${store}"]`).check();
				for (const field of await page.locator("[data-for]").all())
					expect(await field.isVisible()).toBe(
						(await field.getAttribute("data-for")) === store,
					);
			}
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth),
			).toBeLessThanOrEqual(390);
		} finally {
			await browser.close();
		}
	}, 60_000);

	it("submits the project received from the host with the selected store", async () => {
		const browser = await chromium.launch({
			executablePath: usePlaywrightManagedHeadlessShell
				? undefined
				: executable,
			headless: true,
			args: ["--no-sandbox"],
		});
		try {
			const page = await browser.newPage();
			await page.setContent(renderStoreChoiceHtml());
			expect(await page.locator('button[type="submit"]').isDisabled()).toBe(
				true,
			);
			expect(
				await page
					.locator('button[type="submit"]')
					.evaluate((button) => getComputedStyle(button).opacity),
			).toBe("0.45");
			await page.evaluate(() => {
				window.addEventListener("message", (event) => {
					if (event.data?.method === "tools/call")
						document.body.dataset.submitted = JSON.stringify(
							event.data.params.arguments,
						);
				});
				window.postMessage(
					{
						jsonrpc: "2.0",
						method: "ui/notifications/tool-input",
						params: {
							arguments: { family: "ci", cwd: "/synthetic/project-b" },
						},
					},
					"*",
				);
				window.postMessage(
					{
						jsonrpc: "2.0",
						method: "ui/notifications/tool-result",
						params: { _meta: { hoboChoiceTicket: "fixture-ticket" } },
					},
					"*",
				);
			});
			await page.locator('input[value="infisical"]').check();
			await page
				.locator('input[name="INFISICAL_PROJECT_ID"]')
				.fill("fixture-project");
			await page.locator('button[type="submit"]').click();
			await page.waitForFunction(() =>
				Boolean(document.body.dataset.submitted),
			);
			const submitted = await page.evaluate(
				() => document.body.dataset.submitted,
			);
			expect(JSON.parse(submitted ?? "null")).toMatchObject({
				family: "ci",
				choiceTicket: "fixture-ticket",
				cwd: "/synthetic/project-b",
				store: "infisical",
				INFISICAL_PROJECT_ID: "fixture-project",
			});
		} finally {
			await browser.close();
		}
	}, 60_000);
});
