import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableObjectResource, Providers } from "@alchemy.run/rivet";
import type { PoolHost } from "@alchemy.run/rivet/Host";
import { inMemoryState, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Registry, setup } from "rivetkit";
import { describe, expect, it, vi } from "vitest";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import { bindRivetHttpSource } from "../src/rivet.js";
import { createRivetMultiPoolPrimitiveMappers } from "../src/rivet-multi.js";
import { createRivetHttpActor } from "../src/rivet-runtime.js";
import { testStateOwnership } from "./route-fixture.js";

function app(name: string, kind: "web" | "api", digest: string) {
	const entrypoint = () => () => new Response(name);
	const binding = createRivetHttpActor({
		actorName: name,
		entrypoint,
		authorize: () => true,
	});
	const registry = setup({ use: { [name]: binding.actor }, noWelcome: true });
	const source = bindRivetHttpSource({
		main: `/src/${name}.ts`,
		resourceName: name,
		kind,
		actorName: name,
		sourceDigest: `sha256:${"a".repeat(64)}`,
		sourceFence: {
			sourceDigest: `sha256:${"a".repeat(64)}`,
			environmentDigest: `sha256:${"b".repeat(64)}`,
			proofRef: "host:immutable-source",
			verify: () => true,
		},
		registry,
		binding,
		verifySource: () => true,
	});
	const deploys: string[] = [];
	const poolHost: PoolHost["Service"] = {
		deployExternal: ({ id, main }) =>
			Effect.sync(() => {
				deploys.push(`${id}:${main}`);
			}),
		deployCrate: () => Effect.void,
	};
	return {
		source,
		poolDigest: `sha256:${digest.repeat(64)}`,
		isolationDigest: `sha256:${digest.repeat(64)}`,
		poolHost,
		deploys,
		input: {
			declaration: {
				name,
				kind,
				stableId: `${kind}:${name}`,
				declaredAllow: [],
				dependsOn: [],
				annotations: [],
			},
			entrypoint,
			requirements: {},
			bindleName: "app",
			dependencyDeclarations: {},
			dependencies: {},
		},
	};
}

