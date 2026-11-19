/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-returns, anti-slop/no-unknown-parameters */

import { describe, expect, it } from "vitest";

import {
	createInMemoryHclEngine,
	createInMemoryStateBackend,
	createTerraformAdapter,
	createTrivialIacProgram,
	createWorkspaceKey,
	HCL_PROVIDERS,
	IAC_PROGRAM_API_VERSION,
	outputsToBindings,
	PINNED_TOFU_VERSION,
	TerraformProgramError,
	TerraformStateError,
	validateIacProgram,
} from "../src/index.js";

function program(overrides: Record<string, unknown> = {}) {
	return { ...createTrivialIacProgram(), ...overrides } as never;
}

function expectRejection(
	run: () => unknown,
	code: string,
): TerraformProgramError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(TerraformProgramError);
		expect((error as TerraformProgramError).code).toBe(code);
		return error as TerraformProgramError;
	}
	expect.unreachable(`expected a ${code} rejection`);
	throw new Error("unreachable");
}

describe("validateIacProgram — shape", () => {
	it("accepts and freezes the trivial program", () => {
		const parsed = validateIacProgram(createTrivialIacProgram());
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(parsed.resources.length).toBeGreaterThan(0);
	});

	it("refuses a non-object program", () => {
		for (const value of [null, undefined, "program", 7]) {
			expectRejection(
				() => validateIacProgram(value as never),
				"invalid-program",
			);
		}
	});

	it("refuses a wrong or missing apiVersion", () => {
		expectRejection(
			() => validateIacProgram(program({ apiVersion: "hobo.iac-program/v0" })),
			"invalid-api-version",
		);
		expectRejection(
			() => validateIacProgram(program({ apiVersion: undefined })),
			"invalid-api-version",
		);
		expect(IAC_PROGRAM_API_VERSION).toBe("hobo.iac-program/v1");
	});

	it("refuses a wrong kind", () => {
		expectRejection(
			() => validateIacProgram(program({ kind: "iac-plan" })),
			"invalid-kind",
		);
	});

	it("accepts every HCL provider and refuses anything else", () => {
		for (const provider of HCL_PROVIDERS) {
			expect(validateIacProgram(program({ provider })).provider).toBe(provider);
		}
		expectRejection(
			() => validateIacProgram(program({ provider: "pulumi" })),
			"invalid-provider",
		);
	});

	it("refuses a program with no resources", () => {
		expectRejection(
			() => validateIacProgram(program({ resources: [] })),
			"empty-program",
		);
		expectRejection(
			() => validateIacProgram(program({ resources: {} })),
			"empty-program",
		);
	});

	it("refuses a resource with no name", () => {
		for (const resource of [{}, { name: "" }, null]) {
			expectRejection(
				() => validateIacProgram(program({ resources: [resource] })),
				"invalid-resource",
			);
		}
	});

	it("refuses duplicate resource names", () => {
		expectRejection(
			() =>
				validateIacProgram(
					program({
						resources: [
							{ name: "dup", type: "hobo:trivial/greeting" },
							{ name: "dup", type: "hobo:trivial/greeting" },
						],
					}),
				),
			"duplicate-resource",
		);
	});
});

