import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
	ControlModel,
	describeNightlyPlan,
	handleControlRequest,
	runSchemathesis,
} from "../../src/index.js";

describe("in-process API fuzz oracles", () => {
	it("apply is idempotent and tenant A cannot read tenant B", () => {
		const world = new ControlModel();
		const created = handleControlRequest(world, {
			method: "POST",
			path: "/v1/bindles",
			tenantId: "tenant-a",
			body: { bindleId: "app", manifestHash: "h1" },
		});
		expect(created.status).toBe(200);
		const first = handleControlRequest(world, {
			method: "POST",
			path: "/v1/bindles/app/apply",
			tenantId: "tenant-a",
			body: { idempotencyKey: "k1" },
		});
		const second = handleControlRequest(world, {
			method: "POST",
			path: "/v1/bindles/app/apply",
			tenantId: "tenant-a",
			body: { idempotencyKey: "k1" },
		});
		expect(first.body.id).toBe(second.body.id);
		const leak = handleControlRequest(world, {
			method: "GET",
			path: "/v1/tenants/tenant-a/resources",
			tenantId: "tenant-b",
		});
		expect(leak.status).toBe(403);
		const missingTenant = handleControlRequest(world, {
			method: "GET",
			path: "/v1/tenants/tenant-a/resources",
		});
		expect(missingTenant.status).toBe(403);
		const missingBindle = handleControlRequest(world, {
			method: "POST",
			path: "/v1/bindles/ghost/apply",
			tenantId: "tenant-a",
			body: { idempotencyKey: "k9" },
		});
		expect(missingBindle.status).toBe(404);
		const stolen = handleControlRequest(world, {
			method: "POST",
			path: "/v1/bindles",
			tenantId: "tenant-b",
			body: { bindleId: "app", manifestHash: "h2" },
		});
		expect(stolen.status).toBe(409);
		const wreck = handleControlRequest(world, {
			method: "POST",
			path: "/v1/bindles/app/destroy",
			tenantId: "tenant-b",
		});
		expect(wreck.status).toBe(403);
		expect(world.ownedCount("tenant-a")).toBe(1);
	});

	it("rejects prototype injection and unknown routes fail-closed", () => {
		const world = new ControlModel();
		const polluted = handleControlRequest(world, {
			method: "POST",
			path: "/v1/bindles",
			tenantId: "tenant-a",
			body: { bindleId: "x", constructor: { admin: true } },
		});
		expect(polluted.status).toBe(400);
		const missing = handleControlRequest(world, {
			method: "DELETE",
			path: "/v1/secret",
			tenantId: "tenant-a",
		});
		expect(missing.status).toBe(404);
	});

	it("random tenant-A requests never mint tenant-B resources", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						bindleId: fc.constantFrom("app", "other"),
						key: fc.constantFrom("k1", "k2"),
					}),
					{ minLength: 1, maxLength: 12 },
				),
				(ops) => {
					const world = new ControlModel();
					handleControlRequest(world, {
						method: "POST",
						path: "/v1/bindles",
						tenantId: "tenant-b",
						body: { bindleId: "keep", manifestHash: "hb" },
					});
					handleControlRequest(world, {
						method: "POST",
						path: "/v1/bindles/keep/apply",
						tenantId: "tenant-b",
						body: { idempotencyKey: "owned" },
					});
					const before = world.fingerprint("tenant-b");
					for (const op of ops) {
						handleControlRequest(world, {
							method: "POST",
							path: "/v1/bindles",
							tenantId: "tenant-a",
							body: { bindleId: op.bindleId, manifestHash: "ha" },
						});
						handleControlRequest(world, {
							method: "POST",
							path: `/v1/bindles/${op.bindleId}/apply`,
							tenantId: "tenant-a",
							body: { idempotencyKey: op.key },
						});
					}
					expect(world.fingerprint("tenant-b")).toBe(before);
				},
			),
			{ numRuns: 24 },
		);
	});

	it("skips Schemathesis and docker-gated nightly tools when absent", () => {
		const previous = process.env.HOBO_FUZZ_DOCKER;
		process.env.HOBO_FUZZ_DOCKER = "0";
		try {
			const nightly = describeNightlyPlan();
			expect(nightly.liveClouds).toBe("forbidden");
			expect(nightly.docker).toBe(false);
			expect(nightly.skipped).toContain("restler");
			expect(runSchemathesis().ran).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.HOBO_FUZZ_DOCKER;
			else process.env.HOBO_FUZZ_DOCKER = previous;
		}
	});
});
