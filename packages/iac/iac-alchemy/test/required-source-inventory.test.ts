import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inMemoryState, Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import {
	type AlchemyCompositeObservation,
	alchemyTarget,
	createAlchemyIacProvider,
	type FinancialPlan,
} from "../src/index.js";
import { registerAlchemySource } from "../src/source-fence.js";
import { testStateOwnership } from "./route-fixture.js";

type Component = Resource<"Demo.Executable", { main: string }, { id: string }>;
const Component = Resource<Component>("Demo.Executable");

function fixture(directory: string) {
	let declarations = 0;
	let effects = 0;
	const stack = Stack(
		"App",
		{
			providers: Provider.succeed(Component, {
				reconcile: () =>
					Effect.sync(() => {
						effects++;
						return { id: "component" };
					}),
				delete: () => Effect.void,
			}),
			state: inMemoryState(),
		},
		Effect.gen(function* () {
			declarations++;
			yield* Component("component", { main: "/src/app.ts" });
			return {};
		}),
	);
	const verifyEnvironment = vi.fn(() => true);
	const verifyPlan = vi.fn((_observation: AlchemyCompositeObservation) => true);
	const composite = {
		proofRef: "host:source-inventory",
		environmentDigest: `sha256:${"b".repeat(64)}`,
		sourceRequirements: [],
		verifyEnvironment,
		verifyPlan,
	};
	const options = {
		stack,
		stateOwnership: testStateOwnership,
		runtimeLayer: Alchemist.layer(),
		runtimeDirectory: directory,
		composite,
		target: alchemyTarget({
			targetId: "yard",
			tenantId: "tenant",
			stackName: "App",
			stage: "test",
			programResourceId: "app",
			sourceDigest: `sha256:${"a".repeat(64)}`,
			inventoryEvidenceRef: "inventory:1",
			resources: [
				{
					resourceId: "component",
					resourceType: "Demo.Executable",
					providerId: "test",
					providerAccountRef: "account",
					productId: "test",
				},
			],
		}),
		financial: {
			assess: (inventory: FinancialPlan) => ({ inventory }),
			admit: async () => {
				throw new Error("unexpected admission");
			},
			revalidate: () => false,
			uncertain: () => {},
		},
	};
	const program = {
		programId: "p",
		deploymentId: "d",
		resourceId: "app",
		provider: "test",
		driver: "external",
		action: "apply" as const,
		stackName: "App",
	};
	return {
		options,
		composite,
		program,
		declarations: () => declarations,
		effects: () => effects,
		verifyEnvironment,
		verifyPlan,
	};
}

describe("complete host source classification", () => {
	/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply -- SAFETY: this regression substitutes collection methods and delegates unrelated calls to captured intrinsics. */
	it("rejects a different registered resource when the required source is missing", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-source-mismatch-"));
		const previousHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		const nativeFind = Array.prototype.find;
		const nativeSome = Array.prototype.some;
		let effects = 0;
		const first = {
			resourceId: "component",
			resourceType: "Demo.Executable",
			bindleName: "app",
			applicationName: "component",
			sourceKind: "module",
			sourcePath: "/src/component.ts",
		};
		const second = {
			...first,
			resourceId: "other",
			applicationName: "other",
			sourcePath: "/src/other.ts",
		};
		const stack = Stack(
			"App",
			{
				providers: Provider.succeed(Component, {
					reconcile: () =>
						Effect.sync(() => {
							effects++;
							return { id: "component" };
						}),
					delete: () => Effect.void,
				}),
				state: inMemoryState(),
			},
			Effect.gen(function* () {
				yield* Component("component", { main: first.sourcePath });
				const other = yield* Component("other", { main: second.sourcePath });
				registerAlchemySource(other, {
					claim: {
						...second,
						sourceDigest: `sha256:${"a".repeat(64)}`,
						environmentDigest: `sha256:${"b".repeat(64)}`,
						proofRef: "host:source-inventory",
					},
					verify: () => true,
				});
				return {};
			}),
		);
		let failure: unknown;
		try {
			const f = fixture(directory);
			const provider = createAlchemyIacProvider({
				...f.options,
				stack,
				target: alchemyTarget({
					targetId: "yard",
					tenantId: "tenant",
					stackName: "App",
					stage: "test",
					programResourceId: "app",
					sourceDigest: `sha256:${"a".repeat(64)}`,
					inventoryEvidenceRef: "inventory:1",
					resources: [first, second].map(({ resourceId, resourceType }) => ({
						resourceId,
						resourceType,
						providerId: "test",
						providerAccountRef: "account",
						productId: "test",
					})),
				}),
				composite: {
					...f.composite,
					sourceRequirements: [first],
					verifyEnvironment: ({ sourceRequirements }) => {
						Reflect.set(Array.prototype, "find", function (predicate: unknown) {
							if (this === sourceRequirements) return undefined;
							return Reflect.apply(nativeFind, this, [predicate]);
						});
						Reflect.set(Array.prototype, "some", function (predicate: unknown) {
							if (this === sourceRequirements) return false;
							return Reflect.apply(nativeSome, this, [predicate]);
						});
						return true;
					},
				},
			});
			try {
				await provider.preview(f.program);
			} catch (error) {
				failure = error;
			}
		} finally {
			Reflect.set(Array.prototype, "find", nativeFind);
			Reflect.set(Array.prototype, "some", nativeSome);
			if (previousHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previousHome;
			rmSync(directory, { recursive: true, force: true });
		}
		expect(failure).toMatchObject({ code: "SOURCE_FENCE_INCOMPLETE" });
		expect(effects).toBe(0);
	});
	/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-reflect-apply */
	it.each([
		"composite",
		"sourceRequirements",
	] as const)("rejects a missing %s before any stack code runs", (missing) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-source-classify-"));
		try {
			const f = fixture(directory);
			Reflect.deleteProperty(
				missing === "composite" ? f.options : f.composite,
				missing,
			);
			expect(() => createAlchemyIacProvider(f.options)).toThrow(
				"COMPOSITE_ENVIRONMENT_UNVERIFIED",
			);
			expect(f.declarations()).toBe(0);
			expect(f.effects()).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		"preview",
		"assessPricing",
		"refresh",
	] as const)("denies %s before stack planning when host environment authorization fails", async (operation) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-source-classify-"));
		try {
			const f = fixture(directory);
			f.verifyEnvironment.mockReturnValue(false);
			const provider = createAlchemyIacProvider(f.options);
			await expect(provider[operation](f.program)).rejects.toThrow(
				"COMPOSITE_ENVIRONMENT_UNVERIFIED",
			);
			expect(f.declarations()).toBe(0);
			expect(f.effects()).toBe(0);
			expect(f.verifyPlan).not.toHaveBeenCalled();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("requires independently authorized explicit empty classification even for a plan with no registered source", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-source-classify-"));
		const previousHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(directory, "home");
		try {
			const f = fixture(directory);
			f.verifyPlan.mockImplementation(
				({ scope, sourceRequirements, sourceClaims }) =>
					scope.length === 1 &&
					scope[0]?.resourceType === "Demo.Executable" &&
					sourceRequirements.length === 0 &&
					sourceClaims.length === 0,
			);
			const provider = createAlchemyIacProvider(f.options);
			expect((await provider.preview(f.program)).changes).toBe(1);
			expect(f.verifyEnvironment).toHaveBeenCalled();
			expect(f.verifyPlan).toHaveBeenCalled();
			expect(f.effects()).toBe(0);
		} finally {
			if (previousHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = previousHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