describe("validateIacProgram — output references", () => {
	function withReference(value: unknown, outputs = ["greeting"]) {
		return program({
			stackOutputs: {},
			resources: [
				{ name: "a", type: "hobo:trivial/greeting", outputs },
				{
					name: "b",
					type: "hobo:trivial/greeting",
					inputs: { message: value },
					outputs: ["greeting"],
				},
			],
		});
	}

	it("accepts a reference to an output the target declares", () => {
		expect(() =>
			validateIacProgram(withReference("${resources.a.outputs.greeting}")),
		).not.toThrow();
	});

	it("refuses a reference to a resource that does not exist", () => {
		expectRejection(
			() =>
				validateIacProgram(
					withReference("${resources.ghost.outputs.greeting}"),
				),
			"unresolved-output-reference",
		);
	});

	it("refuses a reference to an output the target does not declare", () => {
		expectRejection(
			() => validateIacProgram(withReference("${resources.a.outputs.nope}")),
			"unresolved-output-reference",
		);
	});

	it("refuses a malformed reference", () => {
		expectRejection(
			() => validateIacProgram(withReference("${resources.a}")),
			"invalid-output-reference",
		);
		expectRejection(
			() => validateIacProgram(withReference("${resources.a.outputs}")),
			"invalid-output-reference",
		);
	});

	it("leaves ordinary strings alone", () => {
		for (const value of [
			"hello",
			"see resources.a.outputs.greeting for details",
			"$resources.a.outputs.greeting",
			"",
		]) {
			expect(
				() => validateIacProgram(withReference(value)),
				value,
			).not.toThrow();
		}
	});

	it("ignores non-string values", () => {
		for (const value of [7, true, null, { nested: 1 }, [1, 2]]) {
			expect(
				() => validateIacProgram(withReference(value)),
				JSON.stringify(value),
			).not.toThrow();
		}
	});

	it("checks references in stackOutputs too", () => {
		expectRejection(
			() =>
				validateIacProgram(
					program({
						resources: [
							{
								name: "a",
								type: "hobo:trivial/greeting",
								outputs: ["greeting"],
							},
						],
						stackOutputs: { url: "${resources.a.outputs.missing}" },
					}),
				),
			"unresolved-output-reference",
		);
		expect(() =>
			validateIacProgram(
				program({
					resources: [
						{ name: "a", type: "hobo:trivial/greeting", outputs: ["greeting"] },
					],
					stackOutputs: { url: "${resources.a.outputs.greeting}" },
				}),
			),
		).not.toThrow();
	});
});

describe("in-memory state backend", () => {
	it("reads an empty state for an unknown workspace", () => {
		const backend = createInMemoryStateBackend();
		expect(backend.read("nope")).toEqual({ resources: {} });
	});

	it("round-trips a written state by value, not by reference", () => {
		const backend = createInMemoryStateBackend();
		const state = { resources: { a: { specHash: "h1" } } };
		backend.write("ws1", state);
		state.resources.a.specHash = "mutated";
		expect(backend.read("ws1").resources.a.specHash).toBe("h1");
		const read = backend.read("ws1");
		read.resources.a.specHash = "also-mutated";
		expect(backend.read("ws1").resources.a.specHash).toBe("h1");
	});

	it("keeps workspaces independent", () => {
		const backend = createInMemoryStateBackend();
		backend.write("ws1", { resources: { a: {} } });
		backend.write("ws2", { resources: { b: {} } });
		expect(Object.keys(backend.read("ws1").resources)).toEqual(["a"]);
		expect(Object.keys(backend.read("ws2").resources)).toEqual(["b"]);
	});

	it("simulates a write failure for a nominated workspace", () => {
		const backend = createInMemoryStateBackend({ failOnWriteFor: "ws1" });
		try {
			backend.write("ws1", { resources: {} });
			expect.unreachable("the nominated workspace must fail");
		} catch (error) {
			expect(error).toBeInstanceOf(TerraformStateError);
			expect((error as { code?: string }).code).toBe("state-write-failed");
		}
		expect(() => backend.write("ws2", { resources: {} })).not.toThrow();
	});

	it("holds a lock exclusively and lets the holder re-take it", () => {
		const backend = createInMemoryStateBackend();
		backend.holdLock("ws1", "h1");
		expect(() => backend.holdLock("ws1", "h1")).not.toThrow();
		try {
			backend.holdLock("ws1", "h2");
			expect.unreachable("a held lock must not be taken");
		} catch (error) {
			expect((error as { code?: string }).code).toBe("state-lock-held");
			expect((error as Error).message).toContain("h1");
		}
	});

	it("releases a lock only for its holder", () => {
		const backend = createInMemoryStateBackend();
		backend.holdLock("ws1", "h1");
		backend.releaseLock("ws1", "impostor");
		expect(() => backend.holdLock("ws1", "h2")).toThrow();
		backend.releaseLock("ws1", "h1");
		expect(() => backend.holdLock("ws1", "h2")).not.toThrow();
	});

	it("releasing an unheld lock is a no-op", () => {
		const backend = createInMemoryStateBackend();
		expect(() => backend.releaseLock("ws1", "h1")).not.toThrow();
	});

	it("describes the global lock holder", () => {
		const backend = createInMemoryStateBackend();
		expect(backend.describe()).toEqual({ kind: "memory", lockHolder: null });
		backend.holdLock("global", "h1");
		expect(backend.describe().lockHolder).toBe("h1");
	});

	it("snapshots every workspace, frozen", () => {
		const backend = createInMemoryStateBackend();
		backend.write("ws1", { resources: {} });
		const snapshot = backend.snapshot();
		expect(Object.keys(snapshot)).toEqual(["ws1"]);
		expect(Object.isFrozen(snapshot)).toBe(true);
	});
});

