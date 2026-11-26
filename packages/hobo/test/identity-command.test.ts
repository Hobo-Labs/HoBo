import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createContractAssertedDualFixtures,
	IdentityMigrationService,
} from "@hobo/identity";
import { describe, expect, it } from "vitest";
import {
	createIdentityCommand,
	persistMigrationEvents,
} from "../src/identity-command.js";
import type { JsonObject } from "../src/json.js";

function runInput(args: string[], hoboHome: string) {
	return {
		args,
		// SAFETY: assertion required at this I/O or test boundary.
		flags: {} as JsonObject,
		context: { cwd: hoboHome, projectDir: hoboHome },
		emitProgress: () => {},
	};
}

describe("hobo identity (observe-only)", () => {
	it("status reports idle dual fixtures and can-migrate with zero Bindle config", async () => {
		const hoboHome = mkdtempSync(join(tmpdir(), "hobo-id-cmd-"));
		const cmd = createIdentityCommand({ hoboHome, env: {} });
		// SAFETY: assertion required at this I/O or test boundary.
		const result = await cmd.run(runInput(["status"], hoboHome) as never);
		expect(result.ok).toBe(true);
		expect(result.data?.bindleConfigRequired).toBe(false);
		expect(result.data?.observeOnly).toBe(true);
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			(result.data?.dualFixtures as { dualOracleOk?: boolean })?.dualOracleOk,
		).toBe(true);
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			(result.data?.canMigrate as { continuousDefault?: boolean })
				?.continuousDefault,
		).toBe(true);
	});

	it("inspect returns active migration when events are present", async () => {
		const hoboHome = mkdtempSync(join(tmpdir(), "hobo-id-cmd-"));
		const dual = createContractAssertedDualFixtures({ tenant: "local" });
		const svc = new IdentityMigrationService({ tenant: "local" });
		svc.start({
			tenant: "local",
			sourceAdapter: dual.sourceAdapter,
			targetAdapter: dual.targetAdapter,
			mapping: dual.mapping,
			reason: "adapter-change",
		});
		persistMigrationEvents(hoboHome, svc.events);
		const cmd = createIdentityCommand({ hoboHome, env: {} });
		// SAFETY: assertion required at this I/O or test boundary.
		const status = await cmd.run(runInput(["status"], hoboHome) as never);
		expect(status.data?.migration).toMatchObject({ present: true });
		// SAFETY: assertion required at this I/O or test boundary.
		const id = (status.data?.migration as { migrationId?: string })
			?.migrationId;
		expect(id).toBeTruthy();
		const inspect = await cmd.run(
			// SAFETY: assertion required at this I/O or test boundary.
			runInput(["inspect", String(id)], hoboHome) as never,
		);
		expect(inspect.ok).toBe(true);
		expect(inspect.data?.bindleConfigRequired).toBe(false);
	});
});
