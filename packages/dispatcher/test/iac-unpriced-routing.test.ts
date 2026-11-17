import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createTargetPricingInventory,
	targetPricingUnavailable,
} from "@hobo/pricing";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteIacRouteAuthority } from "../src/iac-route-sqlite.js";
import { executeUnpricedIacTarget } from "../src/iac-unpriced-routing.js";

const dirs: string[] = [];
const operation = {
	operationId: `sha256:${"e".repeat(64)}`,
	authorization: "signed:request",
};
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "hobo-unpriced-routing-"));
	dirs.push(dir);
	const authority = createSqliteIacRouteAuthority({
		path: join(dir, "routes.sqlite"),
		verifyOperation: (proof) =>
			proof.tenantId === "tenant" &&
			proof.operationId === operation.operationId &&
			proof.authorization === `signed:${proof.requestId}`,
	});
	const inventory = createTargetPricingInventory({
		targetId: "yard",
		tenantId: "tenant",
		planDigest: `sha256:${"a".repeat(64)}`,
		operation: "deploy",
		complete: true,
		evidenceRef: "inventory:1",
		resources: [
			{
				resourceId: "app",
				providerId: "provider",
				providerAccountRef: "account",
				productId: "compute",
			},
		],
	});
	const identity = {
		tenantId: "tenant",
		budgetId: "hosting",
		periodId: "month",
		policyRevision: "r1",
	};
	return {
		authority,
		inventory,
		pricing: targetPricingUnavailable("no model"),
		identity,
	};
}

