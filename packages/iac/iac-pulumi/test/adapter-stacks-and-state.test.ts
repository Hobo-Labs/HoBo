/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */

/**
 * The Pulumi automation adapter's parse boundary, per-resource stack keys and
 * in-memory state backend.
 *
 * Per-resource stacks mean each resource carries its own state. The failures
 * that follow from getting the key wrong are silent: two resources sharing a
 * key have the second overwrite the first's state, and a key that is unstable
 * across runs orphans state so every apply re-creates what already exists.
 * Neither throws.
 */
import { describe, expect, it } from "vitest";

import {
	createInMemoryAutomationEngine,
	createInMemoryStateBackend,
	createPerResourceStackKey,
	createPulumiAutomationAdapter,
	createStateBackendConfig,
	createTrivialIacProgram,
	IAC_PROGRAM_API_VERSION,
	outputsToBindings,
	PINNED_PULUMI_AUTOMATION_VERSION,
	validateIacProgram,
} from "../src/index.js";

function program(overrides: Record<string, unknown> = {}) {
	return { ...createTrivialIacProgram(), ...overrides } as never;
}

function codeOf(error: unknown): string | undefined {
	return (error as { code?: string }).code;
}

function expectRejection(run: () => unknown, code: string): void {
	try {
		run();
	} catch (error) {
		expect(codeOf(error), (error as Error).message).toBe(code);
		return;
	}
	expect.unreachable(`expected a ${code} rejection`);
}

describe("validateIacProgram", () => {
	it("accepts and freezes the trivial program", () => {
		const parsed = validateIacProgram(createTrivialIacProgram());
		expect(Object.isFrozen(parsed)).toBe(true);
	});

	it("refuses a non-object, a bad apiVersion and a bad kind", () => {
		expectRejection(() => validateIacProgram(null as never), "invalid-program");
		expectRejection(
			() => validateIacProgram(program({ apiVersion: "v0" })),
			"invalid-api-version",
		);
		expectRejection(
			() => validateIacProgram(program({ kind: "plan" })),
			"invalid-kind",
		);
		expect(IAC_PROGRAM_API_VERSION).toBe("hobo.iac-program/v1");
	});

	it("refuses an empty program, a nameless resource and a duplicate name", () => {
		expectRejection(
			() => validateIacProgram(program({ resources: [] })),
			"empty-program",
		);
		expectRejection(
			() => validateIacProgram(program({ resources: [{}] })),
			"invalid-resource",
		);
		const base = createTrivialIacProgram().resources[0];
		expectRejection(
			() =>
				validateIacProgram(
					program({
						stackOutputs: {},
						resources: [base, structuredClone(base)],
					}),
				),
			"duplicate-resource",
		);
	});

	it("refuses an unresolved output reference", () => {
		// The parse boundary is what stops a binding resolving to the literal
		// `${resources...}` string, which reaches a workload as a nonsense
		// environment variable rather than as a failure.
		expectRejection(
			() =>
				validateIacProgram(
					program({
						stackOutputs: { url: "${resources.ghost.outputs.greeting}" },
					}),
				),
			"unresolved-output-reference",
		);
	});
});

describe("createPerResourceStackKey", () => {
	it("namespaces the resource under the deployment id", () => {
		const key = createPerResourceStackKey(
			{ deploymentId: "dep-1", resources: [] } as never,
			"greeter",
		);
		expect(key).toBe("dep-1/greeter");
	});

	it("falls back to the stack name, then to 'default'", () => {
		// Three sources in precedence order. Collapsing to a constant would put
		// two deployments' state in one stack, and each apply would report the
		// other's resources as drift.
		expect(
			createPerResourceStackKey({ stack: "prod", resources: [] } as never, "a"),
		).toBe("prod/a");
		expect(createPerResourceStackKey({ resources: [] } as never, "a")).toBe(
			"default/a",
		);
	});

	it("prefers the deployment id over the stack name", () => {
		expect(
			createPerResourceStackKey(
				{ deploymentId: "dep-1", stack: "prod", resources: [] } as never,
				"a",
			),
		).toBe("dep-1/a");
	});

	it("is stable and distinct per resource", () => {
		const p = { deploymentId: "dep-1", resources: [] } as never;
		// Stability is what keeps state attached across applies; distinctness is
		// what keeps two resources from sharing one state file.
		expect(createPerResourceStackKey(p, "a")).toBe(
			createPerResourceStackKey(p, "a"),
		);
		expect(createPerResourceStackKey(p, "a")).not.toBe(
			createPerResourceStackKey(p, "b"),
		);
	});
});

describe("createStateBackendConfig", () => {
	it("describes an unlocked memory backend by default", () => {
		expect(createStateBackendConfig()).toEqual({
			kind: "memory",
			lockHolder: null,
		});
	});

	it("applies overrides and freezes the result", () => {
		const config = createStateBackendConfig({ kind: "s3", bucket: "b" });
		expect(config.kind).toBe("s3");
		expect(config.bucket).toBe("b");
		// Frozen: a config handed to an engine must not change under it once the
		// engine has decided which backend to talk to.
		expect(Object.isFrozen(config)).toBe(true);
	});

	it("clones overrides rather than aliasing them", () => {
		const overrides = { nested: { a: 1 } };
		const config = createStateBackendConfig(overrides);
		overrides.nested.a = 2;
		expect((config.nested as { a: number }).a).toBe(1);
	});
});

