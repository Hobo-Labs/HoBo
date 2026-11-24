import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { types as utilTypes } from "node:util";
import { DurableObjectResource, Providers } from "@alchemy.run/rivet";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { setup } from "rivetkit";
import { describe, expect, it } from "vitest";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import { describeRivetPrimitiveSupport } from "../src/rivet-catalog.js";
import {
	bindRivetAsyncKvSource,
	createRivetAsyncKvActor,
	isRivetAsyncKvBinding,
	type RivetAsyncKvSource,
	rivetAsyncKvResource,
} from "../src/rivet-kv.js";
import { testStateOwnership } from "./route-fixture.js";

const sourceDigest = `sha256:${"a".repeat(64)}`;
const environmentDigest = `sha256:${"d".repeat(64)}`;

function fixture() {
	const binding = createRivetAsyncKvActor({
		actorName: "store",
		semanticDigest: environmentDigest,
		authorize: () => true,
		verifyIngress: () => true,
	});
	const registry = setup({ use: { store: binding.actor }, noWelcome: true });
	const calls: string[] = [];
	const source: RivetAsyncKvSource = {
		main: "/src/store.ts",
		resourceName: "store",
		bindleName: "store-app",
		sourceDigest,
		sourceFence: {
			sourceDigest,
			environmentDigest,
			proofRef: "host:kv-source",
			verify: () => true,
		},
		poolDigest: `sha256:${"b".repeat(64)}`,
		isolationDigest: `sha256:${"c".repeat(64)}`,
		poolHost: {
			deployExternal: ({ main }) =>
				Effect.sync(() => {
					calls.push(main);
				}),
			deployCrate: () => Effect.void,
		},
		registry,
		binding,
		verifySource: () => true,
	};
	return { source, binding, calls };
}

