import { describe, expect, it } from "vitest";
import {
	proveCheckoutDurability,
	RUNTIME_PORT_CONFORMANCE_VERSION,
	runRuntimePortDurabilitySuite,
} from "../src/suites/runtime-port/index.js";
import { createBrokenFenceRuntimeBackend } from "./fixtures/broken-fence-backend.js";
import { createRuntimeLocalDurabilityBackend } from "./fixtures/reference-backend.js";

describe("runtime-port durability suite", () => {
	it("runtime-local passes the runtime-port durability conformance suite", async () => {
		const report = await runRuntimePortDurabilitySuite(
			createRuntimeLocalDurabilityBackend,
		);

		expect(report.contract).toBe(RUNTIME_PORT_CONFORMANCE_VERSION);
		expect(report.backend).toBe("runtime-local");
		expect(report.status).toBe("pass");
		expect(report.failures).toEqual([]);
		expect(report.coverage.local).toEqual({
			status: "pass",
			passed: 5,
			failed: 0,
			total: 5,
		});
		expect(report.checks.map((check) => [check.checkId, check.status])).toEqual(
			[
				["eventStore.local.seq-conditional-append", "pass"],
				["eventStore.local.idempotency-key-dedup", "pass"],
				["queue.local.idempotency-key-dedup", "pass"],
				["actorHost.local.stale-fence-rejected", "pass"],
				["runtime.local.checkout-replay-equals-live", "pass"],
			],
		);
	});

	it("checkout durability proof replays the same final state from the event log", async () => {
		const proof = await proveCheckoutDurability(
			createRuntimeLocalDurabilityBackend(),
		);

		expect(proof.liveState).toEqual(proof.replayState);
		expect(proof.replayState).toEqual({
			runId: "checkout:run-1",
			status: "paid",
			reservedItems: ["sku-hobo-mug"],
			chargedCents: 4200,
			duplicateCharges: 0,
			timedOut: false,
		});
		expect(proof.queueEffects).toEqual(["charge:checkout:run-1"]);
		expect(proof.clockTrace.map((entry) => entry.type)).toEqual([
			"clock.started",
			"timer.scheduled",
			"clock.advanced",
			"timer.fired",
		]);
	});

	it("broken-fence backend fails exactly actorHost.local.stale-fence-rejected", async () => {
		const report = await runRuntimePortDurabilitySuite(
			createBrokenFenceRuntimeBackend,
		);

		expect(report.backend).toBe("runtime-local");
		expect(report.status).toBe("fail");
		expect(report.failures).toEqual([
			{
				checkId: "actorHost.local.stale-fence-rejected",
				message: "stale lease append was accepted",
			},
		]);
	});
});