describe("in-memory state backend", () => {
	it("reads an empty state for an unknown stack", () => {
		expect(createInMemoryStateBackend().read("nope")).toEqual({
			resources: {},
		});
	});

	it("round-trips state by value on the way in and out", () => {
		const backend = createInMemoryStateBackend();
		const state = { resources: { a: { specHash: "h1" } } };
		backend.write("s1", state);
		state.resources.a.specHash = "mutated";
		expect(backend.read("s1").resources.a.specHash).toBe("h1");
		const read = backend.read("s1");
		read.resources.a.specHash = "also";
		// State is the record of what was applied; a live reference would let a
		// caller rewrite that record after the fact.
		expect(backend.read("s1").resources.a.specHash).toBe("h1");
	});

	it("keeps stacks independent", () => {
		const backend = createInMemoryStateBackend();
		backend.write("s1", { resources: { a: {} } });
		backend.write("s2", { resources: { b: {} } });
		expect(Object.keys(backend.read("s1").resources)).toEqual(["a"]);
	});

	it("holds a lock exclusively and lets the holder re-take it", () => {
		const backend = createInMemoryStateBackend();
		backend.holdLock("s1", "h1");
		expect(() => backend.holdLock("s1", "h1")).not.toThrow();
		try {
			backend.holdLock("s1", "h2");
			expect.unreachable("a held lock must not be taken");
		} catch (error) {
			// Two concurrent applies against one stack is the corruption the lock
			// exists to prevent.
			expect(codeOf(error)).toBeDefined();
			expect((error as Error).message).toContain("h1");
		}
	});

	it("releases a lock only for its holder", () => {
		const backend = createInMemoryStateBackend();
		backend.holdLock("s1", "h1");
		backend.releaseLock("s1", "impostor");
		expect(() => backend.holdLock("s1", "h2")).toThrow();
		backend.releaseLock("s1", "h1");
		expect(() => backend.holdLock("s1", "h2")).not.toThrow();
	});

	it("simulates a write failure for a nominated stack", () => {
		const backend = createInMemoryStateBackend({ failOnWriteFor: "s1" });
		expect(() => backend.write("s1", { resources: {} })).toThrow();
		// Scoped to the nominated stack, so the failure path is reachable
		// without disabling the whole backend.
		expect(() => backend.write("s2", { resources: {} })).not.toThrow();
	});

	it("snapshots every stack, frozen", () => {
		const backend = createInMemoryStateBackend();
		backend.write("s1", { resources: {} });
		const snapshot = backend.snapshot();
		expect(Object.keys(snapshot)).toEqual(["s1"]);
		expect(Object.isFrozen(snapshot)).toBe(true);
	});
});

describe("outputsToBindings", () => {
	it("emits the short and reference forms plus stack outputs", () => {
		const bindings = outputsToBindings({
			resources: { greeter: { outputs: { greeting: "hello" } } },
			stackOutputs: { url: "https://example.invalid" },
		} as never);
		expect(bindings["greeter.greeting"]).toBe("hello");
		expect(bindings["${resources.greeter.outputs.greeting}"]).toBe("hello");
		expect(bindings["stack.url"]).toBe("https://example.invalid");
	});

	it("handles absent sections and returns a frozen map", () => {
		expect(outputsToBindings({} as never)).toEqual({});
		expect(Object.isFrozen(outputsToBindings({} as never))).toBe(true);
	});
});

describe("adapter over the in-memory engine", () => {
	it("previews dirty, applies, refreshes clean and destroys", async () => {
		const adapter = createPulumiAutomationAdapter({
			engine: createInMemoryAutomationEngine(),
		});
		const p = createTrivialIacProgram();

		const preview = await adapter.preview(p);
		expect(preview.kind).toBe("diff");
		expect(preview.dirty).toBe(true);

		const applied = await adapter.apply(p);
		expect(applied.kind).toBe("outputs");
		expect(Object.keys(applied.bindings).length).toBeGreaterThan(0);

		expect((await adapter.refresh(p)).drifted).toBe(false);
		const destroyed = await adapter.destroy(p);
		expect(destroyed.kind).toBe("outputs");
	});

	it("previews clean once applied, and dirty again when a resource is dropped", async () => {
		const engine = createInMemoryAutomationEngine();
		const adapter = createPulumiAutomationAdapter({ engine });
		const p = createTrivialIacProgram();
		await adapter.apply(p);
		expect((await adapter.preview(p)).dirty).toBe(false);

		// A resource removed from the program still has state, so the preview
		// must report a delete — otherwise the resource would be orphaned in the
		// provider with nothing tracking it.
		const trimmed = program({
			stackOutputs: {},
			resources: [
				{
					name: "unrelated",
					type: "hobo:trivial/greeting",
					outputs: ["greeting"],
				},
			],
		});
		expect((await adapter.preview(trimmed)).dirty).toBe(true);
	});

	it("reports the pinned Pulumi version", () => {
		// The stand-in claims the same pinned version as the real automation
		// lane, so a receipt does not reveal which one produced it.
		expect(createInMemoryAutomationEngine().pulumiVersion).toBe(
			PINNED_PULUMI_AUTOMATION_VERSION,
		);
	});

	it("refuses an invalid program before touching the engine", async () => {
		const adapter = createPulumiAutomationAdapter({
			engine: createInMemoryAutomationEngine(),
		});
		// Parse first: an engine given an unvalidated program could create half
		// the stacks before noticing the bad reference.
		await expect(adapter.apply({} as never)).rejects.toThrow();
	});
});
