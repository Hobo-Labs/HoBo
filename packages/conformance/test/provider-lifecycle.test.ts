// Self-test for the provider scratch harness (ADR-0159, unit F). The reference
// provider passes all six lifecycle cases; deliberately broken providers — a
// delete that throws the second time, a create that mints a second instance on
// a resumed apply, an "update" that replaces, a "replace" that mutates in
// place, a provider with no adopt() — each fail the *named* case they break.
// A conformance suite that cannot fail is decoration.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	createReferenceScratchProvider,
	createScratchStack,
	PROVIDER_LIFECYCLE_CASE_NAMES,
	PROVIDER_LIFECYCLE_SUITE,
	PROVIDER_LIFECYCLE_SUITE_DESCRIPTOR,
	PROVIDER_LIFECYCLE_SUITE_ID,
	ProviderLifecycleError,
	parseScratchDesired,
	parseScratchProvider,
	parseScratchSeed,
	runProviderLifecycleConformance,
	type ScratchOwnedContext,
	type ScratchProvider,
	type ScratchProviderContext,
	type ScratchProviderResult,
} from "../src/provider-lifecycle.js";

const NAMES = PROVIDER_LIFECYCLE_CASE_NAMES;

const DESIRED = {
	type: "scratch:resource",
	logicalId: "conformance-subject",
	properties: { label: "alpha", size: "small" },
	stables: { region: "scratch-east" },
};

function failedNames(failed: readonly { readonly name: string }[]): string[] {
	return failed.map((failure) => failure.name);
}

/** The reference provider with one verb swapped for a broken one. */
function brokenProvider(overrides: Partial<ScratchProvider>): ScratchProvider {
	return { ...createReferenceScratchProvider(), ...overrides };
}

describe("@hobo/conformance provider lifecycle suite", () => {
	it("declares exactly the six named lifecycle cases", () => {
		expect(PROVIDER_LIFECYCLE_SUITE.map((suiteCase) => suiteCase.name)).toEqual(
			[
				NAMES.create,
				NAMES.updateInPlace,
				NAMES.replace,
				NAMES.deleteIdempotent,
				NAMES.adopt,
				NAMES.crashResume,
			],
		);
		expect(PROVIDER_LIFECYCLE_SUITE_DESCRIPTOR.suiteId).toBe(
			PROVIDER_LIFECYCLE_SUITE_ID,
		);
		expect(PROVIDER_LIFECYCLE_SUITE_DESCRIPTOR.caseIds).toHaveLength(6);
	});

	it("passes the reference provider on every case", async () => {
		const result = await runProviderLifecycleConformance(
			createReferenceScratchProvider(),
		);
		expect(result.failed).toEqual([]);
		expect(result.passed).toBe(6);
	});

	it("is deterministic: two runs of the same suite are identical", async () => {
		const first = await runProviderLifecycleConformance(
			createReferenceScratchProvider(),
		);
		const second = await runProviderLifecycleConformance(
			createReferenceScratchProvider(),
		);
		expect(second).toEqual(first);
	});

	it("isolates cases: a fresh scratch stack per case", async () => {
		const seenWorldSizes: number[] = [];
		const provider = brokenProvider({
			create(context: ScratchProviderContext): ScratchProviderResult {
				seenWorldSizes.push(context.world.list().length);
				return createReferenceScratchProvider().create(context);
			},
		});
		await runProviderLifecycleConformance(provider);
		// Every case's first create sees an empty world (except adopt, which is
		// seeded and never routes through create).
		expect(seenWorldSizes[0]).toBe(0);
		expect(seenWorldSizes).not.toContain(2);
	});
});