describe("createWorkspaceKey", () => {
	it("combines the program identity with the resource name", () => {
		const key = createWorkspaceKey(createTrivialIacProgram(), "greeter");
		expect(key).toContain("greeter");
		expect(createWorkspaceKey(createTrivialIacProgram(), "greeter")).toBe(key);
	});

	it("gives different resources different keys", () => {
		const p = createTrivialIacProgram();
		expect(createWorkspaceKey(p, "a")).not.toBe(createWorkspaceKey(p, "b"));
	});
});

describe("outputsToBindings", () => {
	it("emits both the short and the reference form for every output", () => {
		const bindings = outputsToBindings({
			resources: { greeter: { outputs: { greeting: "hello", id: "r1" } } },
		} as never);
		expect(bindings["greeter.greeting"]).toBe("hello");
		expect(bindings["${resources.greeter.outputs.greeting}"]).toBe("hello");
		expect(bindings["greeter.id"]).toBe("r1");
	});

	it("prefixes stack outputs distinctly", () => {
		const bindings = outputsToBindings({
			resources: {},
			stackOutputs: { url: "https://example.invalid" },
		} as never);
		expect(bindings["stack.url"]).toBe("https://example.invalid");
	});

	it("handles absent resources and stackOutputs", () => {
		expect(outputsToBindings({} as never)).toEqual({});
		expect(outputsToBindings({ resources: {} } as never)).toEqual({});
	});

	it("handles a resource with no outputs", () => {
		expect(outputsToBindings({ resources: { a: {} } } as never)).toEqual({});
	});

	it("returns a frozen map", () => {
		expect(
			Object.isFrozen(
				outputsToBindings({ resources: { a: { outputs: { b: 1 } } } } as never),
			),
		).toBe(true);
	});
});

describe("adapter over the in-memory engine", () => {
	it("previews dirty, applies, refreshes clean and destroys", async () => {
		const adapter = createTerraformAdapter({
			engine: createInMemoryHclEngine(),
		});
		const p = createTrivialIacProgram();

		const preview = await adapter.preview(p);
		expect(preview.kind).toBe("diff");
		expect(preview.dirty).toBe(true);

		const applied = await adapter.apply(p);
		expect(applied.kind).toBe("outputs");
		expect(Object.keys(applied.resources).length).toBeGreaterThan(0);
		expect(Object.keys(applied.bindings).length).toBeGreaterThan(0);

		const refresh = await adapter.refresh(p);
		expect(refresh.kind).toBe("drift-report");
		expect(refresh.drifted).toBe(false);

		const destroyed = await adapter.destroy(p);
		expect(
			Object.values(destroyed.resources).every(
				(resource: { status: string }) => resource.status === "destroyed",
			),
		).toBe(true);
	});

	it("previews clean once the program is already applied", async () => {
		const adapter = createTerraformAdapter({
			engine: createInMemoryHclEngine(),
		});
		const p = createTrivialIacProgram();
		await adapter.apply(p);
		const preview = await adapter.preview(p);
		expect(preview.dirty).toBe(false);
	});

	it("reports the pinned toolchain version", () => {
		const engine = createInMemoryHclEngine();
		expect(engine.toolchainVersion).toBe(PINNED_TOFU_VERSION);
		expect(engine.binary).toBe("tofu");
	});

	it("refuses an invalid program before touching the engine", async () => {
		const adapter = createTerraformAdapter({
			engine: createInMemoryHclEngine(),
		});
		await expect(adapter.apply({} as never)).rejects.toThrowError(
			TerraformProgramError,
		);
	});
});