describe("Alchemy Rivet async KV mapping", () => {
	it("reports the synchronous HoBo KV Bindle as unsupported", () => {
		const [row] = describeRivetPrimitiveSupport(
			[{ factory: "kv", allowVerbs: ["get", "set", "delete"] }],
			{},
		);
		expect(row).toMatchObject({
			status: "unsupported",
			supportedOperations: [],
			unsupportedOperations: ["get", "set", "delete"],
		});
		expect(row?.reason).toContain(
			"does not bind the synchronous HoBo WASI store",
		);
	});

	it("requires the branded exact actor, registry, semantic digest and independent host attestation", () => {
		const { source, binding } = fixture();
		expect(bindRivetAsyncKvSource(source).binding).toBe(binding);
		expect(() =>
			bindRivetAsyncKvSource({ ...source, binding: { ...binding } }),
		).toThrow("RIVET_SOURCE_MISMATCH");
		expect(() =>
			bindRivetAsyncKvSource({ ...source, resourceName: "other" }),
		).toThrow("RIVET_SOURCE_MISMATCH");
		expect(() =>
			bindRivetAsyncKvSource({ ...source, verifySource: () => false }),
		).toThrow("RIVET_SOURCE_UNVERIFIED");
		expect(() =>
			bindRivetAsyncKvSource({
				...source,
				sourceFence: {
					...source.sourceFence,
					environmentDigest: `sha256:${"f".repeat(64)}`,
				},
			}),
		).toThrow("RIVET_SOURCE_MISMATCH");
		const registry = setup({
			use: { store: binding.actor, other: binding.actor },
			noWelcome: true,
		});
		expect(() => bindRivetAsyncKvSource({ ...source, registry })).toThrow(
			"RIVET_SOURCE_MISMATCH",
		);
	});

	it("rejects pool method substitution even when reflection is replaced", () => {
		const { source } = fixture();
		const descriptor = Object.getOwnPropertyDescriptor;
		const original = source.poolHost.deployExternal;
		let traps = 0;
		let rejected = false;
		const altered = {
			...source,
			verifySource: () => {
				Object.defineProperty(source.poolHost, "deployExternal", {
					get() {
						traps++;
						return original;
					},
				});
				Object.getOwnPropertyDescriptor = (target, key) =>
					target === source.poolHost && key === "deployExternal"
						? { value: original, enumerable: true, configurable: true }
						: descriptor(target, key);
				return true;
			},
		};
		try {
			try {
				bindRivetAsyncKvSource(altered);
			} catch {
				rejected = true;
			}
		} finally {
			Object.getOwnPropertyDescriptor = descriptor;
		}
		expect(rejected).toBe(true);
		expect(traps).toBe(0);
	});

	it("retains the actor brand when a source verifier substitutes WeakMap lookup", () => {
		const { source, binding } = fixture();
		const nativeGet = WeakMap.prototype.get;
		const apply = Reflect.apply;
		let intercepted = 0;
		let accepted = false;
		try {
			accepted =
				bindRivetAsyncKvSource({
					...source,
					verifySource: () => {
						WeakMap.prototype.get = function (key) {
							if (key === binding) {
								intercepted++;
								return undefined;
							}
							return apply(nativeGet, this, [key]);
						};
						return true;
					},
				}).binding === binding;
		} finally {
			WeakMap.prototype.get = nativeGet;
		}
		expect(accepted).toBe(true);
		expect(intercepted).toBe(0);
	});

	it("does not accept a forged actor brand from a replaced WeakMap lookup", () => {
		const { binding } = fixture();
		const fake = { ...binding };
		const config = binding.actor.config;
		const forgedRecord = {
			database: "db" in config ? config.db : undefined,
			onRequest: config.onRequest,
			handle: binding.handle,
		};
		const nativeGet = WeakMap.prototype.get;
		const apply = Reflect.apply;
		let intercepted = 0;
		let accepted = false;
		try {
			WeakMap.prototype.get = function (key) {
				if (key === fake) {
					intercepted++;
					return forgedRecord;
				}
				return apply(nativeGet, this, [key]);
			};
			accepted = isRivetAsyncKvBinding(fake);
		} finally {
			WeakMap.prototype.get = nativeGet;
		}
		expect(accepted).toBe(false);
		expect(intercepted).toBe(0);
	});

	it("records a new actor brand despite a replaced WeakMap setter", () => {
		const nativeSet = WeakMap.prototype.set;
		const apply = Reflect.apply;
		let intercepted = 0;
		let binding: ReturnType<typeof createRivetAsyncKvActor> | undefined;
		try {
			WeakMap.prototype.set = function (key, value) {
				if (
					// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: only ordinary object records are inspected by this adversarial test shim.
					typeof value === "object" &&
					value !== null &&
					!utilTypes.isProxy(value) &&
					Object.hasOwn(value, "database") &&
					Object.hasOwn(value, "onRequest") &&
					Object.hasOwn(value, "handle")
				) {
					intercepted++;
					return this;
				}
				return apply(nativeSet, this, [key, value]);
			};
			binding = createRivetAsyncKvActor({
				actorName: "store",
				semanticDigest: environmentDigest,
				verifyIngress: () => true,
				authorize: () => true,
			});
		} finally {
			WeakMap.prototype.set = nativeSet;
		}
		expect(binding && isRivetAsyncKvBinding(binding)).toBe(true);
		expect(intercepted).toBe(0);
	});

	it("rejects proxied or accessor-backed source inputs without invoking traps", () => {
		const { source } = fixture();
		let traps = 0;
		const fail = () => {
			traps++;
			throw new Error("untrusted source");
		};
		const proxiedSource = new Proxy(source, {
			get: fail,
			getPrototypeOf: fail,
			ownKeys: fail,
			getOwnPropertyDescriptor: fail,
		});
		const sourceAccessor = { ...source };
		Object.defineProperty(sourceAccessor, "sourceFence", {
			enumerable: true,
			get: fail,
		});
		const digestAccessor = { ...source };
		Object.defineProperty(digestAccessor, "sourceDigest", {
			enumerable: true,
			get: fail,
		});
		const fenceAccessor = { ...source.sourceFence };
		Object.defineProperty(fenceAccessor, "environmentDigest", {
			enumerable: true,
			get: fail,
		});
		const proxyFence = new Proxy(source.sourceFence, {
			get: fail,
			getPrototypeOf: fail,
			ownKeys: fail,
			getOwnPropertyDescriptor: fail,
		});
		const proxyVerifier = new Proxy(() => true, { apply: fail });
		const proxyRegistry = new Proxy(source.registry, {
			get: fail,
			getPrototypeOf: fail,
			ownKeys: fail,
		});
		for (const input of [
			proxiedSource,
			sourceAccessor,
			digestAccessor,
			{ ...source, sourceFence: fenceAccessor },
			{ ...source, sourceFence: proxyFence },
			{
				...source,
				sourceFence: { ...source.sourceFence, verify: proxyVerifier },
			},
			{ ...source, registry: proxyRegistry },
		])
			expect(() => bindRivetAsyncKvSource(input)).toThrow();
		expect(traps).toBe(0);
	});

	it("rejects inherited descriptor values at the source boundary", () => {
		const { source } = fixture();
		let traps = 0;
		const original = Object.getOwnPropertyDescriptor(Object.prototype, "value");
		const badSource = { ...source };
		Object.defineProperty(badSource, "sourceFence", {
			enumerable: true,
			get: () => {
				traps++;
				return source.sourceFence;
			},
		});
		const badFence = { ...source.sourceFence };
		Object.defineProperty(badFence, "verify", {
			enumerable: true,
			get: () => {
				traps++;
				return () => true;
			},
		});
		let sourceRejected = false;
		let fenceRejected = false;
		Object.defineProperty(Object.prototype, "value", {
			configurable: true,
			get: () => {
				traps++;
				return source.sourceFence;
			},
		});
		try {
			try {
				bindRivetAsyncKvSource(badSource);
			} catch {
				sourceRejected = true;
			}
			try {
				bindRivetAsyncKvSource({ ...source, sourceFence: badFence });
			} catch {
				fenceRejected = true;
			}
		} finally {
			if (original === undefined)
				Reflect.deleteProperty(Object.prototype, "value");
			else Object.defineProperty(Object.prototype, "value", original);
		}
		expect({ sourceRejected, fenceRejected, traps }).toEqual({
			sourceRejected: true,
			fenceRejected: true,
			traps: 0,
		});
	});

	it("rechecks the source and pool fence before resource construction", async () => {
		const { source, calls } = fixture();
		let current = true;
		const resource = rivetAsyncKvResource({
			...source,
			sourceFence: { ...source.sourceFence, verify: () => current },
		});
		current = false;
		await expect(
			Effect.runPromise(
				resource.pipe(
					Effect.provideService(Providers, {
						kind: "ProviderCollection",
						get: () => undefined,
						providers: {},
					}),
				),
			),
		).rejects.toThrow("RIVET_SOURCE_UNVERIFIED");
		expect(calls).toEqual([]);
	});

	it("previews an actual Rivet.DurableObject and exact KV source claim", async () => {
		const f = fixture();
		const providers = Layer.effect(
			Providers,
			Provider.collection([DurableObjectResource]),
		).pipe(
			Layer.provide(
				Provider.succeed(DurableObjectResource, {
					reconcile: () =>
						Effect.succeed({
							name: "store",
							pool: "pool",
							endpoint: "https://rivet.test",
							namespace: "test",
							token: undefined,
						}),
					delete: () => Effect.void,
				}),
			),
		);
		const stack = Stack(
			"Kv",
			{ providers, state: inMemoryState() },
			rivetAsyncKvResource(f.source).pipe(Effect.map(() => ({}))),
		);
		const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-kv-alchemy-"));
		const previous = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		const observed: unknown[] = [];
		try {
			const provider = createAlchemyIacProvider({
				stateOwnership: testStateOwnership,
				stack,
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: directory,
				composite: {
					proofRef: "host:kv-source",
					environmentDigest,
					sourceRequirements: [
						{
							resourceId: "store",
							resourceType: "Rivet.DurableObject",
							bindleName: "store-app",
							applicationName: "store",
							sourceKind: "rivet-async-kv",
							sourcePath: f.source.main,
						},
					],
					verifyEnvironment: () => true,
					verifyPlan: ({ sourceClaims }) => {
						observed.push(...sourceClaims);
						return (
							sourceClaims.length === 1 &&
							sourceClaims[0]?.sourcePath === f.source.main &&
							sourceClaims[0]?.sourceKind === "rivet-async-kv"
						);
					},
				},
				target: alchemyTarget({
					targetId: "yard",
					tenantId: "tenant",
					stackName: "Kv",
					stage: "test",
					programResourceId: "kv",
					sourceDigest,
					inventoryEvidenceRef: "inventory:1",
					resources: [
						{
							resourceId: "store",
							resourceType: "Rivet.DurableObject",
							providerId: "rivet",
							providerAccountRef: "account",
							productId: "actor",
						},
					],
				}),
				financial: {
					assess: (inventory) => ({ inventory }),
					admit: async () => {
						throw new Error("unexpected admission");
					},
					revalidate: () => true,
					uncertain: () => {},
				},
			});
			const result = await provider.preview({
				programId: "kv",
				deploymentId: "d",
				resourceId: "kv",
				provider: "rivet",
				driver: "external",
				action: "apply",
				stackName: "Kv",
			});
			expect(result.changes).toBe(1);
			expect(f.calls).toEqual([f.source.main]);
			expect(observed).toContainEqual(
				expect.objectContaining({
					resourceId: "store",
					resourceType: "Rivet.DurableObject",
					sourceKind: "rivet-async-kv",
					sourcePath: f.source.main,
					sourceDigest,
				}),
			);
		} finally {
			if (previous === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
