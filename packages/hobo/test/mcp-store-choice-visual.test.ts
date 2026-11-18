import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { renderStoreChoiceHtml } from "../src/mcp-store-choice.js";

const executable = [chromium.executablePath(), "/usr/bin/chromium"].find(
	(path) => existsSync(path),
);

describe.skipIf(executable === undefined)("store selection form", () => {
	it("shows only the selected store's fields without overflowing mobile", async () => {
		const browser = await chromium.launch({
			executablePath: executable,
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
	});

	it("submits the project received from the host with the selected store", async () => {
		const browser = await chromium.launch({
			executablePath: executable,
			headless: true,
			args: ["--no-sandbox"],
		});
		try {
			const page = await browser.newPage();
			await page.setContent(renderStoreChoiceHtml());
			expect(await page.locator('button[type="submit"]').isDisabled()).toBe(
				true,
			);
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
	});
});