describe("scratch stacks stay in memory", () => {
	it("imports no filesystem module and names no on-disk stage", async () => {
		const source = await readFile(
			fileURLToPath(new URL("../src/provider-lifecycle.ts", import.meta.url)),
			"utf8",
		);
		// Comments name the forbidden stages; the code must not.
		const code = source
			.replace(/\/\*[\s\S]*?\*\//gu, "")
			.replace(/^[\t ]*\/\/.*$/gmu, "");
		expect(code).not.toMatch(/from "node:/u);
		expect(code).not.toMatch(/require\(/u);
		expect(code).not.toMatch(/\.alchemy/u);
		expect(code).not.toMatch(/\.hobo\//u);
	});

	it("creates no .hobo/ or .alchemy/ directory when the whole suite runs", async () => {
		const before = [".hobo", ".alchemy"].map((dir) => existsSync(dir));
		await runProviderLifecycleConformance(createReferenceScratchProvider());
		const after = [".hobo", ".alchemy"].map((dir) => existsSync(dir));
		expect(after).toEqual(before);
	});

	it("keeps two stacks over the same logical id fully independent", async () => {
		const left = createScratchStack();
		const right = createScratchStack();
		const fromLeft = await left.deploy(DESIRED);
		expect(right.state.list()).toEqual([]);
		const fromRight = await right.deploy(DESIRED);
		expect(fromRight.instanceId).toBe(fromLeft.instanceId);
		expect(left.state.list()).toHaveLength(1);
		expect(right.state.list()).toHaveLength(1);
	});
});

describe("the suite fails a broken provider on the case it breaks", () => {
	it("fails delete-idempotent for a provider that throws on a second delete", async () => {
		const result = await runProviderLifecycleConformance(
			brokenProvider({
				delete(context: ScratchOwnedContext): void {
					if (context.world.get(context.current.id) === undefined) {
						throw new Error("resource already deleted");
					}
					context.world.remove(context.current.id);
				},
			}),
		);
		expect(failedNames(result.failed)).toEqual([NAMES.deleteIdempotent]);
		expect(result.failed[0]?.error).toMatch(/already deleted/u);
		expect(result.passed).toBe(5);
	});

	it("fails crash-resume for a provider that mints a second instance on retry", async () => {
		const result = await runProviderLifecycleConformance(
			brokenProvider({
				create(context: ScratchProviderContext): ScratchProviderResult {
					// Never looks for what it already made: every apply provisions.
					const created = context.world.put({
						id: context.world.nextInstanceId(context.logicalId),
						type: context.type,
						logicalId: context.logicalId,
						owned: true,
						outputs: { ...context.properties },
						stables: context.stables,
					});
					return { instanceId: created.id, outputs: created.outputs };
				},
			}),
		);
		expect(failedNames(result.failed)).toEqual([NAMES.crashResume]);
		expect(result.failed[0]?.error).toMatch(/double-provision/u);
		expect(result.passed).toBe(5);
	});

	it("fails both cases when a provider is broken in both ways", async () => {
		const result = await runProviderLifecycleConformance(
			brokenProvider({
				create(context: ScratchProviderContext): ScratchProviderResult {
					const created = context.world.put({
						id: context.world.nextInstanceId(context.logicalId),
						type: context.type,
						logicalId: context.logicalId,
						owned: true,
						outputs: { ...context.properties },
						stables: context.stables,
					});
					return { instanceId: created.id, outputs: created.outputs };
				},
				delete(context: ScratchOwnedContext): void {
					if (context.world.get(context.current.id) === undefined) {
						throw new Error("resource already deleted");
					}
					context.world.remove(context.current.id);
				},
			}),
		);
		expect(failedNames(result.failed).sort()).toEqual(
			[NAMES.crashResume, NAMES.deleteIdempotent].sort(),
		);
		expect(result.passed).toBe(4);
	});

	it("fails update-in-place for a provider whose update replaces the instance", async () => {
		const result = await runProviderLifecycleConformance(
			brokenProvider({
				update(context: ScratchOwnedContext): ScratchProviderResult {
					context.world.remove(context.current.id);
					const replacement = context.world.put({
						...context.current,
						id: context.world.nextInstanceId(context.logicalId),
						outputs: { ...context.properties },
					});
					return { instanceId: replacement.id, outputs: replacement.outputs };
				},
			}),
		);
		expect(failedNames(result.failed)).toEqual([NAMES.updateInPlace]);
		expect(result.failed[0]?.error).toMatch(/only a stable field/u);
	});

	it("fails update-in-place for a provider whose update never changes the outputs", async () => {
		const result = await runProviderLifecycleConformance(
			brokenProvider({
				update(context: ScratchOwnedContext): ScratchProviderResult {
					return {
						instanceId: context.current.id,
						outputs: context.current.outputs,
					};
				},
			}),
		);
		expect(failedNames(result.failed)).toEqual([NAMES.updateInPlace]);
		expect(result.failed[0]?.error).toMatch(/never reached the resource/u);
	});

	it("fails replace for a provider that reuses the instance id of a stable-field change", async () => {
		const result = await runProviderLifecycleConformance(
			brokenProvider({
				create(context: ScratchProviderContext): ScratchProviderResult {
					const created = context.world.put({
						id: `${context.logicalId}:pinned`,
						type: context.type,
						logicalId: context.logicalId,
						owned: true,
						outputs: {
							...context.properties,
							endpoint: `scratch://${context.logicalId}`,
						},
						stables: context.stables,
					});
					return { instanceId: created.id, outputs: created.outputs };
				},
			}),
		);
		expect(failedNames(result.failed)).toEqual([NAMES.replace]);
		expect(result.failed[0]?.error).toMatch(/immutable field/u);
	});

	it("fails adopt for a provider that declares no adopt()", async () => {
		const reference = createReferenceScratchProvider();
		const result = await runProviderLifecycleConformance({
			create: reference.create,
			update: reference.update,
			delete: reference.delete,
		});
		expect(failedNames(result.failed)).toEqual([NAMES.adopt]);
		expect(result.failed[0]?.error).toMatch(/no adopt\(\)/u);
	});

	it("fails adopt for a provider that re-creates instead of taking ownership", async () => {
		const result = await runProviderLifecycleConformance(
			brokenProvider({
				adopt(context: ScratchOwnedContext): ScratchProviderResult {
					context.world.remove(context.current.id);
					const created = context.world.put({
						id: context.world.nextInstanceId(context.logicalId),
						type: context.type,
						logicalId: context.logicalId,
						owned: true,
						outputs: { ...context.properties },
						stables: context.stables,
					});
					return { instanceId: created.id, outputs: created.outputs };
				},
			}),
		);
		expect(failedNames(result.failed)).toEqual([NAMES.adopt]);
		expect(result.failed[0]?.error).toMatch(/instead of taking over/u);
	});

	it("fails create for a provider that reports no outputs", async () => {
		const result = await runProviderLifecycleConformance(
			brokenProvider({
				create(context: ScratchProviderContext): ScratchProviderResult {
					const created = context.world.put({
						id: context.world.nextInstanceId(context.logicalId),
						type: context.type,
						logicalId: context.logicalId,
						owned: true,
						outputs: {},
						stables: context.stables,
					});
					return { instanceId: created.id, outputs: {} };
				},
			}),
		);
		expect(failedNames(result.failed)).toContain(NAMES.create);
		expect(result.failed[0]?.error).toMatch(/no outputs/u);
	});
});

describe("scratch stack reconcile semantics", () => {
	it("keeps the logical id stable and changes outputs on an update", async () => {
		const stack = createScratchStack();
		const before = await stack.deploy(DESIRED);
		const after = await stack.deploy({
			...DESIRED,
			properties: { label: "beta", size: "large" },
		});
		expect(after.instanceId).toBe(before.instanceId);
		expect(after.outputs).not.toEqual(before.outputs);
		expect(stack.state.list()).toHaveLength(1);
	});

	it("mints a new instance id when a declared-stable field changes", async () => {
		const stack = createScratchStack();
		const before = await stack.deploy(DESIRED);
		const after = await stack.deploy({
			...DESIRED,
			stables: { region: "scratch-west" },
		});
		expect(after.instanceId).not.toBe(before.instanceId);
		expect(stack.state.list()).toEqual([
			{ id: after.instanceId, type: DESIRED.type },
		]);
	});

	it("adopts a pre-seeded foreign resource instead of creating a new one", async () => {
		const stack = createScratchStack({
			seed: {
				resources: [
					{
						id: "scratch:foreign/pre-existing",
						type: DESIRED.type,
						logicalId: DESIRED.logicalId,
						owned: false,
					},
				],
			},
		});
		expect(stack.state.resources()[0]?.owned).toBe(false);
		const adopted = await stack.deploy(DESIRED);
		expect(adopted.instanceId).toBe("scratch:foreign/pre-existing");
		expect(stack.state.resources()).toHaveLength(1);
		expect(stack.state.resources()[0]?.owned).toBe(true);
	});

	it("lists instances id-sorted, independent of deploy order", async () => {
		const stack = createScratchStack();
		await stack.deploy({ ...DESIRED, logicalId: "zulu" });
		await stack.deploy({ ...DESIRED, logicalId: "alpha" });
		expect(stack.state.list().map((entry) => entry.id)).toEqual([
			"scratch:alpha#1",
			"scratch:zulu#1",
		]);
	});

	it("tears down in reverse deploy order", async () => {
		const order: string[] = [];
		const stack = createScratchStack({
			provider: brokenProvider({
				delete(context: ScratchOwnedContext): void {
					order.push(context.logicalId);
					context.world.remove(context.current.id);
				},
			}),
		});
		await stack.deploy({ ...DESIRED, logicalId: "first" });
		await stack.deploy({ ...DESIRED, logicalId: "second" });
		await stack.destroy();
		expect(order).toEqual(["second", "first"]);
		expect(stack.state.list()).toEqual([]);
	});

	it("re-issues delete for an already-deleted instance on a second destroy", async () => {
		let deletes = 0;
		const stack = createScratchStack({
			provider: brokenProvider({
				delete(context: ScratchOwnedContext): void {
					deletes += 1;
					context.world.remove(context.current.id);
				},
			}),
		});
		await stack.deploy(DESIRED);
		await stack.destroy();
		await stack.destroy();
		expect(deletes).toBe(2);
	});
});

describe("parse boundaries fail closed", () => {
	it.each([
		[undefined, "desired is not an object"],
		[{ logicalId: "x" }, "type is missing"],
		[{ type: "scratch:resource" }, "logicalId is missing"],
		[{ type: "scratch:resource", logicalId: "  " }, "logicalId is blank"],
		[
			{ type: "scratch:resource", logicalId: "x", properties: [] },
			"properties is not a record",
		],
	])("rejects desired state (%#): %s", (input) => {
		expect(() => parseScratchDesired(input)).toThrow(ProviderLifecycleError);
		try {
			parseScratchDesired(input);
		} catch (error) {
			// SAFETY: assertion to `r as ProviderLifecycleError).co` is required at this boundary.
			expect((error as ProviderLifecycleError).code).toBe(
				"SCRATCH_DESIRED_INVALID",
			);
		}
	});

	it.each([
		[{ resources: {} }, "resources is not an array"],
		[{ resources: [{ type: "t", logicalId: "l" }] }, "seed id is missing"],
		[
			{ resources: [{ id: "i", type: "t", logicalId: "l", owned: "yes" }] },
			"owned is not a boolean",
		],
	])("rejects a seed (%#): %s", (input) => {
		try {
			parseScratchSeed(input);
			expect.unreachable("seed should not parse");
		} catch (error) {
			// SAFETY: assertion to `r as ProviderLifecycleError).co` is required at this boundary.
			expect((error as ProviderLifecycleError).code).toBe(
				"SCRATCH_SEED_INVALID",
			);
		}
	});

	it("accepts an absent seed as an empty world", () => {
		expect(parseScratchSeed(undefined)).toEqual([]);
		expect(parseScratchSeed({})).toEqual([]);
	});

	it.each([
		[undefined, "provider is not an object"],
		[{ update: () => undefined, delete: () => undefined }, "create is missing"],
		[{ create: () => undefined, delete: () => undefined }, "update is missing"],
		[{ create: () => undefined, update: () => undefined }, "delete is missing"],
		[
			{
				create: () => undefined,
				update: () => undefined,
				delete: () => undefined,
				adopt: "nope",
			},
			"adopt is not a function",
		],
	])("rejects a provider (%#): %s", (input) => {
		try {
			parseScratchProvider(input);
			expect.unreachable("provider should not parse");
		} catch (error) {
			// SAFETY: assertion to `r as ProviderLifecycleError).co` is required at this boundary.
			expect((error as ProviderLifecycleError).code).toBe(
				"SCRATCH_PROVIDER_INVALID",
			);
		}
	});

	it("refuses to run the suite against an unusable provider", async () => {
		await expect(runProviderLifecycleConformance({})).rejects.toThrow(
			ProviderLifecycleError,
		);
	});

	it("rejects a provider result that names no instance", async () => {
		const stack = createScratchStack({
			provider: brokenProvider({
				create: (): ScratchProviderResult =>
					// SAFETY: assertion to ` as ScratchProviderResult, ` is required at this boundary.
					({}) as ScratchProviderResult,
			}),
		});
		await expect(stack.deploy(DESIRED)).rejects.toThrow(
			/provider result\.instanceId/u,
		);
	});
});
