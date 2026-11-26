import { describe, expect, it, vi } from "vitest";
import {
	denyDirectSandboxEgress,
	isolatedExecutionWiring,
} from "../src/execution-wiring.js";

it("denies legacy direct Function proxy requests without consuming their bodies", () => {
	for (const path of ["/sandbox/egress", "/sandbox/egress/anything"]) {
		const request = new Request(`https://relay.example${path}`, {
			method: "POST",
			body: "untrusted",
		});
		expect(denyDirectSandboxEgress(request)?.status).toBe(404);
		expect(request.bodyUsed).toBe(false);
	}
	expect(
		denyDirectSandboxEgress(
			new Request("https://relay.example/sandbox/egress-other"),
		),
	).toBeUndefined();
});

describe("isolated execution opt-in", () => {
	it("keeps admission, dispatch and readiness disabled without a host", async () => {
		const wiring = isolatedExecutionWiring();
		const runtime = vi.fn(async () => true);
		const worker = vi.fn(async () => true);
		expect(wiring.relay.denyUnisolated).toBe(true);
		expect(wiring.relay.isolatedHost).toBeUndefined();
		expect(wiring.runtime.isolatedHost).toBeUndefined();
		expect(wiring.runtime.isolatedRecoveryHost).toBeUndefined();
		expect(await wiring.ready(runtime, worker)).toBe(false);
		expect(runtime).not.toHaveBeenCalled();
		expect(worker).not.toHaveBeenCalled();
	});
	it("shares the same host across admission, dispatch and recovery, without enabling bridges", async () => {
		const host = {
			launch: vi.fn(async () => {}),
			reconcile: vi.fn(async () => {}),
		};
		const wiring = isolatedExecutionWiring(host);
		expect(wiring.relay).toEqual({ denyUnisolated: true, isolatedHost: host });
		expect(wiring.runtime).toEqual({
			denyUnisolated: true,
			isolatedHost: host,
			isolatedRecoveryHost: host,
		});
		expect(
			await wiring.ready(
				async () => true,
				async () => true,
			),
		).toBe(true);
		expect(
			await wiring.ready(
				async () => false,
				async () => true,
			),
		).toBe(false);
		expect(
			await wiring.ready(
				async () => true,
				async () => false,
			),
		).toBe(false);
	});
});
