import { runRuntimePortDurabilitySuite } from "@hobo/conformance/runtime-port";
import { describe, expect, it } from "vitest";
import {
	createBrokenFenceRuntimeBackend,
	createRuntimeLocalDurabilityBackend,
} from "./helpers.js";

describe("@hobo/runtime-local runtime-port conformance gate", () => {
	it("passes the full runtime-port durability suite", async () => {
		const report = await runRuntimePortDurabilitySuite(
			createRuntimeLocalDurabilityBackend,
		);

		expect(report.status).toBe("pass");
		expect(report.coverage.local).toEqual({
			status: "pass",
			passed: 5,
			failed: 0,
			total: 5,
		});
	});

	it("rejects a backend that accepts stale lease appends", async () => {
		const report = await runRuntimePortDurabilitySuite(
			createBrokenFenceRuntimeBackend,
		);

		expect(report.status).toBe("fail");
		expect(report.failures).toEqual([
			{
				checkId: "actorHost.local.stale-fence-rejected",
				message: "stale lease append was accepted",
			},
		]);
	});
});
