import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";

import { createTrailsCommand } from "../src/trails-command.js";

function runInput(args: string[]) {
	return {
		args,
		flags: {} as JsonObject,
		context: { cwd: "/tmp", projectDir: "/tmp" },
		emitProgress: () => {},
	};
}

describe("hobo trails (observe-only)", () => {
	it("status reports hands-off identity continuous and app sample trail", async () => {
		const cmd = createTrailsCommand({ env: {} });
		const result = await cmd.run(runInput(["status"]) as never);
		expect(result.ok).toBe(true);
		expect(result.data?.observeOnly).toBe(true);
		expect(result.data?.bindleConfigRequiredForIdentityContinuous).toBe(false);
		expect(
			(
				result.data?.identityContinuous as {
					handsOff?: boolean;
					bindleConfigRequired?: boolean;
				}
			)?.handsOff,
		).toBe(true);
		expect(
			(result.data?.identityContinuous as { bindleConfigRequired?: boolean })
				?.bindleConfigRequired,
		).toBe(false);
		expect((result.data?.handsOffOracle as { ok?: boolean })?.ok).toBe(true);
		expect(
			(result.data?.appTrail as { canTrailOk?: boolean })?.canTrailOk,
		).toBe(true);
	});

	it("plan returns dry-run can-trail evidence", async () => {
		const cmd = createTrailsCommand({ env: {} });
		const result = await cmd.run(runInput(["plan"]) as never);
		expect(result.ok).toBe(true);
		const plan = result.data?.plan as {
			dryRun?: boolean;
			identityContinuous?: boolean;
		};
		expect(plan?.dryRun).toBe(true);
		expect(plan?.identityContinuous).toBe(true);
	});

	it("inspect resolves platform identity continuous trail", async () => {
		const cmd = createTrailsCommand({ env: {} });
		const result = await cmd.run(
			runInput(["inspect", "platform.identity.continuous"]) as never,
		);
		expect(result.ok).toBe(true);
		expect(result.data?.bindleConfigRequired).toBe(false);
		expect((result.data?.trail as { id?: string })?.id).toBe(
			"platform.identity.continuous",
		);
	});
});