describe("Rivet multiple pool mapping", () => {
	/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply -- SAFETY: these regressions substitute collection intrinsics and delegate unrelated calls to the originals. */
	it.each([
		["pool", "has"],
		["isolation", "add"],
		["host", "has"],
		["name", "add"],
		["actor", "some"],
		["pool", "iterator"],
	] as const)("rejects a %s conflict when a source verifier replaces %s", (conflict, method) => {
		const web = app("web", "web", "1");
		const api = app("api", "api", "2");
		const nativeHas = Set.prototype.has;
		const nativeAdd = Set.prototype.add;
		const nativeSome = Array.prototype.some;
		const nativeIterator = Array.prototype[Symbol.iterator];
		if (conflict === "pool") api.poolDigest = web.poolDigest;
		if (conflict === "isolation") api.isolationDigest = web.isolationDigest;
		if (conflict === "host") api.poolHost = web.poolHost;
		if (conflict === "name") api.source = web.source;
		if (conflict === "actor")
			Reflect.set(
				api.source.registry.config.use,
				"web",
				web.source.binding.actor,
			);
		const first = {
			...web,
			source: {
				...web.source,
				verifySource: () => {
					if (method === "has") Reflect.set(Set.prototype, "has", () => false);
					if (method === "add")
						Reflect.set(Set.prototype, "add", function (this: Set<unknown>) {
							return this;
						});
					if (method === "some")
						Reflect.set(
							Array.prototype,
							"some",
							function (this: unknown[], predicate: unknown) {
								if (this[0] === "api") return false;
								return Reflect.apply(nativeSome, this, [predicate]);
							},
						);
					if (method === "iterator")
						Reflect.set(
							Array.prototype,
							Symbol.iterator,
							function (this: { attestation?: unknown }[]) {
								if (
									this.length === 2 &&
									this[0]?.attestation &&
									this[1]?.attestation
								)
									return Reflect.apply(nativeIterator, [this[0]], []);
								return Reflect.apply(nativeIterator, this, []);
							},
						);
					return true;
				},
			},
		};
		let rejected = false;
		try {
			try {
				createRivetMultiPoolPrimitiveMappers([first, api], () => true);
			} catch {
				rejected = true;
			}
		} finally {
			Reflect.set(Set.prototype, "has", nativeHas);
			Reflect.set(Set.prototype, "add", nativeAdd);
			Reflect.set(Array.prototype, "some", nativeSome);
			Reflect.set(Array.prototype, Symbol.iterator, nativeIterator);
		}
		expect(rejected).toBe(true);
		expect(web.deploys).toEqual([]);
		expect(api.deploys).toEqual([]);
	});
	it("selects the exact source after a verifier replaces Array.find", () => {
		const web = app("web", "web", "1");
		const api = app("api", "api", "2");
		const nativeFind = Array.prototype.find;
		let redirected = 0;
		let succeeded = false;
		const first = {
			...web,
			source: {
				...web.source,
				verifySource: () => {
					Reflect.set(
						Array.prototype,
						"find",
						function (this: { attestation?: unknown }[], predicate: unknown) {
							if (this[0]?.attestation) {
								redirected++;
								return undefined;
							}
							return Reflect.apply(nativeFind, this, [predicate]);
						},
					);
					return true;
				},
			},
		};
		try {
			const mappers = createRivetMultiPoolPrimitiveMappers(
				[first, api],
				() => true,
			);
			mappers.web.validate(web.input);
			succeeded = true;
		} finally {
			Reflect.set(Array.prototype, "find", nativeFind);
		}
		expect(succeeded).toBe(true);
		expect(redirected).toBe(0);
		expect(web.deploys).toEqual([]);
		expect(api.deploys).toEqual([]);
	});

	/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply */
	it("preserves dense pool entries across an inherited numeric setter", () => {
		const web = app("web", "web", "1");
		const api = app("api", "api", "2");
		const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
		let calls = 0;
		let installed = false;
		const restore = () => {
			if (previous) Object.defineProperty(Array.prototype, "0", previous);
			else Reflect.deleteProperty(Array.prototype, "0");
		};
		const first = {
			...web,
			source: {
				...web.source,
				verifySource: () => {
					if (!installed) {
						installed = true;
						Object.defineProperty(Array.prototype, "0", {
							configurable: true,
							set() {
								calls++;
							},
						});
					}
					return true;
				},
			},
		};
		const second = {
			...api,
			source: {
				...api.source,
				verifySource: () => {
					restore();
					return true;
				},
			},
		};
		let succeeded = false;
		try {
			const mappers = createRivetMultiPoolPrimitiveMappers(
				[first, second],
				() => true,
			);
			mappers.web.validate(web.input);
			mappers.api.validate(api.input);
			succeeded = true;
		} finally {
			restore();
		}
		expect(succeeded).toBe(true);
		expect(calls).toBe(0);
	});

	it("rejects and observes accidentally asynchronous source and pool verifiers", async () => {
		const web = app("web", "web", "1");
		const source = { ...web.source };
		Reflect.set(source, "verifySource", () =>
			Promise.reject(new Error("offline")),
		);
		expect(() => bindRivetHttpSource(source)).toThrow(
			"RIVET_SOURCE_UNVERIFIED",
		);
		const pool = () => Promise.reject(new Error("offline"));
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this intentionally passes an accidental asynchronous verifier.
		expect(() =>
			createRivetMultiPoolPrimitiveMappers([web], pool as never),
		).toThrow("RIVET_POOL_UNVERIFIED");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(web.deploys).toEqual([]);
	});

	it("retains source freezing and dependency checks after the globals change", () => {
		const web = app("web", "web", "1");
		const mapper = createRivetMultiPoolPrimitiveMappers([web], () => true).web;
		const dependencies = { unexpected: web.input.declaration };
		const keys = Object.keys;
		const freeze = Object.freeze;
		let source: typeof web.source | undefined;
		let rejected = false;
		try {
			Reflect.set(Object, "keys", (value: typeof dependencies) =>
				value === dependencies ? [] : keys(value),
			);
			Reflect.set(Object, "freeze", (value: typeof web.source) => value);
			source = bindRivetHttpSource(web.source);
			try {
				mapper.validate({ ...web.input, dependencyDeclarations: dependencies });
			} catch {
				rejected = true;
			}
		} finally {
			Object.keys = keys;
			Object.freeze = freeze;
		}
		expect(source).toBeDefined();
		expect(Object.isFrozen(source)).toBe(true);
		expect(rejected).toBe(true);
		expect(web.deploys).toEqual([]);
	});

	it("does not let a verifier hide a newly registered actor by replacing ownKeys", () => {
		const web = app("web", "web", "1");
		const api = app("api", "api", "2");
		const ownKeys = Reflect.ownKeys;
		const registry = web.source.registry.config.use;
		let rejected = false;
		try {
			try {
				createRivetMultiPoolPrimitiveMappers([web, api], () => {
					Object.assign(registry, { api: api.source.binding.actor });
					Reflect.ownKeys = (value) =>
						value === registry ? ["web"] : ownKeys(value);
					return true;
				});
			} catch {
				rejected = true;
			}
		} finally {
			Reflect.ownKeys = ownKeys;
		}
		expect(rejected).toBe(true);
		expect(web.deploys).toEqual([]);
	});

	it("uses the captured descriptor reader after the host verifies the pool", () => {
		const web = app("web", "web", "1");
		const descriptor = Object.getOwnPropertyDescriptor;
		const original = web.poolHost.deployExternal;
		let traps = 0;
		let rejected = false;
		try {
			try {
				createRivetMultiPoolPrimitiveMappers([web], () => {
					Object.defineProperty(web.poolHost, "deployExternal", {
						get() {
							traps++;
							return original;
						},
					});
					Object.getOwnPropertyDescriptor = (target, key) =>
						target === web.poolHost && key === "deployExternal"
							? { value: original, enumerable: true, configurable: true }
							: descriptor(target, key);
					return true;
				});
			} catch {
				rejected = true;
			}
		} finally {
			Object.getOwnPropertyDescriptor = descriptor;
		}
		expect(rejected).toBe(true);
		expect(traps).toBe(0);
	});

	it("plans distinct Alchemy DurableObjects through their independently attested pool hosts", async () => {
		const web = app("web", "web", "1");
		const api = app("api", "api", "2");
		let callAccesses = 0;
		Object.defineProperty(web.poolHost.deployExternal, "call", {
			get() {
				callAccesses++;
				throw new Error("untrusted function property");
			},
		});
		const verifyPool = vi.fn(() => true);
		const mappers = createRivetMultiPoolPrimitiveMappers(
			[web, api],
			verifyPool,
		);
		const program = Effect.gen(function* () {
			yield* mappers.web.build(web.input);
			yield* mappers.api.build(api.input);
			return {};
		});
		const registry = Layer.effect(
			Providers,
			Provider.collection([DurableObjectResource]),
		).pipe(
			Layer.provide(
				Provider.succeed(DurableObjectResource, {
					reconcile: () =>
						Effect.succeed({
							name: "object",
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
			"App",
			{ providers: registry, state: inMemoryState() },
			program,
		);
		const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-multi-"));
		const previousHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		let restoreApply = () => {};
		try {
			const provider = createAlchemyIacProvider({
				stateOwnership: testStateOwnership,
				stack,
				runtimeLayer: Alchemist.layer(),
				runtimeDirectory: directory,
				composite: {
					proofRef: "host:immutable-source",
					environmentDigest: `sha256:${"b".repeat(64)}`,
					sourceRequirements: [web, api].map(({ source }) => ({
						resourceId: source.resourceName,
						resourceType: "Rivet.DurableObject",
						bindleName: "app",
						applicationName: source.resourceName,
						sourceKind: "rivet-http",
						sourcePath: source.main,
					})),
					verifyEnvironment: () => true,
					verifyPlan: ({ sourceClaims }) => sourceClaims.length === 2,
				},
				target: alchemyTarget({
					targetId: "yard",
					tenantId: "tenant",
					stackName: "App",
					stage: "test",
					programResourceId: "app",
					sourceDigest: web.source.sourceDigest,
					inventoryEvidenceRef: "inventory:1",
					resources: ["web", "api"].map((resourceId) => ({
						resourceId,
						resourceType: "Rivet.DurableObject",
						providerId: "rivet",
						providerAccountRef: "account",
						productId: "actor",
					})),
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
			const originalApply = Reflect.apply;
			const getter = Object.getOwnPropertyDescriptor(
				Registry.prototype,
				"config",
			)?.get;
			let redirected = 0;
			const spy = vi
				.spyOn(Reflect, "apply")
				.mockImplementation((target, receiver, args) => {
					if (target === web.poolHost.deployExternal || target === getter) {
						redirected++;
						throw new Error("replaced global apply");
					}
					return originalApply(target, receiver, args);
				});
			restoreApply = () => spy.mockRestore();
			const result = await provider.preview({
				programId: "app",
				deploymentId: "d",
				resourceId: "app",
				provider: "rivet",
				driver: "external",
				action: "apply",
				stackName: "App",
			});
			expect(result.changes).toBe(2);
			expect(web.deploys).toEqual(["web:/src/web.ts"]);
			expect(callAccesses).toBe(0);
			expect(redirected).toBe(0);
			expect(api.deploys).toEqual(["api:/src/api.ts"]);
			expect(verifyPool).toHaveBeenCalled();
		} finally {
			restoreApply();
			if (previousHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previousHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects shared pool identities, shared host services, duplicate apps, and absent attestation", () => {
		const web = app("web", "web", "1");
		const api = app("api", "api", "2");
		const verify = () => true;
		expect(() =>
			createRivetMultiPoolPrimitiveMappers(
				[web, { ...api, poolDigest: web.poolDigest }],
				verify,
			),
		).toThrow("RIVET_POOL_CONFLICT");
		expect(() =>
			createRivetMultiPoolPrimitiveMappers(
				[web, { ...api, poolHost: web.poolHost }],
				verify,
			),
		).toThrow("RIVET_POOL_CONFLICT");
		expect(() =>
			createRivetMultiPoolPrimitiveMappers(
				[web, { ...api, source: web.source }],
				verify,
			),
		).toThrow("RIVET_POOL_CONFLICT");
		expect(() =>
			createRivetMultiPoolPrimitiveMappers([web, api], () => false),
		).toThrow("RIVET_POOL_UNVERIFIED");
		expect(() =>
			createRivetMultiPoolPrimitiveMappers([web, api], () => {
				throw new Error("offline");
			}),
		).toThrow("RIVET_POOL_UNVERIFIED");
	});

	it("rechecks the host's exclusive-pool attestation before any build", () => {
		const web = app("web", "web", "1");
		const api = app("api", "api", "2");
		let authorized = true;
		const mappers = createRivetMultiPoolPrimitiveMappers(
			[web, api],
			() => authorized,
		);
		authorized = false;
		expect(() => mappers.web.validate(web.input)).toThrow(
			"RIVET_POOL_UNVERIFIED",
		);
		expect(web.deploys).toEqual([]);
		expect(api.deploys).toEqual([]);
	});

	it("rejects a volatile pool identity without invoking its accessor", () => {
		const web = app("web", "web", "1");
		let reads = 0;
		const source = {
			...web,
			get poolDigest() {
				return ++reads === 1 ? web.poolDigest : "changed-after-validation";
			},
		};
		let verified = false;
		expect(() =>
			createRivetMultiPoolPrimitiveMappers([source], () => {
				verified = true;
				return true;
			}),
		).toThrow("RIVET_POOL_UNVERIFIED");
		expect(reads).toBe(0);
		expect(verified).toBe(false);
	});

	it.each([
		"poolDigest",
		"isolationDigest",
	] as const)("rejects a non-string %s even if it coerces to a valid digest", (field) => {
		const web = app("web", "web", "1");
		const source = { ...web };
		Reflect.set(source, field, { toString: () => web[field] });
		expect(() =>
			createRivetMultiPoolPrimitiveMappers([source], () => true),
		).toThrow("RIVET_POOL_UNVERIFIED");
	});

	it("rejects different pools that share one runner isolation domain", () => {
		const web = app("web", "web", "1");
		const api = app("api", "api", "2");
		expect(() =>
			createRivetMultiPoolPrimitiveMappers(
				[web, { ...api, isolationDigest: web.isolationDigest }],
				() => true,
			),
		).toThrow("RIVET_POOL_CONFLICT");
	});

	it("rejects overlapping actor registries and changes to attested hosts", () => {
		const web = app("web", "web", "1");
		const api = app("api", "api", "2");
		const mappers = createRivetMultiPoolPrimitiveMappers(
			[web, api],
			() => true,
		);
		Object.assign(api.source.registry.config.use, {
			web: web.source.binding.actor,
		});
		expect(() => mappers.web.validate(web.input)).toThrow(
			"RIVET_POOL_CONFLICT",
		);
		Reflect.deleteProperty(api.source.registry.config.use, "web");
		Object.assign(web.poolHost, { deployExternal: () => Effect.void });
		expect(() => mappers.web.validate(web.input)).toThrow(
			"RIVET_POOL_UNVERIFIED",
		);
	});

	it("requires all application sources to share the reviewed target digest", () => {
		const web = app("web", "web", "1");
		const api = app("api", "api", "2");
		expect(() =>
			createRivetMultiPoolPrimitiveMappers(
				[
					web,
					{
						...api,
						source: {
							...api.source,
							sourceDigest: `sha256:${"c".repeat(64)}`,
							sourceFence: {
								...api.source.sourceFence,
								sourceDigest: `sha256:${"c".repeat(64)}`,
							},
						},
					},
				],
				() => true,
			),
		).toThrow("RIVET_SOURCE_MISMATCH");
	});
});
