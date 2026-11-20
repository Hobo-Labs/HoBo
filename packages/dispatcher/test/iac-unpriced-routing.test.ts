import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { types as utilTypes } from "node:util";
import {
	createTargetPricingInventory,
	hashTargetPricingInventory,
	targetPricingUnavailable,
} from "@hobo/pricing";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteIacRouteAuthority } from "../src/iac-route-sqlite.js";
import {
	executeUnpricedIacTarget,
	type UnpricedIacExecutionInput,
} from "../src/iac-unpriced-routing.js";

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

function heldAdmission(
	requestId: string,
	inventoryHash: string,
	identity: ReturnType<typeof fixture>["identity"],
) {
	const requestDigest = `sha256:${"b".repeat(64)}`;
	return {
		requestId,
		targetId: "yard",
		status: "admitted",
		code: "",
		message: "",
		requestDigest,
		inventoryHash,
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
			requestDigest,
			inventoryHash,
			identity,
			policyHash: "policy:1",
			effect: "allow",
			evidenceRef: "policy:1",
			obligationsSatisfied: true,
			observedAt: "2026-01-01T00:00:00Z",
			validUntil: "2026-02-01T00:00:00Z",
		},
	};
}

describe("explicit unpriced routing", () => {
	it("rejects proxied outputs even if the proxy predicate is replaced after dispatch", async () => {
		const { authority, inventory, pricing, identity } = fixture();
		let traps = 0;
		const original = Object.getOwnPropertyDescriptor(utilTypes, "isProxy");
		const outputs = new Proxy(
			{},
			{
				getPrototypeOf() {
					traps++;
					throw new Error("proxy trap");
				},
				ownKeys() {
					traps++;
					throw new Error("proxy trap");
				},
			},
		);
		let result: Awaited<ReturnType<typeof executeUnpricedIacTarget>>;
		try {
			result = await executeUnpricedIacTarget({
				authority,
				operation,
				tenantId: "tenant",
				requestId: "request",
				inventory,
				pricing,
				run: async (requestId, expected, permit) => {
					if (!(await authority.consumeAttempt(permit)))
						throw new Error("attempt missing");
					const admission = heldAdmission(
						requestId,
						expected.inventoryHash,
						identity,
					);
					Object.defineProperty(utilTypes, "isProxy", {
						configurable: true,
						value: () => false,
					});
					return { outputs, admission };
				},
			});
		} finally {
			if (original) Object.defineProperty(utilTypes, "isProxy", original);
		}
		expect(result).toMatchObject({
			status: "uncertain",
			executionOutcome: "completed",
			reservationId: "iac:request",
			budget: { evaluation: "bypassed", reservation: "held" },
		});
		expect(traps).toBe(0);
		authority.close();
	});

	it("retains a held reservation when an output descriptor inherits a forged value", async () => {
		const { authority, inventory, pricing, identity } = fixture();
		let traps = 0;
		const original = Object.getOwnPropertyDescriptor(Object.prototype, "value");
		const outputs = Object.defineProperty({}, "url", {
			enumerable: true,
			get() {
				traps++;
				return "getter value";
			},
		});
		let result: Awaited<ReturnType<typeof executeUnpricedIacTarget>>;
		try {
			result = await executeUnpricedIacTarget({
				authority,
				operation,
				tenantId: "tenant",
				requestId: "request",
				inventory,
				pricing,
				run: async (requestId, expected, permit) => {
					if (!(await authority.consumeAttempt(permit)))
						throw new Error("attempt missing");
					const admission = heldAdmission(
						requestId,
						expected.inventoryHash,
						identity,
					);
					Object.defineProperty(Object.prototype, "value", {
						configurable: true,
						get() {
							traps++;
							return "forged output";
						},
					});
					return { outputs, admission };
				},
			});
		} finally {
			Reflect.deleteProperty(Object.prototype, "value");
			if (original) Object.defineProperty(Object.prototype, "value", original);
		}
		expect(result).toMatchObject({
			status: "uncertain",
			executionOutcome: "completed",
			reservationId: "iac:request",
			budget: { evaluation: "bypassed", reservation: "held" },
		});
		expect(result).not.toHaveProperty("outputs");
		expect(traps).toBe(0);
		authority.close();
	});

	it.each([
		["string", () => "x".repeat(4097)],
		["array", () => Array.from({ length: 1025 }, () => true)],
		[
			"nodes",
			() =>
				Array.from({ length: 25 }, () =>
					Array.from({ length: 1000 }, () => true),
				),
		],
	] as const)("does not accept an oversized admission %s while preserving bounded snapshots", async (_kind, makeValue) => {
		const { authority, inventory, pricing, identity } = fixture();
		const result = await executeUnpricedIacTarget({
			authority,
			operation,
			tenantId: "tenant",
			requestId: "request",
			inventory,
			pricing,
			run: async (requestId, expected, permit) => {
				if (!(await authority.consumeAttempt(permit)))
					throw new Error("attempt missing");
				const admission = heldAdmission(
					requestId,
					expected.inventoryHash,
					identity,
				);
				Object.defineProperty(admission, "extra", {
					value: makeValue(),
					enumerable: true,
				});
				return { outputs: {}, admission };
			},
		});
		expect(result).toMatchObject({
			status: "uncertain",
			budget: { evaluation: "unavailable", reservation: "unknown" },
		});
		authority.close();
	});

	it("preserves the host callback's original method receiver", async () => {
		const { authority, inventory, pricing } = fixture();
		let traps = 0;
		const input = {
			authority,
			operation,
			tenantId: "tenant",
			requestId: "request",
			inventory,
			pricing,
			marker: "host-owned",
			async run(requestId: string) {
				expect(this.marker).toBe("host-owned");
				throw {
					requiresReconciliation: false,
					executionOutcome: "not-started",
					admission: {
						requestId,
						targetId: "yard",
						status: "denied",
						code: "DENIED",
						message: "denied",
						budget: { evaluation: "denied", reservation: "not-created" },
					},
				};
			},
		};
		Object.defineProperty(input.run, "call", {
			get: () => {
				traps++;
				throw new Error("mutable callback call");
			},
		});
		expect(await executeUnpricedIacTarget(input)).toMatchObject({
			status: "denied",
			code: "DENIED",
		});
		expect(traps).toBe(0);
		authority.close();
	});
	it.each([
		"outputs-proxy",
		"outputs-accessor",
		"error-code-accessor",
	] as const)("retains an unbounded hold without reading %s", async (kind) => {
		const { authority, inventory, pricing, identity } = fixture();
		let traps = 0;
		const result = await executeUnpricedIacTarget({
			authority,
			operation,
			tenantId: "tenant",
			requestId: "request",
			inventory,
			pricing,
			run: async (requestId, expected, permit) => {
				expect(await authority.consumeAttempt(permit)).toBe(true);
				const admission = heldAdmission(
					requestId,
					expected.inventoryHash,
					identity,
				);
				if (kind === "error-code-accessor") {
					const error = {
						admission,
						reservationId: `iac:${requestId}`,
						requiresReconciliation: true,
						executionOutcome: "unknown",
					};
					Object.defineProperty(error, "code", {
						get: () => {
							traps++;
							return "ERROR";
						},
					});
					throw error;
				}
				const response = { outputs: {}, admission };
				if (kind === "outputs-proxy")
					response.outputs = new Proxy(
						{},
						{
							getPrototypeOf: () => {
								traps++;
								return Object.prototype;
							},
						},
					);
				else
					Object.defineProperty(response, "outputs", {
						get: () => {
							traps++;
							return {};
						},
					});
				return response;
			},
		});
		expect(result).toMatchObject({
			status: "uncertain",
			reservationId: "iac:request",
			budget: { evaluation: "bypassed", reservation: "held" },
		});
		expect(traps).toBe(0);
		authority.close();
	});
	it.each([
		"root-accessor",
		"root-proxy",
		"inventory-accessor",
		"nested-inventory-proxy",
		"pricing-proxy",
		"run-accessor",
		"run-proxy",
		"revoked-inventory",
	] as const)("refuses %s before the route claim", async (kind) => {
		const { authority, inventory, pricing } = fixture();
		let traps = 0;
		let calls = 0;
		const fail = () => {
			traps++;
			throw new Error("untrusted getter or proxy");
		};
		const handler = {
			get: fail,
			getPrototypeOf: fail,
			ownKeys: fail,
			getOwnPropertyDescriptor: fail,
		};
		const input = {
			authority,
			operation,
			tenantId: "tenant",
			requestId: "request",
			inventory,
			pricing,
			run: async () => {
				calls++;
				throw new Error("must not run");
			},
		};
		let received = input;
		if (kind === "root-accessor")
			Object.defineProperty(input, "requestId", { get: fail });
		if (kind === "root-proxy") received = new Proxy(input, handler);
		if (kind === "inventory-accessor")
			Object.defineProperty(input, "inventory", { get: fail });
		if (kind === "nested-inventory-proxy") {
			const resource = inventory.resources[0];
			if (!resource) throw new Error("missing fixture resource");
			inventory.resources[0] = new Proxy(resource, handler);
		}
		if (kind === "pricing-proxy") input.pricing = new Proxy(pricing, handler);
		if (kind === "run-accessor")
			Object.defineProperty(input, "run", { get: fail });
		if (kind === "run-proxy") input.run = new Proxy(input.run, { apply: fail });
		if (kind === "revoked-inventory") {
			const revoked = Proxy.revocable(inventory, handler);
			revoked.revoke();
			input.inventory = revoked.proxy;
		}
		expect(await executeUnpricedIacTarget(received)).toMatchObject({
			status: "uncertain",
			budget: { evaluation: "unavailable", reservation: "unknown" },
		});
		expect(
			await authority.inspect({ tenantId: "tenant", requestId: "request" }),
		).toBeUndefined();
		expect({ traps, calls }).toEqual({ traps: 0, calls: 0 });
		authority.close();
	});

	it("uses the inventory snapshot captured before an asynchronous route claim", async () => {
		const { authority, inventory, pricing } = fixture();
		const original = hashTargetPricingInventory(inventory);
		let attemptedHash: string | undefined;
		const mutatingAuthority = {
			...authority,
			async claim(input: Parameters<typeof authority.claim>[0]) {
				const claim = await authority.claim(input);
				const resource = inventory.resources[0];
				if (!resource) throw new Error("missing fixture resource");
				resource.providerAccountRef = "changed-after-claim";
				return claim;
			},
		};
		const result = await executeUnpricedIacTarget({
			authority: mutatingAuthority,
			operation,
			tenantId: "tenant",
			requestId: "request",
			inventory,
			pricing,
			run: async (requestId, expected) => {
				attemptedHash = expected.inventoryHash;
				throw {
					requiresReconciliation: false,
					executionOutcome: "not-started",
					admission: {
						requestId,
						targetId: "yard",
						status: "denied",
						code: "DENIED",
						message: "denied",
						budget: { evaluation: "denied", reservation: "not-created" },
					},
				};
			},
		});
		expect(result.status).toBe("denied");
		expect(attemptedHash).toBe(original);
		expect(hashTargetPricingInventory(inventory)).not.toBe(original);
		authority.close();
	});
	it("selects one reviewed target without a numeric price or budget cap", async () => {
		const { authority, inventory, pricing, identity } = fixture();
		let calls = 0;
		const run: UnpricedIacExecutionInput["run"] = async (
			requestId,
			expected,
			permit,
		) => {
			calls++;
			expect(expected).toMatchObject({ kind: "unpriced", targetId: "yard" });
			expect(await authority.consumeAttempt(permit)).toBe(true);
			expect(await authority.verifyAttempt(permit)).toBe(true);

			const resource = inventory.resources[0];
			if (!resource) throw new Error("missing fixture resource");
			resource.providerAccountRef = "mutated-account";
			const digest = `sha256:${"b".repeat(64)}`;
			return {
				outputs: { url: "https://example.test", config: "x".repeat(8192) },
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
		expect(result.outputs?.config).toHaveLength(8192);
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
		const run: UnpricedIacExecutionInput["run"] = async (
			_requestId,
			_expected,
			permit,
		) => {
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
		const run: UnpricedIacExecutionInput["run"] = async (requestId) => {
			calls++;
			throw Object.assign(new Error("denied"), {
				requiresReconciliation: false,
				executionOutcome: "not-started",
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

	it.each([
		"error-proxy",
		"admission-proxy",
		"revoked-error",
		"error-inherited-reservation",
		"error-inherited-accessor",
		"error-proxy-prototype",
		"receipt-inherited-reservation",
		"receipt-proxy-prototype",
	] as const)("never records a definitive denial from %s evidence", async (kind) => {
		const { authority, inventory, pricing } = fixture();
		let traps = 0;
		let calls = 0;
		const run: Parameters<typeof executeUnpricedIacTarget>[0]["run"] = async (
			requestId,
			_expected,
			permit,
		) => {
			expect(await authority.consumeAttempt(permit)).toBe(true);
			calls++;
			let admission = {
				requestId,
				targetId: "yard",
				status: "denied",
				code: "DENIED",
				message: "denied",
				budget: { evaluation: "denied", reservation: "not-created" },
			};
			if (kind === "admission-proxy")
				admission = new Proxy(admission, {
					ownKeys: (target) => {
						traps++;
						return Reflect.ownKeys(target);
					},
				});
			if (kind === "receipt-inherited-reservation")
				Object.setPrototypeOf(admission, {
					reservation: { reservationId: "iac:request" },
				});
			if (kind === "receipt-proxy-prototype")
				Object.setPrototypeOf(
					admission,
					new Proxy(
						{},
						{
							getOwnPropertyDescriptor: () => {
								traps++;
								return undefined;
							},
						},
					),
				);
			const failure = {
				admission,
				requiresReconciliation: false,
				executionOutcome: "not-started",
			};
			if (kind === "error-inherited-reservation")
				Object.setPrototypeOf(failure, { reservationId: "iac:request" });
			if (kind === "error-inherited-accessor")
				Object.setPrototypeOf(
					failure,
					Object.defineProperty({}, "reservationId", {
						get: () => {
							traps++;
							return undefined;
						},
					}),
				);
			if (kind === "error-proxy-prototype")
				Object.setPrototypeOf(
					failure,
					new Proxy(
						{},
						{
							getOwnPropertyDescriptor: () => {
								traps++;
								return undefined;
							},
						},
					),
				);
			if (kind === "error-proxy")
				throw new Proxy(failure, {
					ownKeys: (target) => {
						traps++;
						return Reflect.ownKeys(target);
					},
				});
			if (kind === "revoked-error") {
				const revoked = Proxy.revocable(failure, {});
				revoked.revoke();
				throw revoked.proxy;
			}
			throw failure;
		};
		const input = {
			authority,
			operation,
			tenantId: "tenant",
			requestId: "request",
			inventory,
			pricing,
			run,
		};
		const result = await executeUnpricedIacTarget(input);
		expect(result).toMatchObject({
			status: "uncertain",
			budget: { evaluation: "unavailable", reservation: "unknown" },
		});
		expect(
			await authority.inspect({ tenantId: "tenant", requestId: "request" }),
		).toMatchObject({ phase: "finished", outcome: { status: "uncertain" } });
		expect(await executeUnpricedIacTarget(input)).toMatchObject({
			status: "uncertain",
		});
		expect(calls).toBe(1);
		expect(traps).toBe(0);
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

	it.each([
		undefined,
		"unknown",
		"completed",
		"malformed",
	])("does not record a definitive denial with execution outcome %s", async (outcome) => {
		const { authority, inventory, pricing } = fixture();
		const result = await executeUnpricedIacTarget({
			authority,
			operation,
			tenantId: "tenant",
			requestId: "request",
			inventory,
			pricing,
			run: async (requestId) => {
				throw Object.assign(new Error("denied"), {
					requiresReconciliation: false,
					executionOutcome: outcome,
					admission: {
						requestId,
						targetId: "yard",
						status: "denied",
						code: "DENIED",
						message: "denied",
						budget: { evaluation: "denied", reservation: "not-created" },
					},
				});
			},
		});
		expect(result.status).toBe("uncertain");
		authority.close();
	});

	it.each([
		"inherited",
		"accessor",
	])("does not trust %s no-effect markers", async (mode) => {
		const { authority, inventory, pricing } = fixture();
		const result = await executeUnpricedIacTarget({
			authority,
			operation,
			tenantId: "tenant",
			requestId: "request",
			inventory,
			pricing,
			run: async (requestId) => {
				const admission = {
					requestId,
					targetId: "yard",
					status: "denied",
					code: "DENIED",
					message: "denied",
					budget: { evaluation: "denied", reservation: "not-created" },
				};
				if (mode === "accessor")
					throw Object.defineProperty(
						{ admission, requiresReconciliation: false },
						"executionOutcome",
						{ get: () => "not-started" },
					);
				throw Object.assign(
					Object.create({
						requiresReconciliation: false,
						executionOutcome: "not-started",
					}),
					{ admission },
				);
			},
		});
		expect(result.status).toBe("uncertain");
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

	it.each([
		"unrepresentable output",
		"provider error",
		"contradictory reservation",
	])("reports unpriced reconciliation after %s", async (mode) => {
		const { authority, inventory, pricing, identity } = fixture();
		const result = await executeUnpricedIacTarget({
			authority,
			operation,
			tenantId: "tenant",
			requestId: "request",
			inventory,
			pricing,
			run: async (requestId, expected, permit) => {
				expect(await authority.consumeAttempt(permit)).toBe(true);
				const digest = `sha256:${"b".repeat(64)}`;
				const admission = {
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
				};
				if (mode !== "unrepresentable output")
					throw Object.assign(new Error("bad output"), {
						admission,
						reservationId:
							mode === "provider error" ? `iac:${requestId}` : "iac:other",
						requiresReconciliation: true,
						executionOutcome: "completed",
					});
				return { outputs: { tooLong: "x".repeat(65_537) }, admission };
			},
		});
		if (mode === "contradictory reservation") {
			expect(result).toMatchObject({
				status: "uncertain",
				budget: { evaluation: "unavailable", reservation: "unknown" },
			});
			expect(result).not.toHaveProperty("reservationId");
		} else
			expect(result).toMatchObject({
				status: "uncertain",
				executionOutcome: "completed",
				reservationId: "iac:request",
				budget: { evaluation: "bypassed", reservation: "held" },
				policy: { evidenceRef: "policy:1" },
				scope: { evidenceRef: "scope:1" },
			});
		authority.close();
	});
});
