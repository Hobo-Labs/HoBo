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
import { setup } from "rivetkit";
import { describe, expect, it, vi } from "vitest";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import { bindRivetHttpSource } from "../src/rivet.js";
import { createRivetMultiPoolPrimitiveMappers } from "../src/rivet-multi.js";
import { createRivetHttpActor } from "../src/rivet-runtime.js";

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
	it("plans distinct Alchemy DurableObjects through their independently attested pool hosts", async () => {
		const web = app("web", "web", "1");
		const api = app("api", "api", "2");
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
		try {
			const provider = createAlchemyIacProvider({
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
			expect(api.deploys).toEqual(["api:/src/api.ts"]);
			expect(verifyPool).toHaveBeenCalled();
		} finally {
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

	it("pins each pool identity once before validation and host attestation", () => {
		const web = app("web", "web", "1");
		let reads = 0;
		const source = {
			...web,
			get poolDigest() {
				return ++reads === 1 ? web.poolDigest : "changed-after-validation";
			},
		};
		let observed = "";
		createRivetMultiPoolPrimitiveMappers([source], (claim) => {
			observed = claim.poolDigest;
			return true;
		});
		expect(reads).toBe(1);
		expect(observed).toBe(web.poolDigest);
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
