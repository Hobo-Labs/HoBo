import { performance } from "node:perf_hooks";
import { DURABLE_MESSAGING_LIMITS, type DurableMessaging } from "@hobo/core";
import { describe, expect, it, vi } from "vitest";
import {
	createDurableMessagingLifecycle,
	createDurableMessagingLimitsGrant,
	createDurableMessagingPortMetadataGrant,
	createDurableMessagingWitHost,
	createDurableTopicPolicy,
	DURABLE_MESSAGING_WIT_INTERFACE,
	type DurableMessagingAsyncComponent,
	type DurableMessagingAsyncImports,
	type DurableTopicPolicyClaim,
	instantiateDurableMessagingAsync,
	supportsDurableMessagingAsync,
} from "../src/durable-messaging-host.js";

const expiresAt = 2_000_000_000_000;
const operation = {
	id: `v1.${expiresAt}.abcdefghijklmnop`,
	expiresAtMs: BigInt(expiresAt),
};
const subscription = {
	topic: "orders",
	consumerGroup: "workers",
	deadLetterTopic: "orders-dlq",
	maxDeliveryAttempts: 3,
	startAt: "earliest" as const,
};
const message = {
	id: "message-1",
	subject: "created",
	payload: new Uint8Array([1, 2]),
	attributes: [{ key: "source", value: "checkout" }],
};
const delivery = {
	message,
	sequence: 1,
	topic: "orders",
	consumerGroup: "workers",
	leaseId: "lease-1",
	leaseExpiresAtMs: expiresAt + 500,
	deliveryAttempt: 1,
};

function fixture(overrides: Partial<DurableMessaging> = {}) {
	const port: DurableMessaging = {
		limits: DURABLE_MESSAGING_LIMITS,
		ensureTopic: vi.fn<DurableMessaging["ensureTopic"]>(async ({ topic }) => ({
			status: "committed",
			value: { topic },
		})),
		ensureSubscription: vi.fn<DurableMessaging["ensureSubscription"]>(
			async ({ subscription: value }) => ({
				status: "committed",
				value: {
					subscription: value,
					firstAvailableSequence: 1,
					historyTruncated: false,
				},
			}),
		),
		publish: vi.fn<DurableMessaging["publish"]>(async ({ message: value }) => ({
			status: "committed",
			value: { messageId: value.id, sequence: 1 },
		})),
		consume: vi.fn<DurableMessaging["consume"]>(async () => ({
			status: "committed",
			value: [delivery],
		})),
		ack: vi.fn<DurableMessaging["ack"]>(async ({ messageId, sequence }) => ({
			status: "committed",
			value: { messageId, sequence },
		})),
		nack: vi.fn<DurableMessaging["nack"]>(async ({ messageId, sequence }) => ({
			status: "committed",
			value: { messageId, sequence, disposition: "released" },
		})),
		compact: vi.fn<DurableMessaging["compact"]>(async ({ topic }) => ({
			status: "committed",
			value: { topic, firstAvailableSequence: 2, removedMessages: 1 },
		})),
		events: vi.fn<DurableMessaging["events"]>(async ({ afterSequence }) => ({
			status: "ok",
			events: [],
			firstAvailableSequence: 1,
			nextAfterSequence: afterSequence,
			hasMore: false,
		})),
		...overrides,
	};
	return {
		port,
		host: createDurableMessagingWitHost(port, {
			authorize: () => true,
			limitsGrant: createDurableMessagingLimitsGrant(),
			lifecycle: createDurableMessagingLifecycle(),
		}),
	};
}

