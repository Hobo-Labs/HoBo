import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
	OwnerSelectionChangedError,
	StoreOperationUncertainError,
} from "@hobo/hobo-ci";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { composeHoboMcp } from "../src/mcp-serve.js";
import {
	CHOOSE_SECRET_STORE_TOOL,
	SUBMIT_STORE_CHOICE_TOOL,
} from "../src/mcp-store-choice.js";

describe("MCP serve store picker locator", () => {
	it("marks an adopted saved choice on the session locator", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-mcp-serve-choice-"));
		try {
			const mcp = composeHoboMcp({
				output: new PassThrough(),
				projectDir: dir,
				remote: true,
			});
			const locator = mcp.owner.storeSettingsFor!("cd", dir);
			await locator.write({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "synthetic-project",
			});
			expect(locator.hasSessionChoice?.()).toBe(false);

			const app = mcp.session.storeChoice;
			if (app === undefined) throw new Error("Store choice app is missing.");
			const outcome = await app.callTool(
				CHOOSE_SECRET_STORE_TOOL,
				{ cwd: dir, family: "cd" },
				{ apps: false, formElicitation: false, urlElicitation: false },
				undefined,
			);
			expect(outcome.structuredContent?.store).toBe("Infisical");
			expect(locator.hasSessionChoice?.()).toBe(true);
			await mcp.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records a new picker answer on the session locator", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-mcp-serve-choice-"));
		try {
			const mcp = composeHoboMcp({
				output: new PassThrough(),
				projectDir: dir,
				remote: true,
			});
			const app = mcp.session.storeChoice;
			if (app === undefined) throw new Error("Store choice app is missing.");
			const shown = await app.callTool(
				CHOOSE_SECRET_STORE_TOOL,
				{ cwd: dir, family: "cd", reselect: true },
				{ apps: true, formElicitation: false, urlElicitation: false },
				undefined,
			);
			const ticket = z
				.object({ hoboChoiceTicket: z.string() })
				.safeParse(shown._meta).data?.hoboChoiceTicket;
			expect(ticket).toBeDefined();
			const recorded = await app.callTool(
				SUBMIT_STORE_CHOICE_TOOL,
				{
					cwd: dir,
					family: "cd",
					choiceTicket: ticket,
					store: "infisical",
					INFISICAL_PROJECT_ID: "synthetic-recorded-project",
				},
				{ apps: true, formElicitation: false, urlElicitation: false },
				undefined,
			);
			expect(recorded.structuredContent?.status).toBe("sign-in-needed");
			const locator = mcp.owner.storeSettingsFor!("cd", dir);
			expect(await locator.read()).toEqual({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "synthetic-recorded-project",
			});
			expect(locator.hasSessionChoice?.()).toBe(true);
			await mcp.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("MCP serve owner session currency", () => {
	function locatorFor(mcp: ReturnType<typeof composeHoboMcp>, dir: string) {
		const locator = mcp.owner.storeSettingsFor?.("cd", dir);
		if (locator === undefined)
			throw new Error("The session locator is missing.");
		return locator;
	}

	it("keeps an uncertain store write latched across a later owner choice, and reports it as itself", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-mcp-serve-uncertain-"));
		try {
			const mcp = composeHoboMcp({
				output: new PassThrough(),
				projectDir: dir,
				remote: true,
			});
			const locator = locatorFor(mcp, dir);
			expect(() => locator.assertCurrent?.()).not.toThrow();
			locator.markUncertainWrite?.();
			expect(() => locator.assertCurrent?.()).toThrow(
				StoreOperationUncertainError,
			);
			expect(() => locator.onOwnerChoice?.()).toThrow(
				StoreOperationUncertainError,
			);
			expect(() => locator.assertCurrent?.()).toThrow(
				StoreOperationUncertainError,
			);
			await expect(locator.read()).rejects.toThrow(
				StoreOperationUncertainError,
			);
			await mcp.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports a changed owner selection as itself, not as an uncertain write", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-mcp-serve-reselected-"));
		try {
			const mcp = composeHoboMcp({
				output: new PassThrough(),
				projectDir: dir,
				remote: true,
			});
			const before = locatorFor(mcp, dir);
			await before.write({ HOBO_SECRET_STORE: "infisical" });
			expect(() => before.onOwnerChoice?.()).not.toThrow();
			expect(() => before.assertCurrent?.()).toThrow(
				OwnerSelectionChangedError,
			);
			expect(() => locatorFor(mcp, dir).assertCurrent?.()).not.toThrow();
			await mcp.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
