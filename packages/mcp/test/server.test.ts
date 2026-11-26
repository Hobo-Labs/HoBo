import { afterEach, describe, expect, it } from "vitest";

import { createHoboMcpServer } from "../src/server.js";
import {
	authGranting,
	closeStores,
	HELLO_BINDLE,
	makeWiredCli,
	withProject,
} from "./helpers.js";

afterEach(() => closeStores());

// S3-01 — a scripted agent drives plan then up through the MCP server, reaching
// deployment.Deployed by reusing the CLI dispatch seam + an injected YardRuntime.

describe("scripted agent drives plan -> up through the MCP server", () => {
	it("reaches deployment.Deployed over the shared @hobo/cli dispatch path", async () => {
		await withProject(HELLO_BINDLE, async (cwd) => {
			const server = createHoboMcpServer({ cli: makeWiredCli() });
			const auth = authGranting(["plan", "up", "login"]);

			const plan = await server.callTool("plan", { cwd }, auth);
			expect(plan.ok).toBe(true);
			expect(plan.tool).toBe("plan");
			interface PlanOutput {
				status: string;
				data: { planHash: string };
			}
			// SAFETY: CLI --json envelope for plan carries status + planHash.
			const planOut = plan.output as PlanOutput;
			expect(planOut.status).toBe("ok");
			expect(planOut.data.planHash).toMatch(/^sha256:/);

			const up = await server.callTool("up", { cwd }, auth);
			expect(up.ok).toBe(true);
			expect(up.status).toBe("deployed");
			interface UpOutput {
				status: string;
				data: { provisioned: string[]; progress: Array<{ type: string }> };
			}
			// SAFETY: CLI --json envelope for up carries provisioned + progress.
			const upOut = up.output as UpOutput;
			expect(upOut.status).toBe("deployed");
			expect(upOut.data.provisioned).toEqual(["assets", "service", "sessions"]);
			const provisioned = upOut.data.progress.filter(
				(p) => p.type === "resource.Provisioned",
			);
			expect(provisioned.length).toBe(3);

			// Every authorized call left an audited allow decision.
			const decisions = server.getAuditEvents();
			expect(decisions.filter((e) => e.data.effect === "allow").length).toBe(2);
			expect(decisions.every((e) => e.retention.neverCompact === true)).toBe(
				true,
			);
		});
	});

	it("lists the full derived tool surface", async () => {
		const server = createHoboMcpServer({ cli: makeWiredCli() });
		expect(server.listTools().length).toBeGreaterThan(0);
		expect(server.parity().ok).toBe(true);
	});
});
