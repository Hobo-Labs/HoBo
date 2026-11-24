import { createSecretKey } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Namespace, Providers } from "@alchemy.run/rivet";
import { Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { StackContext } from "alchemy/StackContext";
import { localState } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vitest";
import { mapBindleToAlchemy } from "../src/bindle.js";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import { inspectAlchemyPlan } from "../src/plan.js";
import { describeRivetPrimitiveSupport } from "../src/rivet.js";
import {
	rivetNamespaceBindleMappers,
	rivetNamespaceResourceId,
} from "../src/rivet-namespace.js";
import {
	routeFixture,
	testOperation,
	testStateOwnership,
} from "./route-fixture.js";

const settings = () => ({
	bindleName: "shop",
	resourceName: "project",
	endpoint: "https://rivet.example",
	namespaceName: "shop-prod",
	token: Redacted.make("test-only-admin-token"),
});

function bindle(dependsOn: string[] = []) {
	return {
		name: "shop",
		resources: {
			project: {
				kind: "project",
				name: "project",
				stableId: "project:project",
				declaredAllow: [],
				dependsOn,
				annotations: [],
			},
		},
		edges: [],
		requirements: {},
		entrypoint: () => undefined,
	};
}

const options = {
	assessRequirements: () => ({ status: "supported" as const }),
};

function namespaceProviders() {
	return Layer.effect(Providers, Provider.collection([Namespace])).pipe(
		Layer.provide(
			Provider.succeed(Namespace, {
				reconcile: ({ news }) =>
					Effect.succeed({
						name: news.name ?? "generated",
						endpoint: news.endpoint,
						createdAt: 0,
					}),
				delete: () => Effect.void,
			}),
		),
	);
}

describe("Rivet namespace project mapping", () => {
	it("reports an infrastructure-only partial mapping", () => {
		const mappers = rivetNamespaceBindleMappers([settings()]);
		expect(
			describeRivetPrimitiveSupport(
				[{ factory: "project", allowVerbs: [] }],
				mappers,
			)[0],
		).toMatchObject({
			kind: "project",
			status: "partial",
			resourceTypes: ["Rivet.Namespace"],
			bindsEntrypoint: false,
			limitations: [
				expect.stringContaining("does not bind"),
				expect.stringContaining("cannot delete"),
			],
		});
	});

	it("requires an exact namespace definition and does not claim dependencies", () => {
		expect(() =>
			mapBindleToAlchemy(bindle(), rivetNamespaceBindleMappers([]), options),
		).toThrow("RIVET_NAMESPACE_CONFIG_REQUIRED");
		const mapper = rivetNamespaceBindleMappers([settings()]).project;
		expect(() =>
			mapper.validate?.({
				bindleName: "shop",
				declaration: bindle(["other"]).resources.project,
				entrypoint: undefined,
				requirements: {},
				dependencyDeclarations: {},
			}),
		).toThrow("RIVET_DEPENDENCY_UNSUPPORTED");
	});

	it("constructs the actual Alchemy namespace and snapshots the token", async () => {
		const config = settings();
		const mappers = rivetNamespaceBindleMappers([config]);
		config.namespaceName = "changed";
		Redacted.wipeUnsafe(config.token);
		const mapped = mapBindleToAlchemy(bindle(), mappers, options);
		const run = () =>
			Effect.runPromise(
				Effect.provide(mapped, namespaceProviders()).pipe(
					Effect.provideService(StackContext, {
						name: "App",
						stage: "test",
						resources: {},
						bindings: {},
						actions: {},
					}),
				),
			);
		const first = await run();
		const project = first.primary.project;
		expect(project).toMatchObject({
			Type: "Rivet.Namespace",
			FQN: rivetNamespaceResourceId("shop", "project"),
			Props: { endpoint: "https://rivet.example/", name: "shop-prod" },
		});
		const token = project?.Props.token;
		if (!Redacted.isRedacted(token)) throw new Error("missing redacted token");
		expect(Redacted.value(token)).toBe("test-only-admin-token");
		expect(JSON.stringify(project?.Props)).not.toContain(
			"test-only-admin-token",
		);
		Redacted.wipeUnsafe(token);
		const second = await run();
		const secondToken = second.primary.project?.Props.token;
		if (!Redacted.isRedacted(secondToken))
			throw new Error("missing redacted token");
		expect(Redacted.value(secondToken)).toBe("test-only-admin-token");
	});

	it("pins the declaration identity before the Alchemy effect runs", async () => {
		const mapper = rivetNamespaceBindleMappers([settings()]).project;
		const input = {
			bindleName: "shop",
			declaration: { ...bindle().resources.project },
			entrypoint: undefined,
			requirements: {},
			dependencyDeclarations: {},
			dependencies: {},
		};
		const effect = mapper.build(input);
		input.bindleName = "different";
		input.declaration.name = "different";
		const result = await Effect.runPromise(
			Effect.provide(effect, namespaceProviders()).pipe(
				Effect.provideService(StackContext, {
					name: "App",
					stage: "test",
					resources: {},
					bindings: {},
					actions: {},
				}),
			),
		);
		expect(result.primary.FQN).toBe(
			rivetNamespaceResourceId("shop", "project"),
		);
	});

	it("rejects malformed, duplicated and unredacted settings", () => {
		for (const definitions of [
			[settings(), settings()],
			[
				settings(),
				{
					...settings(),
					resourceName: "other",
					endpoint: "https://rivet.example/",
				},
			],
			[{ ...settings(), namespaceName: "Not-DNS" }],
			[{ ...settings(), endpoint: "https://user:password@rivet.example" }],
			[{ ...settings(), endpoint: "https://rivet.example/?" }],
			[{ ...settings(), token: "plaintext" }],
			[{ ...settings(), unexpected: true }],
		])
			expect(() =>
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: malformed configuration exercises the public boundary.
				rivetNamespaceBindleMappers(definitions as never),
			).toThrow("RIVET_NAMESPACE_CONFIG_INVALID");
	});

	it("rejects proxies and accessors without invoking them", () => {
		let calls = 0;
		const entry = settings();
		Object.defineProperty(entry, "token", {
			enumerable: true,
			get() {
				calls++;
				return Redacted.make("different");
			},
		});
		expect(() => rivetNamespaceBindleMappers([entry])).toThrow(
			"RIVET_NAMESPACE_CONFIG_INVALID",
		);
		expect(() =>
			rivetNamespaceBindleMappers(
				new Proxy([settings()], {
					get() {
						calls++;
						throw new Error("unexpected access");
					},
				}),
			),
		).toThrow("RIVET_NAMESPACE_CONFIG_INVALID");
		expect(calls).toBe(0);
	});

	it("keeps the original URL readers when checking physical identities", () => {
		const names = ["protocol", "href", "username", "password"] as const;
		const descriptors = names.map((name) =>
			Object.getOwnPropertyDescriptor(URL.prototype, name),
		);
		let substitutions = 0;
		let duplicateRejected = false;
		try {
			for (const name of names)
				Object.defineProperty(URL.prototype, name, {
					configurable: true,
					get() {
						substitutions++;
						return "forged";
					},
				});
			try {
				rivetNamespaceBindleMappers([
					settings(),
					{
						...settings(),
						resourceName: "other",
						endpoint: "https://rivet.example/",
					},
				]);
			} catch (error) {
				duplicateRejected =
					error instanceof Error &&
					error.message.includes("RIVET_NAMESPACE_CONFIG_INVALID");
			}
		} finally {
			for (let index = 0; index < names.length; index++) {
				const name = names[index];
				const descriptor = descriptors[index];
				if (name !== undefined && descriptor !== undefined)
					Object.defineProperty(URL.prototype, name, descriptor);
			}
		}
		expect(duplicateRejected).toBe(true);
		expect(substitutions).toBe(0);
	});
});

function planFixture(
	action: string,
	type = "Rivet.Namespace",
	priorType = type,
) {
	const state =
		action === "create"
			? undefined
			: {
					fqn: "project",
					resourceType: priorType,
					logicalId: "project",
					instanceId: "instance",
					status: "created",
					downstream: [],
					bindings: [],
					props: {},
					attr: {},
				};
	const node = {
		resource: {
			FQN: "project",
			Type: type,
			LogicalId: "project",
			Props: {},
			RemovalPolicy: "destroy",
		},
		action,
		provider: { version: "1", aliases: [priorType] },
		state,
		bindings: [],
		downstream: [],
		props: {},
	};
	const plan = {
		stack: { name: "App", stage: "test" },
		resources: [{ fqn: "project", resourceType: type, action }],
		actions: [],
		native: {
			resources: { project: node },
			deletions: {},
			actions: {},
			actionDeletions: {},
			cycleMembers: new Set<string>(),
			output: {},
			destroy: action === "delete",
		},
	};
	const target = alchemyTarget({
		targetId: "yard",
		tenantId: "tenant",
		stackName: "App",
		stage: "test",
		programResourceId: "app",
		sourceDigest: `sha256:${"a".repeat(64)}`,
		inventoryEvidenceRef: "inventory:1",
		resources: [
			{
				resourceId: "project",
				resourceType: type,
				providerId: "rivet",
				providerAccountRef: "account",
				productId: "namespace",
			},
		],
	});
	const guard = {
		proofRef: "host:proof",
		environmentDigest: `sha256:${"b".repeat(64)}`,
		sourceRequirements: [],
		verifyEnvironment: () => true,
		verifyPlan: () => true,
	};
	return { plan, target, guard, node };
}

describe("retained Rivet namespace lifecycle", () => {
	it.each(["create", "noop"])("permits an authenticated %s plan", (action) => {
		const f = planFixture(action);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture supplies a minimal native plan to the boundary inspector.
		expect(() =>
			inspectAlchemyPlan(f.plan as never, f.target, f.guard),
		).not.toThrow();
	});

	it.each([
		"update",
		"adopted",
		"replace",
		"delete",
		"orphaned",
	])("denies %s before a retained namespace can be forgotten", (action) => {
		const f = planFixture(action);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture supplies a minimal native plan to the boundary inspector.
		expect(() =>
			inspectAlchemyPlan(f.plan as never, f.target, f.guard),
		).toThrow("RIVET_NAMESPACE_LIFECYCLE_UNSUPPORTED");
	});

	it("denies an alias that would change the retained namespace's type", () => {
		const f = planFixture("noop", "Spec.Other", "Rivet.Namespace");
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture supplies a minimal native plan to the boundary inspector.
		expect(() =>
			inspectAlchemyPlan(f.plan as never, f.target, f.guard),
		).toThrow("RIVET_NAMESPACE_LIFECYCLE_UNSUPPORTED");
	});

	it("denies a rename even when the provider calls it a noop", () => {
		const f = planFixture("noop");
		Object.assign(f.node.resource, { FormerFqns: ["old-project"] });
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture supplies a minimal native plan to the boundary inspector.
		expect(() =>
			inspectAlchemyPlan(f.plan as never, f.target, f.guard),
		).toThrow("RIVET_NAMESPACE_LIFECYCLE_UNSUPPORTED");
	});

	it("denies a destroy operation even if the namespace is marked noop", () => {
		const f = planFixture("noop");
		f.plan.native.destroy = true;
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture supplies a minimal native plan to the boundary inspector.
		expect(() =>
			inspectAlchemyPlan(f.plan as never, f.target, f.guard),
		).toThrow("RIVET_NAMESPACE_LIFECYCLE_UNSUPPORTED");
	});

	it("denies retrying a creation with prior state and an unknown outcome", () => {
		const f = planFixture("create");
		Object.assign(f.node, {
			state: {
				fqn: "project",
				resourceType: "Rivet.Namespace",
				logicalId: "project",
				instanceId: "instance",
				status: "creating",
				downstream: [],
				bindings: [],
				props: {},
				attr: {},
			},
		});
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this fixture supplies a minimal native plan to the boundary inspector.
		expect(() =>
			inspectAlchemyPlan(f.plan as never, f.target, f.guard),
		).toThrow("RIVET_NAMESPACE_LIFECYCLE_UNSUPPORTED");
	});

	it("rejects a real destroy plan before admission or provider deletion", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-namespace-"));
		const previousHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "auth");
		let creates = 0;
		let deletes = 0;
		let admissions = 0;
		const resourceId = rivetNamespaceResourceId("shop", "project");
		const registry = Layer.effect(
			Providers,
			Provider.collection([Namespace]),
		).pipe(
			Layer.provide(
				Provider.succeed(Namespace, {
					reconcile: ({ news }) =>
						Effect.sync(() => {
							creates++;
							return {
								name: news.name ?? "generated",
								endpoint: news.endpoint,
								createdAt: 0,
							};
						}),
					delete: () =>
						Effect.sync(() => {
							deletes++;
						}),
				}),
			),
		);
		const stack = Stack(
			"App",
			{ providers: registry, state: localState() },
			mapBindleToAlchemy(
				bindle(),
				rivetNamespaceBindleMappers([settings()]),
				options,
			).pipe(Effect.map(() => ({}))),
		);
		const provider = createAlchemyIacProvider({
			stack,
			stateOwnership: testStateOwnership,
			route: routeFixture().port,
			resolveRoute: ({ requestId }) => ({
				requestId: requestId ?? "logical",
				operation: testOperation,
			}),
			runtimeLayer: Alchemist.layer(),
			runtimeDirectory: directory,
			target: alchemyTarget({
				targetId: "target",
				tenantId: "tenant",
				stackName: "App",
				stage: "test",
				programResourceId: "app",
				sourceDigest: `sha256:${"a".repeat(64)}`,
				inventoryEvidenceRef: "inventory",
				resources: [
					{
						resourceId,
						resourceType: "Rivet.Namespace",
						providerId: "rivet",
						providerAccountRef: "account",
						productId: "namespace",
					},
				],
			}),
			financial: {
				assess: (plan) => ({ plan }),
				admit: async (requestId) => {
					admissions++;
					return {
						requestId,
						targetId: "target",
						status: "admitted",
						code: "",
						message: "",
						budget: { evaluation: "allowed", reservation: "held" },
						reservation: {
							reservationId: `iac:${requestId}`,
							executionDigest: `sha256:${"4".repeat(64)}`,
						},
						requestDigest: `sha256:${"b".repeat(64)}`,
						inventoryHash: `sha256:${"c".repeat(64)}`,
						modelHash: `sha256:${"d".repeat(64)}`,
						quoteHash: `sha256:${"e".repeat(64)}`,
					};
				},
				revalidate: () => true,
				uncertain: () => {},
			},
			composite: {
				proofRef: "host",
				environmentDigest: `sha256:${"b".repeat(64)}`,
				sourceRequirements: [],
				secretFingerprint: {
					key: createSecretKey(Buffer.alloc(32, 23)),
					epoch: "host-key-1",
					proofRef: "host:key",
					verify: () => true,
				},
				verifyEnvironment: () => true,
				verifyPlan: () => true,
			},
		});
		const program = {
			programId: "p",
			deploymentId: "d",
			resourceId: "app",
			provider: "rivet",
			driver: "external",
			action: "apply" as const,
			stackName: "App",
			operationGeneration: "create-1",
		};
		try {
			await provider.preview(program);
			await provider.applyWithAdmission(program, "create");
			expect({ creates, deletes, admissions }).toEqual({
				creates: 1,
				deletes: 0,
				admissions: 1,
			});
			const destroy = {
				...program,
				action: "destroy" as const,
				operationGeneration: "destroy-1",
			};
			await expect(provider.preview(destroy)).rejects.toMatchObject({
				code: "RIVET_NAMESPACE_LIFECYCLE_UNSUPPORTED",
				executionOutcome: "not-started",
			});
			await expect(
				provider.destroyWithAdmission(destroy, "destroy"),
			).rejects.toMatchObject({
				code: "PREVIEW_REQUIRED",
				executionOutcome: "not-started",
			});
			expect({ creates, deletes, admissions }).toEqual({
				creates: 1,
				deletes: 0,
				admissions: 1,
			});
		} finally {
			if (previousHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previousHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
