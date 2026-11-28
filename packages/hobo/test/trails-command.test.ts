import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";

import { createTrailsCommand } from "../src/trails-command.js";

function runInput(args: string[]) {
	return {
		args,
		// SAFETY: assertion required at this I/O or test boundary.
		flags: {} as JsonObject,
		context: { cwd: "/tmp", projectDir: "/tmp" },
		emitProgress: () => {},
	};
}

describe("hobo trails (observe-only)", () => {
	it("status reports hands-off identity continuous and app sample trail", async () => {
		const cmd = createTrailsCommand({ env: {} });
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await cmd.run(runInput(["status"]) as never);
		expect(result.ok).toBe(true);
		expect(result.data?.observeOnly).toBe(true);
		expect(result.data?.bindleConfigRequiredForIdentityContinuous).toBe(false);
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			(
				result.data?.identityContinuous as {
					handsOff?: boolean;
					bindleConfigRequired?: boolean;
				}
			)?.handsOff,
		).toBe(true);
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			(result.data?.identityContinuous as { bindleConfigRequired?: boolean })
				?.bindleConfigRequired,
		).toBe(false);
		// SAFETY: assertion required at this I/O or test boundary.
		expect((result.data?.handsOffOracle as { ok?: boolean })?.ok).toBe(true);
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			(result.data?.appTrail as { canTrailOk?: boolean })?.canTrailOk,
		).toBe(true);
	});

	it("plan returns dry-run can-trail evidence", async () => {
		const cmd = createTrailsCommand({ env: {} });
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await cmd.run(runInput(["plan"]) as never);
		expect(result.ok).toBe(true);
		// SAFETY: assertion required at this I/O or test boundary.
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
			// SAFETY: assertion required at this I/O or test boundary.
			runInput(["inspect", "platform.identity.continuous"]) as never,
		);
		expect(result.ok).toBe(true);
		expect(result.data?.bindleConfigRequired).toBe(false);
		// SAFETY: assertion required at this I/O or test boundary.
		expect((result.data?.trail as { id?: string })?.id).toBe(
			"platform.identity.continuous",
		);
	});
});
