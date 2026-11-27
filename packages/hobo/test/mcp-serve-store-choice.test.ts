import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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