describe("durable messaging WIT host boundary", () => {
	it("refuses an exotic verifier promise without reading its constructor", () => {
		const { port } = fixture();
		let reads = 0;
		const pending = new Promise(() => {});
		Object.defineProperty(pending, "constructor", {
			get() {
				reads++;
				throw new Error("unexpected constructor read");
			},
		});
		const options = {
			port,
			limits: DURABLE_MESSAGING_LIMITS,
			verify: () => true,
		};
		Object.defineProperty(options, "verify", { value: () => pending });
		expect(() => createDurableMessagingPortMetadataGrant(options)).toThrow();
		expect(reads).toBe(0);
	});

	it("does not accept a forged limits grant through substituted WeakMap methods", () => {
		const { port } = fixture();
		const grant = Object.freeze({ revoke() {} });
		const lifecycle = createDurableMessagingLifecycle();
		const nativeGet = WeakMap.prototype.get;
		const original = Object.getOwnPropertyDescriptor(WeakMap.prototype, "get");
		if (original === undefined) throw new Error("WeakMap.get missing");
		let calls = 0;
		let accepted = false;
		try {
			Object.defineProperty(WeakMap.prototype, "get", {
				...original,
				value<K extends object>(this: WeakMap<K, unknown>, key: K) {
					if (key === grant) {
						calls++;
						return { active: true };
					}
					return nativeGet.call(this, key);
				},
			});
			try {
				createDurableMessagingWitHost(port, {
					authorize: () => true,
					limitsGrant: grant,
					lifecycle,
				});
				accepted = true;
			} catch {}
		} finally {
			Object.defineProperty(WeakMap.prototype, "get", original);
		}
		expect(accepted).toBe(false);
		expect(calls).toBe(0);
	});

	it("rejects accessors even if descriptor values are inherited", () => {
		const { port } = fixture();
		let reads = 0;
		const input = {
			port,
			limits: DURABLE_MESSAGING_LIMITS,
			get verify() {
				reads++;
				return () => true;
			},
		};
		let accepted = false;
		try {
			Object.defineProperty(Object.prototype, "value", {
				configurable: true,
				get() {
					reads++;
					return () => true;
				},
			});
			try {
				createDurableMessagingPortMetadataGrant(input);
				accepted = true;
			} catch {}
		} finally {
			Reflect.deleteProperty(Object.prototype, "value");
		}
		expect(accepted).toBe(false);
		expect(reads).toBe(0);
	});

	it("binds accessor-backed metadata to an independently verified port snapshot", async () => {
		const { port } = fixture();
		let reads = 0;
		Object.defineProperty(port, "limits", {
			configurable: true,
			get() {
				reads++;
				throw new Error("untrusted getter");
			},
		});
		const options = {
			authorize: () => true,
			limitsGrant: createDurableMessagingLimitsGrant(),
			lifecycle: createDurableMessagingLifecycle(),
		};
		expect(() => createDurableMessagingWitHost(port, options)).toThrow();
		expect(reads).toBe(0);
		let active = true;
		const input = { ...DURABLE_MESSAGING_LIMITS };
		const grant = createDurableMessagingPortMetadataGrant({
			port,
			limits: input,
			verify: (claim) =>
				active &&
				claim.port === port &&
				Object.isFrozen(claim) &&
				Object.isFrozen(claim.limits) &&
				claim.limits.nameBytes === DURABLE_MESSAGING_LIMITS.nameBytes,
		});
		Object.defineProperty(input, "nameBytes", { value: 1 });
		const host = createDurableMessagingWitHost(port, {
			...options,
			portMetadataGrant: grant,
		});
		expect((await host.limits()).nameBytes).toBe(
			DURABLE_MESSAGING_LIMITS.nameBytes,
		);
		expect(await host.ensureTopic({ operation, topic: "orders" })).toEqual({
			tag: "committed",
			val: { topic: "orders" },
		});
		expect(reads).toBe(0);
		active = false;
		await expect(host.limits()).rejects.toThrow();
		expect(await host.ensureTopic({ operation, topic: "orders" })).toEqual({
			tag: "unknown",
			val: operation,
		});
		active = true;
		grant.revoke();
		await expect(host.limits()).rejects.toThrow();
		expect(await host.ensureTopic({ operation, topic: "orders" })).toEqual({
			tag: "unknown",
			val: operation,
		});
	});

	it("refuses forged or mismatched metadata bindings before running a getter", async () => {
		const { port } = fixture();
		const other = fixture().port;
		const options = {
			authorize: () => true,
			limitsGrant: createDurableMessagingLimitsGrant(),
			lifecycle: createDurableMessagingLifecycle(),
		};
		expect(() =>
			createDurableMessagingPortMetadataGrant({
				port,
				limits: { ...DURABLE_MESSAGING_LIMITS, nameBytes: 1 },
				verify: (claim) =>
					claim.port === port &&
					claim.limits.nameBytes === DURABLE_MESSAGING_LIMITS.nameBytes,
			}),
		).toThrow();
		const grant = createDurableMessagingPortMetadataGrant({
			port,
			limits: DURABLE_MESSAGING_LIMITS,
			verify: (claim) => claim.port === port,
		});
		expect(() =>
			createDurableMessagingWitHost(other, {
				...options,
				portMetadataGrant: grant,
			}),
		).toThrow();
		// SAFETY: the forged object intentionally verifies private capability identity.
		const forged = { revoke() {} } as typeof grant;
		expect(() =>
			createDurableMessagingWitHost(port, {
				...options,
				portMetadataGrant: forged,
			}),
		).toThrow();
		let getters = 0;
		const accessor = Object.defineProperty(
			{ port, limits: DURABLE_MESSAGING_LIMITS },
			"verify",
			{
				enumerable: true,
				get() {
					getters++;
					return () => true;
				},
			},
		);
		// SAFETY: this intentionally malformed object probes the runtime boundary.
		expect(() =>
			createDurableMessagingPortMetadataGrant(
				accessor as Parameters<
					typeof createDurableMessagingPortMetadataGrant
				>[0],
			),
		).toThrow();
		expect(getters).toBe(0);
		// SAFETY: this deliberately async callback probes the JavaScript boundary.
		// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the invalid callback is intentionally passed across the JS boundary.
		const asynchronous = (() =>
			Promise.reject(new Error("async refusal"))) as unknown as Parameters<
			typeof createDurableMessagingPortMetadataGrant
		>[0]["verify"];
		let poisoned = 0;
		Object.defineProperty(Promise.prototype.then, "call", {
			configurable: true,
			value: () => {
				poisoned++;
				throw new Error("poisoned call");
			},
		});
		try {
			expect(() =>
				createDurableMessagingPortMetadataGrant({
					port,
					limits: DURABLE_MESSAGING_LIMITS,
					verify: asynchronous,
				}),
			).toThrow();
		} finally {
			Reflect.deleteProperty(Promise.prototype.then, "call");
		}
		expect(poisoned).toBe(0);
		await Promise.resolve();
	});

	it("never exposes its mutable metadata state as a verifier receiver", async () => {
		const { port } = fixture();
		let receivedUnexpectedReceiver = false;
		const grant = createDurableMessagingPortMetadataGrant({
			port,
			limits: DURABLE_MESSAGING_LIMITS,
			verify: function (this: void) {
				receivedUnexpectedReceiver ||= this !== undefined;
				return true;
			},
		});
		const host = createDurableMessagingWitHost(port, {
			portMetadataGrant: grant,
			limitsGrant: createDurableMessagingLimitsGrant(),
			lifecycle: createDurableMessagingLifecycle(),
			authorize: () => true,
		});
		expect(receivedUnexpectedReceiver).toBe(false);
		grant.revoke();
		await expect(host.limits()).rejects.toThrow();
	});

	it("uses captured intrinsics for provider binding and typed-array copying", async () => {
		const { port } = fixture();
		const options = {
			limitsGrant: createDurableMessagingLimitsGrant(),
			lifecycle: createDurableMessagingLifecycle(),
			authorize: () => true,
		};
		let poisonCalls = 0;
		let host: ReturnType<typeof createDurableMessagingWitHost> | undefined;
		Object.defineProperty(Function.prototype.bind, "call", {
			configurable: true,
			value: () => {
				poisonCalls++;
				return async () => ({
					status: "committed",
					value: { topic: "forged" },
				});
			},
		});
		try {
			host = createDurableMessagingWitHost(port, options);
		} finally {
			Reflect.deleteProperty(Function.prototype.bind, "call");
		}
		if (host === undefined) throw new Error("host was not constructed");
		expect(await host.ensureTopic({ operation, topic: "orders" })).toEqual({
			tag: "committed",
			val: { topic: "orders" },
		});
		expect(poisonCalls).toBe(0);
		const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
		const bufferGetter = Object.getOwnPropertyDescriptor(
			typedArrayPrototype,
			"buffer",
		)?.get;
		const lengthGetter = Object.getOwnPropertyDescriptor(
			typedArrayPrototype,
			"byteLength",
		)?.get;
		if (bufferGetter === undefined || lengthGetter === undefined)
			throw new Error("missing intrinsic getter");
		Object.defineProperty(bufferGetter, "call", {
			configurable: true,
			value: () => {
				poisonCalls++;
				return new ArrayBuffer(1);
			},
		});
		let blocked: ReturnType<typeof host.publish>;
		try {
			blocked = host.publish({
				operation,
				topic: "orders",
				message: {
					...message,
					payload: new Uint8Array(new SharedArrayBuffer(1)),
				},
			});
		} finally {
			Reflect.deleteProperty(bufferGetter, "call");
		}
		expect(await blocked).toEqual({ tag: "unknown", val: operation });
		expect(vi.mocked(port.publish)).not.toHaveBeenCalled();
		Object.defineProperty(Uint8Array.prototype.set, "call", {
			configurable: true,
			value: () => {
				poisonCalls++;
			},
		});
		Object.defineProperty(lengthGetter, "call", {
			configurable: true,
			value: () => {
				poisonCalls++;
				return 100_000;
			},
		});
		let delivered: ReturnType<typeof host.publish>;
		try {
			delivered = host.publish({ operation, topic: "orders", message });
		} finally {
			Reflect.deleteProperty(Uint8Array.prototype.set, "call");
			Reflect.deleteProperty(lengthGetter, "call");
		}
		expect((await delivered).tag).toBe("committed");
		expect(vi.mocked(port.publish).mock.calls[0]?.[0].message.payload).toEqual(
			new Uint8Array([1, 2]),
		);
		expect(poisonCalls).toBe(0);
	});

	it("does not disclose a provider result after metadata is revoked in flight", async () => {
		let started = () => {};
		let release = () => {};
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { port } = fixture({
			ensureTopic: vi.fn<DurableMessaging["ensureTopic"]>(async ({ topic }) => {
				started();
				await pending;
				return { status: "committed", value: { topic } };
			}),
		});
		const grant = createDurableMessagingPortMetadataGrant({
			port,
			limits: DURABLE_MESSAGING_LIMITS,
			verify: (claim) => claim.port === port,
		});
		const host = createDurableMessagingWitHost(port, {
			portMetadataGrant: grant,
			limitsGrant: createDurableMessagingLimitsGrant(),
			lifecycle: createDurableMessagingLifecycle(),
			authorize: () => true,
		});
		const result = host.ensureTopic({ operation, topic: "orders" });
		await entered;
		grant.revoke();
		release();
		expect(await result).toEqual({ tag: "unknown", val: operation });
		await expect(host.limits()).rejects.toThrow();
	});

	it("rechecks permanent revocation performed inside a verifier", async () => {
		const { port } = fixture();
		let trigger = false;
		let grant:
			| ReturnType<typeof createDurableMessagingPortMetadataGrant>
			| undefined;
		grant = createDurableMessagingPortMetadataGrant({
			port,
			limits: DURABLE_MESSAGING_LIMITS,
			verify: () => {
				if (trigger) grant?.revoke();
				return true;
			},
		});
		const host = createDurableMessagingWitHost(port, {
			portMetadataGrant: grant,
			limitsGrant: createDurableMessagingLimitsGrant(),
			lifecycle: createDurableMessagingLifecycle(),
			authorize: () => true,
		});
		trigger = true;
		await expect(host.limits()).rejects.toThrow();
		await expect(host.limits()).rejects.toThrow();
	});

	it("rechecks metadata after the final asynchronous provider continuation", async () => {
		for (const [method, revokeAt] of [
			["mutation", 6],
			["mutation", 7],
			["events", 6],
		] as const) {
			const { port } = fixture();
			let checks = 0;
			let grant:
				| ReturnType<typeof createDurableMessagingPortMetadataGrant>
				| undefined;
			grant = createDurableMessagingPortMetadataGrant({
				port,
				limits: DURABLE_MESSAGING_LIMITS,
				verify: () => {
					checks++;
					if (checks === revokeAt) queueMicrotask(() => grant?.revoke());
					return true;
				},
			});
			const host = createDurableMessagingWitHost(port, {
				portMetadataGrant: grant,
				limitsGrant: createDurableMessagingLimitsGrant(),
				lifecycle: createDurableMessagingLifecycle(),
				authorize: () => true,
			});
			if (method === "mutation")
				expect(await host.ensureTopic({ operation, topic: "orders" })).toEqual({
					tag: "unknown",
					val: operation,
				});
			else
				expect(await host.events({ afterSequence: 0n, limit: 1 })).toEqual({
					tag: "rejected",
					val: "unavailable",
				});
		}
	});
	it("gates native async imports and aliases by independently verified exact component identity", async () => {
		const { host } = fixture();
		vi.stubGlobal("WebAssembly", {});
		try {
			expect(supportsDurableMessagingAsync()).toBe(false);
			const instantiate = vi.fn(
				(_imports: DurableMessagingAsyncImports) => "ready",
			);
			const component = {
				digest: `sha256:${"a".repeat(64)}`,
				imports: [DURABLE_MESSAGING_WIT_INTERFACE],
				instantiate,
			};
			const verify = vi.fn(
				(
					_component: DurableMessagingAsyncComponent<string>,
					candidate: typeof host,
				) => candidate === host,
			);
			await expect(
				instantiateDurableMessagingAsync(host, {
					component,
					verify,
				}),
			).rejects.toThrow("durable_messaging.async_unavailable");
			expect(verify).not.toHaveBeenCalled();
			vi.stubGlobal("WebAssembly", {
				Suspending: function Suspending() {},
				promising: () => {},
			});
			expect(supportsDurableMessagingAsync()).toBe(true);
			for (const imports of [
				[],
				["hobo:durable-messaging/messaging@0.2.0"],
				["hobo:durable-messaging/messaging"],
				[
					DURABLE_MESSAGING_WIT_INTERFACE,
					"hobo:durable-messaging/messaging@0.2.0",
				],
			]) {
				await expect(
					instantiateDurableMessagingAsync(host, {
						component: { ...component, imports },
						verify,
					}),
				).rejects.toThrow("durable_messaging.async_interface_unverified");
			}
			expect(verify).not.toHaveBeenCalled();
			await expect(
				instantiateDurableMessagingAsync(host, {
					component,
					verify: () => false,
				}),
			).rejects.toThrow("durable_messaging.async_component_unverified");
			expect(instantiate).not.toHaveBeenCalled();
			const wrongHost = fixture().host;
			await expect(
				instantiateDurableMessagingAsync(wrongHost, { component, verify }),
			).rejects.toThrow("durable_messaging.async_component_unverified");
			expect(instantiate).not.toHaveBeenCalled();
			await expect(
				instantiateDurableMessagingAsync(host, {
					component,
					verify,
				}),
			).resolves.toEqual({ status: "started", value: "ready" });
			const table = instantiate.mock.calls[0]?.[0];
			expect(table).toBeDefined();
			if (table === undefined) throw new Error("missing verified imports");
			expect(table[DURABLE_MESSAGING_WIT_INTERFACE]).toBe(
				table["hobo:durable-messaging/messaging"],
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("fences late authorization and shared bindings after a timed-out component start", async () => {
		vi.stubGlobal("WebAssembly", {
			Suspending: function Suspending() {},
			promising: () => {},
		});
		let releaseAuth = () => {};
		const auth = new Promise<void>((resolve) => {
			releaseAuth = resolve;
		});
		let releaseFactory = () => {};
		const factoryGate = new Promise<void>((resolve) => {
			releaseFactory = resolve;
		});
		const base = fixture().port;
		const ensureTopic = vi.fn(base.ensureTopic);
		const lifecycle = createDurableMessagingLifecycle({ maxInFlight: 1 });
		const host = createDurableMessagingWitHost(
			{ ...base, ensureTopic },
			{
				lifecycle,
				limitsGrant: createDurableMessagingLimitsGrant(),
				authorize: async () => {
					await auth;
					return true;
				},
			},
		);
		const other = createDurableMessagingWitHost(
			{ ...base, ensureTopic },
			{
				lifecycle,
				limitsGrant: createDurableMessagingLimitsGrant(),
				authorize: () => true,
			},
		);
		const component = {
			digest: `sha256:${"a".repeat(64)}`,
			imports: [DURABLE_MESSAGING_WIT_INTERFACE],
			instantiate: async (imports: DurableMessagingAsyncImports) => {
				void imports[DURABLE_MESSAGING_WIT_INTERFACE].ensureTopic({
					operation,
					topic: "orders",
				});
				await factoryGate;
				return "ready";
			},
		};
		try {
			const pending = instantiateDurableMessagingAsync(host, {
				component,
				verify: () => true,
				timeoutMs: 20,
			});
			await new Promise((resolve) => setTimeout(resolve, 1));
			expect(
				await instantiateDurableMessagingAsync(other, {
					component,
					verify: () => true,
				}),
			).toEqual({ status: "busy" });
			expect(await pending).toEqual({ status: "unknown" });
			releaseAuth();
			releaseFactory();
			await new Promise((resolve) => setTimeout(resolve, 5));
			expect(ensureTopic).not.toHaveBeenCalled();
			expect(await other.ensureTopic({ operation, topic: "orders" })).toEqual({
				tag: "unknown",
				val: operation,
			});
			await expect(other.limits()).rejects.toThrow(
				"durable_messaging.unauthorized",
			);
			expect(
				await instantiateDurableMessagingAsync(other, {
					component,
					verify: () => true,
				}),
			).toEqual({ status: "unknown" });
		} finally {
			releaseAuth();
			releaseFactory();
			vi.unstubAllGlobals();
		}
	});

	it("latches start failure or success while an unawaited provider effect remains in flight", async () => {
		vi.stubGlobal("WebAssembly", {
			Suspending: function Suspending() {},
			promising: () => {},
		});
		try {
			for (const failure of [true, false]) {
				let release = () => {};
				let started = () => {};
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				const dispatched = new Promise<void>((resolve) => {
					started = resolve;
				});
				const base = fixture().port;
				const ensureTopic = vi.fn(async ({ topic }: { topic: string }) => {
					started();
					await gate;
					return { status: "committed" as const, value: { topic } };
				});
				const lifecycle = createDurableMessagingLifecycle({ maxInFlight: 1 });
				const host = createDurableMessagingWitHost(
					{ ...base, ensureTopic },
					{
						lifecycle,
						limitsGrant: createDurableMessagingLimitsGrant(),
						authorize: () => true,
					},
				);
				const other = createDurableMessagingWitHost(
					{ ...base, ensureTopic },
					{
						lifecycle,
						limitsGrant: createDurableMessagingLimitsGrant(),
						authorize: () => true,
					},
				);
				const component = {
					digest: `sha256:${"a".repeat(64)}`,
					imports: [DURABLE_MESSAGING_WIT_INTERFACE],
					instantiate: async (imports: DurableMessagingAsyncImports) => {
						void imports[DURABLE_MESSAGING_WIT_INTERFACE].ensureTopic({
							operation,
							topic: "orders",
						});
						await dispatched;
						if (failure) throw new Error("failed start");
						return "ready";
					},
				};
				expect(
					await instantiateDurableMessagingAsync(host, {
						component,
						verify: () => true,
					}),
				).toEqual({ status: "unknown" });
				expect(await other.ensureTopic({ operation, topic: "orders" })).toEqual(
					{ tag: "unknown", val: operation },
				);
				release();
				await new Promise((resolve) => setTimeout(resolve, 1));
				expect(await other.ensureTopic({ operation, topic: "orders" })).toEqual(
					{ tag: "unknown", val: operation },
				);
				expect(ensureTopic).toHaveBeenCalledTimes(1);
			}
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("does not treat a successful start as reconciliation of an unknown operation", async () => {
		vi.stubGlobal("WebAssembly", {
			Suspending: function Suspending() {},
			promising: () => {},
		});
		try {
			const base = fixture().port;
			let durable = false;
			const ensureTopic = vi.fn(async () => {
				durable = true;
				throw new Error("lost acknowledgement");
			});
			const host = createDurableMessagingWitHost(
				{ ...base, ensureTopic },
				{
					lifecycle: createDurableMessagingLifecycle(),
					limitsGrant: createDurableMessagingLimitsGrant(),
					authorize: () => true,
				},
			);
			let observed: unknown;
			const component = {
				digest: `sha256:${"a".repeat(64)}`,
				imports: [DURABLE_MESSAGING_WIT_INTERFACE],
				instantiate: async (imports: DurableMessagingAsyncImports) => {
					observed = await imports[DURABLE_MESSAGING_WIT_INTERFACE].ensureTopic(
						{ operation, topic: "orders" },
					);
					return "ready";
				},
			};
			expect(
				await instantiateDurableMessagingAsync(host, {
					component,
					verify: () => true,
				}),
			).toEqual({ status: "started", value: "ready" });
			expect(observed).toEqual({ tag: "unknown", val: operation });
			expect(durable).toBe(true);
			expect(ensureTopic).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("translates each async operation, u64, optional value and outcome", async () => {
		const { host, port } = fixture();
		expect(await host.limits()).toMatchObject({
			leaseMs: BigInt(DURABLE_MESSAGING_LIMITS.leaseMs),
			topics: DURABLE_MESSAGING_LIMITS.topics,
		});
		expect(await host.ensureTopic({ operation, topic: "orders" })).toEqual({
			tag: "committed",
			val: { topic: "orders" },
		});
		expect(
			await host.ensureSubscription({ operation, subscription }),
		).toMatchObject({
			tag: "committed",
			val: {
				subscription,
				firstAvailableSequence: 1n,
				historyTruncated: false,
			},
		});
		expect(await host.publish({ operation, topic: "orders", message })).toEqual(
			{ tag: "committed", val: { messageId: message.id, sequence: 1n } },
		);
		expect(
			await host.consume({
				operation,
				topic: "orders",
				consumerGroup: "workers",
				maxMessages: 1,
				visibilityTimeoutMs: 500n,
			}),
		).toMatchObject({
			tag: "committed",
			val: [
				{ sequence: 1n, leaseExpiresAtMs: BigInt(expiresAt + 500), message },
			],
		});
		const receipt = {
			operation,
			topic: "orders",
			consumerGroup: "workers",
			messageId: message.id,
			sequence: 1n,
			leaseId: "lease-1",
		};
		expect(await host.ack(receipt)).toEqual({
			tag: "committed",
			val: { messageId: message.id, sequence: 1n },
		});
		expect(await host.nack({ ...receipt, reason: "retry" })).toEqual({
			tag: "committed",
			val: { tag: "released", val: { messageId: message.id, sequence: 1n } },
		});
		expect(
			await host.compact({ operation, topic: "orders", throughSequence: 1n }),
		).toEqual({
			tag: "committed",
			val: { topic: "orders", firstAvailableSequence: 2n, removedMessages: 1 },
		});
		expect(await host.events({ afterSequence: 0n, limit: 2 })).toEqual({
			tag: "ok",
			val: {
				events: [],
				firstAvailableSequence: 1n,
				nextAfterSequence: 0n,
				hasMore: false,
			},
		});
		expect(port.publish).toHaveBeenCalledWith(
			expect.objectContaining({
				operation: { id: operation.id, expiresAtMs: expiresAt },
			}),
		);
	});

	it("rejects accessors and proxies in host configuration without invoking them", () => {
		let calls = 0;
		const base = fixture().port;
		const config = {
			authorize: () => true,
			limitsGrant: createDurableMessagingLimitsGrant(),
			lifecycle: createDurableMessagingLifecycle(),
			get timeoutMs() {
				calls++;
				return 10;
			},
		};
		expect(() => createDurableMessagingWitHost(base, config)).toThrow();
		const proxy = new Proxy(base, {
			get() {
				calls++;
				throw new Error("trap");
			},
		});
		expect(() =>
			createDurableMessagingWitHost(proxy, {
				authorize: () => true,
				limitsGrant: createDurableMessagingLimitsGrant(),
				lifecycle: createDurableMessagingLifecycle(),
			}),
		).toThrow();
		const getterPort = Object.create(base, {
			limits: {
				get() {
					calls++;
					return DURABLE_MESSAGING_LIMITS;
				},
			},
		});
		expect(() =>
			createDurableMessagingWitHost(getterPort, {
				authorize: () => true,
				limitsGrant: createDurableMessagingLimitsGrant(),
				lifecycle: createDurableMessagingLifecycle(),
			}),
		).toThrow();
		expect(calls).toBe(0);
	});

	it("rejects overflow, malformed names, getters, proxies and sparse arrays before provider effects", async () => {
		const { host, port } = fixture();
		let traps = 0;
		const getter = {
			get topic() {
				traps++;
				return "orders";
			},
			operation,
		};
		const proxy = new Proxy(
			{ topic: "orders", operation },
			{
				ownKeys() {
					traps++;
					throw new Error("trap");
				},
			},
		);
		expect(await host.ensureTopic(getter)).toEqual({
			tag: "unknown",
			val: operation,
		});
		await expect(host.ensureTopic(proxy)).rejects.toThrow();
		await expect(
			host.ensureTopic({
				operation: { ...operation, expiresAtMs: 9_007_199_254_740_992n },
				topic: "orders",
			}),
		).rejects.toThrow();
		await expect(
			host.ensureTopic({ operation, topic: "bad\ud800" }),
		).resolves.toEqual({ tag: "unknown", val: operation });
		const sparse: { key: string; value: string }[] = [];
		sparse.length = 1;
		await expect(
			host.publish({
				operation,
				topic: "orders",
				message: { ...message, attributes: sparse },
			}),
		).resolves.toEqual({ tag: "unknown", val: operation });
		expect(traps).toBe(0);
		expect(port.ensureTopic).not.toHaveBeenCalled();
		expect(port.publish).not.toHaveBeenCalled();
	});

	it("detaches request bytes before awaiting the provider and response bytes before returning", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const captured: number[][] = [];
		const responseBytes = new Uint8Array([3, 4]);
		const { host } = fixture({
			publish: async (input) => {
				await gate;
				captured.push([...input.message.payload]);
				return {
					status: "committed",
					value: { messageId: input.message.id, sequence: 1 },
				};
			},
			consume: async () => ({
				status: "committed",
				value: [
					{ ...delivery, message: { ...message, payload: responseBytes } },
				],
			}),
		});
		const payload = new Uint8Array([1, 2]);
		const pending = host.publish({
			operation,
			topic: "orders",
			message: { ...message, payload },
		});
		payload[0] = 9;
		release();
		await pending;
		expect(captured).toEqual([[1, 2]]);
		const result = await host.consume({
			operation,
			topic: "orders",
			consumerGroup: "workers",
			maxMessages: 1,
			visibilityTimeoutMs: 500n,
		});
		if (result.tag !== "committed") throw new Error("expected delivery");
		responseBytes[0] = 8;
		const first = result.val[0];
		if (first === undefined) throw new Error("missing delivery");
		expect([...first.message.payload]).toEqual([3, 4]);
	});

	it("returns unknown for thrown, malformed or contradictory mutation responses", async () => {
		for (const publish of [
			async () => {
				throw new Error("lost reply");
			},
			async () => ({
				status: "committed",
				value: { messageId: "other", sequence: 1 },
			}),
			async () => ({
				status: "committed",
				value: { messageId: message.id, sequence: Number.MAX_SAFE_INTEGER + 1 },
			}),
			async () => ({
				status: "unknown",
				operation: { id: "other", expiresAtMs: expiresAt },
			}),
		]) {
			const { host } = fixture({
				// SAFETY: these deliberately malformed provider replies exercise the boundary.
				publish: publish as DurableMessaging["publish"],
			});
			expect(
				await host.publish({ operation, topic: "orders", message }),
			).toEqual({ tag: "unknown", val: operation });
		}
	});

	it("reports an unknown outcome after a durable commit loses its reply, then replays the same operation", async () => {
		let committed: { operationId: string; messageId: string } | undefined;
		let attempts = 0;
		const { host } = fixture({
			publish: async ({ operation: op, message: input }) => {
				attempts++;
				if (committed === undefined) {
					committed = { operationId: op.id, messageId: input.id };
					throw new Error("connection lost after durable commit");
				}
				if (committed.operationId !== op.id || committed.messageId !== input.id)
					throw new Error("unexpected retry identity");
				return {
					status: "committed",
					value: { messageId: committed.messageId, sequence: 7 },
				};
			},
		});
		const request = { operation, topic: "orders", message };
		expect(await host.publish(request)).toEqual({
			tag: "unknown",
			val: operation,
		});
		expect(committed).toEqual({
			operationId: operation.id,
			messageId: message.id,
		});
		expect(await host.publish({ ...request, topic: "bad\ud800" })).toEqual({
			tag: "unknown",
			val: operation,
		});
		expect(attempts).toBe(1);
		expect(await host.publish(request)).toEqual({
			tag: "committed",
			val: { messageId: message.id, sequence: 7n },
		});
		expect(attempts).toBe(2);
	});

	it("never leaks hidden fields from unknown and expired provider receipts", async () => {
		let getters = 0;
		const base = { id: operation.id, expiresAtMs: expiresAt };
		const hidden = Object.defineProperty({ ...base }, "secret", {
			value: "private",
			enumerable: false,
		});
		const symbol = Object.assign(
			{ ...base },
			{ [Symbol("secret")]: "private" },
		);
		const accessor = Object.defineProperty({ ...base }, "secret", {
			get() {
				getters++;
				return "private";
			},
			enumerable: true,
		});
		const prototype = Object.assign(Object.create({ secret: "private" }), base);
		for (const returnedOperation of [
			{ ...base, secret: "private" },
			hidden,
			symbol,
			accessor,
			prototype,
		]) {
			for (const status of ["unknown", "expired"] as const) {
				const { host } = fixture({
					publish: async () => ({ status, operation: returnedOperation }),
				});
				const response = await host.publish({
					operation,
					topic: "orders",
					message,
				});
				expect(response).toEqual({ tag: "unknown", val: operation });
				expect(Object.keys(response.val)).toEqual(["id", "expiresAtMs"]);
			}
		}
		expect(getters).toBe(0);
	});

	it("requires whole-instance authorization for event dispatch and disclosure", async () => {
		let allowed = false;
		let getters = 0;
		const secret = Object.defineProperty(
			{
				status: "ok" as const,
				events: [],
				firstAvailableSequence: 1,
				nextAfterSequence: 0,
				hasMore: false,
			},
			"status",
			{
				enumerable: true,
				get() {
					getters++;
					return "ok";
				},
			},
		);
		const events = vi.fn(async () => {
			allowed = false;
			return secret;
		});
		const authorize = vi.fn(
			(request: { scope: string }) => request.scope !== "instance" || allowed,
		);
		const base = fixture().port;
		// SAFETY: the getter-backed audit page deliberately tests denial before disclosure.
		const host = createDurableMessagingWitHost(
			{ ...base, events },
			{
				authorize,
				limitsGrant: createDurableMessagingLimitsGrant(),
				lifecycle: createDurableMessagingLifecycle(),
			},
		);
		expect(await host.events({ afterSequence: 0n, limit: 1 })).toEqual({
			tag: "rejected",
			val: "unavailable",
		});
		expect(events).not.toHaveBeenCalled();
		allowed = true;
		expect(await host.events({ afterSequence: 0n, limit: 1 })).toEqual({
			tag: "rejected",
			val: "unavailable",
		});
		expect(events).toHaveBeenCalledTimes(1);
		expect(getters).toBe(0);
		expect(authorize).toHaveBeenCalledWith({
			phase: "dispatch",
			method: "events",
			scope: "instance",
		});
		expect(authorize).toHaveBeenCalledWith({
			phase: "disclose",
			method: "events",
			scope: "instance",
		});
	});

	it("does not reveal private audit limits before instance authorization", async () => {
		const base = fixture().port;
		let permitted = false;
		const authorize = () => permitted;
		const narrow = createDurableMessagingWitHost(
			{ ...base, limits: { ...base.limits, eventPageSize: 1 } },
			{
				authorize,
				lifecycle: createDurableMessagingLifecycle(),
				limitsGrant: createDurableMessagingLimitsGrant(),
			},
		);
		const wide = createDurableMessagingWitHost(
			{ ...base, limits: { ...base.limits, eventPageSize: 2 } },
			{
				authorize,
				lifecycle: createDurableMessagingLifecycle(),
				limitsGrant: createDurableMessagingLimitsGrant(),
			},
		);
		for (const host of [narrow, wide]) {
			for (const limit of [1, 2])
				expect(await host.events({ afterSequence: 0n, limit })).toEqual({
					tag: "rejected",
					val: "unavailable",
				});
		}
		permitted = true;
		expect(await narrow.events({ afterSequence: 0n, limit: 2 })).toEqual({
			tag: "rejected",
			val: "invalid-argument",
		});
		expect(await wide.events({ afterSequence: 0n, limit: 2 })).toMatchObject({
			tag: "ok",
		});
	});

	it("permanently revokes each limits grant even after a fresh regrant", async () => {
		const port = fixture().port;
		const lifecycle = createDurableMessagingLifecycle();
		const oldGrant = createDurableMessagingLimitsGrant();
		const oldHost = createDurableMessagingWitHost(port, {
			authorize: () => true,
			lifecycle,
			limitsGrant: oldGrant,
		});
		expect((await oldHost.limits()).nameBytes).toBe(
			DURABLE_MESSAGING_LIMITS.nameBytes,
		);
		const pendingLimits = oldHost.limits();
		oldGrant.revoke();
		await expect(pendingLimits).rejects.toThrow(
			"durable_messaging.unauthorized",
		);
		const newHost = createDurableMessagingWitHost(port, {
			authorize: () => true,
			lifecycle,
			limitsGrant: createDurableMessagingLimitsGrant(),
		});
		await expect(oldHost.limits()).rejects.toThrow(
			"durable_messaging.unauthorized",
		);
		expect((await newHost.limits()).nameBytes).toBe(
			DURABLE_MESSAGING_LIMITS.nameBytes,
		);
	});

	it("bounds concurrent asynchronous limits calls", async () => {
		const host = createDurableMessagingWitHost(fixture().port, {
			authorize: () => true,
			lifecycle: createDurableMessagingLifecycle({ maxInFlight: 1 }),
			limitsGrant: createDurableMessagingLimitsGrant(),
		});
		const first = host.limits();
		await expect(host.limits()).rejects.toThrow(
			"durable_messaging.host_capacity",
		);
		await expect(first).resolves.toMatchObject({ nameBytes: 128 });
	});

	it("refuses subscriptions, consume and nack when the dead-letter write is unauthorized", async () => {
		const base = fixture().port;
		const ensureSubscription = vi.fn(base.ensureSubscription);
		const consume = vi.fn(base.consume);
		const nack = vi.fn(base.nack);
		const authorize = vi.fn(
			(request: { scope: string }) =>
				request.scope !== "consumer-group-and-dead-letter",
		);
		const host = createDurableMessagingWitHost(
			{ ...base, ensureSubscription, consume, nack },
			{
				authorize,
				limitsGrant: createDurableMessagingLimitsGrant(),
				lifecycle: createDurableMessagingLifecycle(),
			},
		);
		expect(await host.ensureSubscription({ operation, subscription })).toEqual({
			tag: "unknown",
			val: operation,
		});
		expect(
			await host.consume({
				operation,
				topic: "orders",
				consumerGroup: "workers",
				maxMessages: 1,
				visibilityTimeoutMs: 10n,
			}),
		).toEqual({ tag: "unknown", val: operation });
		expect(
			await host.nack({
				operation,
				topic: "orders",
				consumerGroup: "workers",
				messageId: "message-1",
				sequence: 1n,
				leaseId: "lease-1",
				reason: "retry",
			}),
		).toEqual({ tag: "unknown", val: operation });
		expect(ensureSubscription).not.toHaveBeenCalled();
		expect(consume).not.toHaveBeenCalled();
		expect(nack).not.toHaveBeenCalled();
		expect(authorize).toHaveBeenCalledWith(
			expect.objectContaining({
				method: "consume",
				scope: "consumer-group-and-dead-letter",
				topic: "orders",
				consumerGroup: "workers",
			}),
		);
		expect(authorize).toHaveBeenCalledWith(
			expect.objectContaining({
				method: "nack",
				scope: "consumer-group-and-dead-letter",
				topic: "orders",
				consumerGroup: "workers",
			}),
		);
	});

	it("checks current authorization before dispatch and before disclosing a receipt", async () => {
		let authorized = true;
		let release = () => {};
		let started = () => {};
		let getters = 0;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const cached = Object.defineProperty(
			{ status: "committed" as const, value: [delivery] },
			"status",
			{
				enumerable: true,
				get() {
					getters++;
					return "committed";
				},
			},
		);
		const consume = vi.fn(async () => {
			started();
			await gate;
			return cached;
		});
		const base = fixture().port;
		const authorize = vi.fn(() => authorized);
		// SAFETY: the getter-backed cached response is deliberately malformed and must never be observed after revocation.
		const host = createDurableMessagingWitHost(
			{ ...base, consume },
			{
				authorize,
				limitsGrant: createDurableMessagingLimitsGrant(),
				lifecycle: createDurableMessagingLifecycle(),
			},
		);
		const request = {
			operation,
			topic: "orders",
			consumerGroup: "workers",
			maxMessages: 1,
			visibilityTimeoutMs: 500n,
		};
		const pending = host.consume(request);
		await entered;
		authorized = false;
		release();
		expect(await pending).toEqual({ tag: "unknown", val: operation });
		expect(await host.consume(request)).toEqual({
			tag: "unknown",
			val: operation,
		});
		expect(consume).toHaveBeenCalledTimes(1);
		expect(getters).toBe(0);
		expect(authorize).toHaveBeenCalledWith({
			phase: "dispatch",
			method: "consume",
			scope: "consumer-group-and-dead-letter",
			topic: "orders",
			consumerGroup: "workers",
			operation: { id: operation.id, expiresAtMs: expiresAt },
			maxMessages: 1,
			visibilityTimeoutMs: 500,
		});
		expect(authorize).toHaveBeenCalledWith({
			phase: "disclose",
			method: "consume",
			scope: "consumer-group-and-dead-letter",
			topic: "orders",
			consumerGroup: "workers",
			operation: { id: operation.id, expiresAtMs: expiresAt },
			maxMessages: 1,
			visibilityTimeoutMs: 500,
		});
	});

	it("rejects decorated or shared byte payloads without reading their accessors", async () => {
		const { host, port } = fixture();
		let getters = 0;
		const accessor = Object.defineProperty(new Uint8Array([1]), "secret", {
			get() {
				getters++;
				return 1;
			},
		});
		const symbol = Object.assign(new Uint8Array([1]), {
			[Symbol("secret")]: 1,
		});
		const prototype = Object.setPrototypeOf(
			new Uint8Array([1]),
			Object.create(Uint8Array.prototype),
		);
		const shared = new Uint8Array(new SharedArrayBuffer(1));
		for (const payload of [accessor, symbol, prototype, shared]) {
			await expect(
				host.publish({
					operation,
					topic: "orders",
					message: { ...message, payload },
				}),
			).resolves.toEqual({ tag: "unknown", val: operation });
		}
		expect(getters).toBe(0);
		expect(port.publish).not.toHaveBeenCalled();
	});

	it("preserves terminal rejections and matching expired and unknown envelopes", async () => {
		for (const status of ["unknown", "expired"] as const) {
			const { host } = fixture({
				publish: async ({ operation: op }) => ({ status, operation: op }),
			});
			expect(
				await host.publish({ operation, topic: "orders", message }),
			).toEqual({ tag: status, val: operation });
		}
		const { host } = fixture({
			publish: async () => ({ status: "rejected", code: "operation-conflict" }),
		});
		expect(await host.publish({ operation, topic: "orders", message })).toEqual(
			{ tag: "rejected", val: "operation-conflict" },
		);
	});

	it("does not dispatch provider work after a late authorization", async () => {
		vi.useFakeTimers();
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const base = fixture().port;
		const ensureTopic = vi.fn(base.ensureTopic);
		const host = createDurableMessagingWitHost(
			{ ...base, ensureTopic },
			{
				timeoutMs: 10,
				limitsGrant: createDurableMessagingLimitsGrant(),
				lifecycle: createDurableMessagingLifecycle({ maxInFlight: 1 }),
				authorize: async () => {
					await gate;
					return true;
				},
			},
		);
		try {
			const pending = host.ensureTopic({ operation, topic: "orders" });
			await vi.advanceTimersByTimeAsync(10);
			expect(await pending).toEqual({ tag: "unknown", val: operation });
			release();
			await vi.runAllTimersAsync();
			expect(ensureTopic).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses a monotonic deadline when a synchronous authorizer delays the timer", async () => {
		const base = fixture().port;
		const ensureTopic = vi.fn(base.ensureTopic);
		const host = createDurableMessagingWitHost(
			{ ...base, ensureTopic },
			{
				timeoutMs: 1,
				limitsGrant: createDurableMessagingLimitsGrant(),
				lifecycle: createDurableMessagingLifecycle(),
				authorize: () => {
					const until = performance.now() + 15;
					while (performance.now() < until) {}
					return true;
				},
			},
		);
		expect(await host.ensureTopic({ operation, topic: "orders" })).toEqual({
			tag: "unknown",
			val: operation,
		});
		expect(ensureTopic).not.toHaveBeenCalled();
	});

	it("keeps timed-out work in the bounded in-flight budget until it settles", async () => {
		vi.useFakeTimers();
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const base = fixture();
		const blocked = vi.fn(async ({ topic }: { topic: string }) => {
			await gate;
			return { status: "committed" as const, value: { topic } };
		});
		const host = createDurableMessagingWitHost(
			{ ...base.port, ensureTopic: blocked },
			{
				authorize: () => true,
				limitsGrant: createDurableMessagingLimitsGrant(),
				lifecycle: createDurableMessagingLifecycle({ maxInFlight: 1 }),
				timeoutMs: 10,
			},
		);
		try {
			const pending = host.ensureTopic({ operation, topic: "orders" });
			await vi.advanceTimersByTimeAsync(10);
			expect(await pending).toEqual({ tag: "unknown", val: operation });
			expect(await host.ensureTopic({ operation, topic: "orders" })).toEqual({
				tag: "unknown",
				val: operation,
			});
			expect(blocked).toHaveBeenCalledTimes(1);
			release();
			await vi.runAllTimersAsync();
			expect(await host.ensureTopic({ operation, topic: "orders" })).toEqual({
				tag: "committed",
				val: { topic: "orders" },
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("preserves expired uncertainty even after a timed-out attempt drains", async () => {
		vi.useFakeTimers();
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let attempts = 0;
		const base = fixture();
		const host = createDurableMessagingWitHost(
			{
				...base.port,
				ensureTopic: async ({ operation: op }) => {
					attempts++;
					if (attempts === 1) await gate;
					return { status: "expired", operation: op };
				},
			},
			{
				authorize: () => true,
				limitsGrant: createDurableMessagingLimitsGrant(),
				lifecycle: createDurableMessagingLifecycle({ maxInFlight: 1 }),
				timeoutMs: 10,
			},
		);
		try {
			const request = { operation, topic: "orders" };
			const pending = host.ensureTopic(request);
			await vi.advanceTimersByTimeAsync(10);
			expect(await pending).toEqual({ tag: "unknown", val: operation });
			release();
			await vi.runAllTimersAsync();
			expect(await host.ensureTopic(request)).toEqual({
				tag: "expired",
				val: operation,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("preserves bounded Unicode nack reasons and rejects malformed reasons in both directions", async () => {
		const reason = "first\nsecond\t\u0000";
		let returnedReason = reason;
		const base = fixture().port;
		const nack = vi.fn(base.nack);
		const consume: DurableMessaging["consume"] = async () => ({
			status: "committed",
			value: [
				{
					...delivery,
					topic: "orders-dlq",
					deadLetter: {
						sourceTopic: "orders",
						consumerGroup: "workers",
						originalMessageId: "original",
						originalSequence: 1,
						deliveryAttempt: 1,
						cause: { kind: "nack", reason: returnedReason },
					},
				},
			],
		});
		const { host } = fixture({ nack, consume });
		const request = {
			operation,
			topic: "orders",
			consumerGroup: "workers",
			messageId: message.id,
			sequence: 1n,
			leaseId: "lease-1",
		};
		const read = {
			operation,
			topic: "orders-dlq",
			consumerGroup: "workers",
			maxMessages: 1,
			visibilityTimeoutMs: 10n,
		};
		expect(await host.nack({ ...request, reason })).toMatchObject({
			tag: "committed",
		});
		expect(nack).toHaveBeenCalledWith(expect.objectContaining({ reason }));
		expect(await host.consume(read)).toMatchObject({
			tag: "committed",
			val: [{ deadLetter: { cause: { tag: "nack", val: reason } } }],
		});
		for (const malformed of [
			"\ud800",
			"é".repeat(DURABLE_MESSAGING_LIMITS.reasonBytes),
		]) {
			expect(await host.nack({ ...request, reason: malformed })).toEqual({
				tag: "unknown",
				val: operation,
			});
			returnedReason = malformed;
			expect(await host.consume(read)).toEqual({
				tag: "unknown",
				val: operation,
			});
		}
		expect(nack).toHaveBeenCalledTimes(1);
	});

	it("converts dead-letter provenance and refuses contradictory settlement receipts", async () => {
		const { host } = fixture({
			consume: async () => ({
				status: "committed",
				value: [
					{
						...delivery,
						topic: "orders-dlq",
						deadLetter: {
							sourceTopic: "orders",
							consumerGroup: "workers",
							originalMessageId: "original",
							originalSequence: 42,
							deliveryAttempt: 3,
							cause: { kind: "nack", reason: "invalid" },
						},
					},
				],
			}),
			nack: async ({ messageId, sequence }) => ({
				status: "committed",
				value: {
					disposition: "dead-lettered",
					messageId,
					sequence,
					deadLetterMessageId: "dlq-1",
					deadLetterSequence: 5,
				},
			}),
			ack: async () => ({
				status: "committed",
				value: { messageId: "other", sequence: 1 },
			}),
		});
		expect(
			await host.consume({
				operation,
				topic: "orders-dlq",
				consumerGroup: "workers",
				maxMessages: 1,
				visibilityTimeoutMs: 500n,
			}),
		).toMatchObject({
			tag: "committed",
			val: [
				{
					deadLetter: {
						sourceTopic: "orders",
						originalSequence: 42n,
						cause: { tag: "nack", val: "invalid" },
					},
				},
			],
		});
		const request = {
			operation,
			topic: "orders",
			consumerGroup: "workers",
			messageId: message.id,
			sequence: 1n,
			leaseId: "lease-1",
		};
		expect(await host.nack({ ...request, reason: "invalid" })).toEqual({
			tag: "committed",
			val: {
				tag: "dead-lettered",
				val: {
					messageId: message.id,
					sequence: 1n,
					deadLetterMessageId: "dlq-1",
					deadLetterSequence: 5n,
				},
			},
		});
		expect(await host.ack(request)).toEqual({ tag: "unknown", val: operation });
	});

	it("rejects malformed audit input without invoking the provider", async () => {
		const { host, port } = fixture();
		expect(
			await host.events({ afterSequence: 9_007_199_254_740_992n, limit: 1 }),
		).toEqual({ tag: "rejected", val: "invalid-argument" });
		expect(await host.events({ afterSequence: 0n, limit: 0 })).toEqual({
			tag: "rejected",
			val: "invalid-argument",
		});
		expect(port.events).not.toHaveBeenCalled();
	});

	it("preserves event gaps and verifies contiguous cursors", async () => {
		const { host } = fixture({
			events: async ({ afterSequence }) =>
				afterSequence === 0
					? { status: "gap", firstAvailableSequence: 3, latestSequence: 4 }
					: {
							status: "ok",
							firstAvailableSequence: 3,
							events: [
								{
									sequence: 3,
									kind: "published",
									topic: "orders",
									messageId: message.id,
								},
							],
							nextAfterSequence: 3,
							hasMore: true,
						},
		});
		expect(await host.events({ afterSequence: 0n, limit: 1 })).toEqual({
			tag: "gap",
			val: { firstAvailableSequence: 3n, latestSequence: 4n },
		});
		expect(await host.events({ afterSequence: 2n, limit: 1 })).toMatchObject({
			tag: "ok",
			val: { nextAfterSequence: 3n, events: [{ sequence: 3n }] },
		});
	});

	it("rejects contradictory delivery scope, duplicate leases and malformed event pages", async () => {
		const { host } = fixture({
			consume: async () => ({
				status: "committed",
				value: [{ ...delivery, topic: "other" }],
			}),
			events: async () => ({
				status: "ok",
				events: [],
				firstAvailableSequence: 1,
				nextAfterSequence: 9,
				hasMore: true,
			}),
		});
		expect(
			await host.consume({
				operation,
				topic: "orders",
				consumerGroup: "workers",
				maxMessages: 1,
				visibilityTimeoutMs: 500n,
			}),
		).toEqual({ tag: "unknown", val: operation });
		expect(await host.events({ afterSequence: 0n, limit: 1 })).toEqual({
			tag: "rejected",
			val: "unavailable",
		});
	});
});

describe("provider-neutral topic policy", () => {
	const source = [
		{
			topic: "orders",
			publish: true,
			subscriptions: [
				{ consumerGroup: "workers", deadLetterTopic: "orders-dlq" },
			],
		},
	];

	it("allows only declared operations and verifies the subscription destination in both phases", async () => {
		const verify = vi.fn((_claim: DurableTopicPolicyClaim) => true);
		const policy = createDurableTopicPolicy({ grants: source, verify });
		for (const phase of ["dispatch", "disclose"] as const) {
			expect(
				await policy.authorize({
					phase,
					method: "publish",
					scope: "topic",
					topic: "orders",
				}),
			).toBe(true);
			expect(
				await policy.authorize({
					phase,
					method: "publish",
					scope: "topic",
					topic: "other",
				}),
			).toBe(false);
			expect(
				await policy.authorize({
					phase,
					method: "ensureTopic",
					scope: "topic",
					topic: "orders",
				}),
			).toBe(false);
			expect(
				await policy.authorize({ phase, method: "events", scope: "instance" }),
			).toBe(false);
			expect(
				await policy.authorize({
					phase,
					method: "ensureSubscription",
					scope: "consumer-group-and-dead-letter",
					topic: "orders",
					consumerGroup: "workers",
					deadLetterTopic: "other",
				}),
			).toBe(false);
			expect(
				await policy.authorize({
					phase,
					method: "ensureSubscription",
					scope: "consumer-group-and-dead-letter",
					topic: "orders",
					consumerGroup: "workers",
					deadLetterTopic: "orders-dlq",
				}),
			).toBe(true);
			expect(
				await policy.authorize({
					phase,
					method: "consume",
					scope: "consumer-group-and-dead-letter",
					topic: "orders",
					consumerGroup: "workers",
				}),
			).toBe(true);
			expect(
				await policy.authorize({
					phase,
					method: "ack",
					scope: "consumer-group",
					topic: "orders",
					consumerGroup: "other",
				}),
			).toBe(false);
		}
		expect(verify).toHaveBeenCalledTimes(6);
		expect(verify.mock.calls[2]?.[0]).toMatchObject({
			subscription: { consumerGroup: "workers", deadLetterTopic: "orders-dlq" },
		});
	});

	it("snapshots grants and denies an authority revoked during verification", async () => {
		let release: (value: boolean) => void = () => {};
		const grants = [{ topic: "orders", publish: true, subscriptions: [] }];
		const policy = createDurableTopicPolicy({
			grants,
			verify: () =>
				new Promise<boolean>((resolve) => {
					release = resolve;
				}),
		});
		const initial = grants[0];
		if (initial === undefined) throw new Error("missing grant");
		initial.topic = "changed";
		const pending = policy.authorize({
			phase: "dispatch",
			method: "publish",
			scope: "topic",
			topic: "orders",
		});
		policy.revoke();
		release(true);
		expect(await pending).toBe(false);
		expect(
			await policy.authorize({
				phase: "dispatch",
				method: "publish",
				scope: "topic",
				topic: "changed",
			}),
		).toBe(false);
	});

	it("keeps the original topic and subscription grant after the input changes", async () => {
		const grants = [
			{
				topic: "orders",
				publish: true,
				subscriptions: [{ consumerGroup: "workers", deadLetterTopic: "dlq" }],
			},
		];
		const policy = createDurableTopicPolicy({ grants, verify: () => true });
		const original = grants[0];
		if (original === undefined || original.subscriptions[0] === undefined)
			throw new Error("missing grant");
		original.topic = "other";
		original.subscriptions[0].deadLetterTopic = "changed";
		expect(
			await policy.authorize({
				phase: "dispatch",
				method: "ensureSubscription",
				scope: "consumer-group-and-dead-letter",
				topic: "orders",
				consumerGroup: "workers",
				deadLetterTopic: "dlq",
			}),
		).toBe(true);
		expect(
			await policy.authorize({
				phase: "dispatch",
				method: "publish",
				scope: "topic",
				topic: "other",
			}),
		).toBe(false);
	});

	it("returns an unknown outcome when access is revoked after a provider starts", async () => {
		let finish: (value: {
			status: "committed";
			value: { messageId: string; sequence: number };
		}) => void = () => {};
		let started: () => void = () => {};
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const port = fixture({
			publish: vi.fn<DurableMessaging["publish"]>(
				() =>
					new Promise((resolve) => {
						finish = resolve;
						started();
					}),
			),
		}).port;
		const policy = createDurableTopicPolicy({
			grants: source,
			verify: () => true,
		});
		const host = createDurableMessagingWitHost(port, {
			authorize: policy.authorize,
			limitsGrant: createDurableMessagingLimitsGrant(),
			lifecycle: createDurableMessagingLifecycle(),
		});
		const pending = host.publish({ operation, topic: "orders", message });
		await entered;
		policy.revoke();
		finish({
			status: "committed",
			value: { messageId: message.id, sequence: 1 },
		});
		expect(await pending).toMatchObject({ tag: "unknown" });
		expect(port.publish).toHaveBeenCalledTimes(1);
	});

	it("refuses duplicate and self-referential subscriptions", () => {
		for (const subscriptions of [
			[{ consumerGroup: "workers", deadLetterTopic: "orders" }],
			[
				{ consumerGroup: "workers", deadLetterTopic: "dlq" },
				{ consumerGroup: "workers", deadLetterTopic: "other" },
			],
		])
			expect(() =>
				createDurableTopicPolicy({
					grants: [{ topic: "orders", publish: true, subscriptions }],
					verify: () => true,
				}),
			).toThrow();
	});

	it("denies an ungranted publish before either provider is called", async () => {
		for (const port of [fixture().port, fixture().port]) {
			const policy = createDurableTopicPolicy({
				grants: source,
				verify: () => true,
			});
			const host = createDurableMessagingWitHost(port, {
				authorize: policy.authorize,
				limitsGrant: createDurableMessagingLimitsGrant(),
				lifecycle: createDurableMessagingLifecycle(),
			});
			expect(
				await host.publish({ operation, topic: "other", message }),
			).toMatchObject({ tag: "unknown" });
			expect(port.publish).not.toHaveBeenCalled();
			expect(
				await host.publish({ operation, topic: "orders", message }),
			).toMatchObject({ tag: "committed" });
			expect(port.publish).toHaveBeenCalledTimes(1);
		}
	});
});
