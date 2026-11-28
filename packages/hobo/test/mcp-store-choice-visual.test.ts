import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import {
	createStoreChoiceApp,
	renderStoreChoiceHtml,
} from "../src/mcp-store-choice.js";
import { OwnerWriteGuardUnavailableError } from "../src/owner-write-guard.js";

const usePlaywrightManagedHeadlessShell =
	process.env.PLAYWRIGHT_BROWSERS_PATH !== undefined;
const executable = [chromium.executablePath(), "/usr/bin/chromium"].find(
	(path) => existsSync(path),
);
const skipVisualTest =
	!usePlaywrightManagedHeadlessShell && executable === undefined;

describe.skipIf(skipVisualTest)("store selection form", () => {
	it("shows the unavailable-store message at desktop and narrow widths", async () => {
		const app = createStoreChoiceApp({
			locatorFor: () => ({
				read: async () => ({}),
				write: async () => undefined,
				onOwnerChoice: () => {
					throw new OwnerWriteGuardUnavailableError();
				},
			}),
		});
		let step = 0;
		const result = await app.callTool(
			"choose_secret_store",
			{ family: "cd", cwd: "/synthetic/project" },
			{ formElicitation: true, apps: false },
			async () => ({
				action: "accept",
				content: step++ === 0 ? { store: "bitwarden" } : {},
			}),
		);
		const content = result.content.find((item) => item.type === "text");
		if (content?.type !== "text") throw new Error("No status message.");
		const browser = await chromium.launch({
			executablePath: usePlaywrightManagedHeadlessShell
				? undefined
				: executable,
			headless: true,
			args: ["--no-sandbox"],
		});
		try {
			for (const viewport of [
				{ width: 1440, height: 900 },
				{ width: 390, height: 844 },
			]) {
				const page = await browser.newPage({ viewport });
				await page.setContent(renderStoreChoiceHtml());
				await page.evaluate((message) => {
					window.addEventListener("message", (event) => {
						const input = event.data;
						if (input?.method === "tools/call")
							window.postMessage(
								{
									jsonrpc: "2.0",
									id: input.id,
									result: {
										isError: true,
										content: [{ type: "text", text: message }],
									},
								},
								"*",
							);
					});
					window.postMessage(
						{
							jsonrpc: "2.0",
							method: "ui/notifications/tool-input",
							params: {
								arguments: { family: "cd", cwd: "/synthetic/project" },
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
				}, content.text);
				await page.locator('input[value="bitwarden"]').check();
				await page.locator('button[type="submit"]').click();
				await page.waitForFunction(
					(message) => document.querySelector("#say")?.textContent === message,
					content.text,
				);
				expect(await page.locator("#say").innerText()).toBe(content.text);
				expect(
					await page.evaluate(() => document.documentElement.scrollWidth),
				).toBeLessThanOrEqual(viewport.width);
				await page.close();
			}
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