describe("explicit unpriced routing", () => {
	it("selects one reviewed target without a numeric price or budget cap", async () => {
		const { authority, inventory, pricing, identity } = fixture();
		let calls = 0;
		const run = async (requestId, expected, permit) => {
			calls++;
			expect(expected).toMatchObject({ kind: "unpriced", targetId: "yard" });
			expect(await authority.consumeAttempt(permit)).toBe(true);
			expect(await authority.verifyAttempt(permit)).toBe(true);
			// A caller cannot change the financial scope after the route is claimed.
			inventory.resources[0]!.providerAccountRef = "mutated-account";
			const digest = `sha256:${"b".repeat(64)}`;
			return {
				outputs: { url: "https://example.test" },
				admission: {
					requestId,
					targetId: "yard",
					status: "admitted",
					code: "",
					message: "",
					requestDigest: digest,
					inventoryHash: expected.inventoryHash,
					budget: { evaluation: "bypassed", reservation: "held" },
					reservation: {
						reservationId: `iac:${requestId}`,
						unboundedExposure: true,
						unpricedScopeProof: {
							identity,
							providerAccountIds: ["account"],
							authorityRef: "scope",
							evidenceRef: "scope:1",
							ownershipEpoch: "e1",
							observedAt: "2026-01-01T00:00:00Z",
							exclusiveUntilSettled: true,
							noSharedEntitlements: true,
							signature: "sig",
						},
					},
					unpricedPolicyProof: {
						requestDigest: digest,
						inventoryHash: expected.inventoryHash,
						identity,
						policyHash: "policy:1",
						effect: "allow",
						evidenceRef: "policy:1",
						obligationsSatisfied: true,
						observedAt: "2026-01-01T00:00:00Z",
						validUntil: "2026-02-01T00:00:00Z",
					},
				},
			};
		};
		const result = await executeUnpricedIacTarget({
			authority,
			operation,
			tenantId: "tenant",
			requestId: "request",
			inventory,
			pricing,
			run,
		});
		expect(result).toMatchObject({
			status: "selected",
			targetId: "yard",
			pricing: { status: "unavailable" },
			budget: { evaluation: "bypassed", reservation: "held" },
		});
		expect(result).not.toHaveProperty("rank");
		expect(
			await executeUnpricedIacTarget({
				authority,
				operation,
				tenantId: "tenant",
				requestId: "request",
				inventory,
				pricing,
				run,
			}),
		).toMatchObject({ status: "replay" });
		const secondRequest = await executeUnpricedIacTarget({
			authority,
			operation: { ...operation, authorization: "signed:another-request" },
			tenantId: "tenant",
			requestId: "another-request",
			inventory,
			pricing,
			run,
		});
		expect(["replay", "uncertain"]).toContain(secondRequest.status);
		expect(calls).toBe(1);
		authority.close();
	});

	it("does not execute without authenticated logical-operation ownership", async () => {
		const { authority, inventory, pricing } = fixture();
		let calls = 0;
		const result = await executeUnpricedIacTarget({
			authority,
			operation: { ...operation, authorization: "forged" },
			tenantId: "tenant",
			requestId: "request",
			inventory,
			pricing,
			run: async () => {
				calls++;
				throw new Error("unexpected");
			},
		});
		expect(result.status).toBe("uncertain");
		expect(calls).toBe(0);
		authority.close();
	});

	it("blocks a concurrent request for the same operation while its provider outcome is unknown", async () => {
		const { authority, inventory, pricing } = fixture();
		let start!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			start = resolve;
		});
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const run = async (_requestId, _expected, permit) => {
			expect(await authority.consumeAttempt(permit)).toBe(true);
			calls++;
			start();
			await pending;
			throw new Error("provider outcome lost");
		};
		const first = executeUnpricedIacTarget({
			authority,
			operation,
			tenantId: "tenant",
			requestId: "request",
			inventory,
			pricing,
			run,
		});
		await started;
		const second = await executeUnpricedIacTarget({
			authority,
			operation: { ...operation, authorization: "signed:another-request" },
			tenantId: "tenant",
			requestId: "another-request",
			inventory,
			pricing,
			run,
		});
		expect(second.status).toBe("uncertain");
		expect(calls).toBe(1);
		release();
		expect((await first).status).toBe("uncertain");
		authority.close();
	});

	it("does not execute an incomplete or incorrectly scoped inventory", async () => {
		const { authority, inventory, pricing } = fixture();
		inventory.complete = false;
		let calls = 0;
		const result = await executeUnpricedIacTarget({
			authority,
			operation,
			tenantId: "tenant",
			requestId: "request",
			inventory,
			pricing,
			run: async () => {
				calls++;
				throw new Error("unexpected");
			},
		});
		expect(result).toMatchObject({
			status: "denied",
			code: "UNPRICED_TARGET_INVALID",
			budget: { evaluation: "not-evaluated", reservation: "not-created" },
		});
		expect(calls).toBe(0);
		authority.close();
	});

	it("records a definitive no-effect denial and never retries the finished route", async () => {
		const { authority, inventory, pricing } = fixture();
		let calls = 0;
		const run = async (requestId) => {
			calls++;
			throw Object.assign(new Error("denied"), {
				requiresReconciliation: false,
				admission: {
					requestId,
					targetId: "yard",
					status: "denied",
					code: "POLICY_DENIED",
					message: "denied",
					budget: { evaluation: "denied", reservation: "not-created" },
				},
			});
		};
		expect(
			await executeUnpricedIacTarget({
				authority,
				operation,
				tenantId: "tenant",
				requestId: "request",
				inventory,
				pricing,
				run,
			}),
		).toMatchObject({ status: "denied", code: "POLICY_DENIED" });
		expect(
			await executeUnpricedIacTarget({
				authority,
				operation,
				tenantId: "tenant",
				requestId: "request",
				inventory,
				pricing,
				run,
			}),
		).toMatchObject({ status: "replay" });
		expect(calls).toBe(1);
		authority.close();
	});

	it("does not treat a denied receipt with missing reconciliation state as definitive", async () => {
		const { authority, inventory, pricing } = fixture();
		const result = await executeUnpricedIacTarget({
			authority,
			operation,
			tenantId: "tenant",
			requestId: "request",
			inventory,
			pricing,
			run: async (requestId) => {
				throw Object.assign(new Error("bad receipt"), {
					admission: {
						requestId,
						targetId: "yard",
						status: "denied",
						code: "POLICY_DENIED",
						message: "denied",
						budget: { evaluation: "denied", reservation: "not-created" },
					},
				});
			},
		});
		expect(result).toMatchObject({
			status: "uncertain",
			budget: { evaluation: "unavailable", reservation: "unknown" },
		});
		authority.close();
	});

	it("retains uncertainty when a provider receipt cannot prove the selected scope", async () => {
		const { authority, inventory, pricing } = fixture();
		const result = await executeUnpricedIacTarget({
			authority,
			operation,
			tenantId: "tenant",
			requestId: "request",
			inventory,
			pricing,
			run: async () => ({
				outputs: {},
				admission: {
					requestId: "other",
					targetId: "yard",
					status: "admitted",
					code: "",
					message: "",
					budget: { evaluation: "bypassed", reservation: "held" },
				},
			}),
		});
		expect(result).toMatchObject({
			status: "uncertain",
			budget: { evaluation: "unavailable", reservation: "unknown" },
		});
		authority.close();
	});
});
