import { describe, expect, it } from "vitest";

import {
	ADAPTER_ID,
	createInMemoryHclEngine,
	createInMemoryStateBackend,
	createTerraformAdapter,
	createTrivialIacProgram,
	createWorkspaceKey,
	PINNED_TOFU_VERSION,
	runIacBackendConformance,
	TerraformApplyError,
	TerraformProgramError,
	TerraformStateError,
	validateIacProgram,
} from "../src/index.js";

// HOBO-717: the HCL-lane adapter over the deterministic in-memory engine —
// program parsing, per-resource workspace state, divergence/partial-apply
// fail-closed behavior, and the shared IaC-backend conformance smoke.

describe("validateIacProgram (parse, don't validate)", () => {
	it("accepts terraform and opentofu providers and freezes the parsed program", () => {
		for (const provider of ["terraform", "opentofu"]) {
			const parsed = validateIacProgram(createTrivialIacProgram({ provider }));
			expect(Object.isFrozen(parsed)).toBe(true);
			expect(parsed.provider).toBe(provider);
		}
	});

	it("rejects a non-HCL provider, duplicate resources, and unresolved references", () => {
		expect(() =>
			validateIacProgram(createTrivialIacProgram({ provider: "pulumi" })),
		).toThrowError(TerraformProgramError);

		const duplicate = createTrivialIacProgram();
		expect(() =>
			validateIacProgram({
				...duplicate,
				resources: [...duplicate.resources, ...duplicate.resources],
			}),
		).toThrowError(TerraformProgramError);

		expect(() =>
			validateIacProgram(
				createTrivialIacProgram({
					stackOutputs: { broken: "${resources.hello.outputs.nope}" },
				}),
			),
		).toThrowError(TerraformProgramError);
	});
});

describe("createTerraformAdapter over the in-memory engine", () => {
	it("previews, applies, refreshes clean, and destroys with bindings", async () => {
		const adapter = createTerraformAdapter();
		const program = createTrivialIacProgram();

		const preview = await adapter.preview(program);
		expect(preview.dirty).toBe(true);
		expect(preview.model).toBe("per-resource-workspace");

		const outputs = await adapter.apply(program);
		expect(outputs.resources.hello.status).toBe("provisioned");
		expect(outputs.bindings["hello.greeting"]).toBe("hello-bindle");
		expect(outputs.stackOutputs.greeting).toBe("hello-bindle");

		const refresh = await adapter.refresh(program);
		expect(refresh.drifted).toBe(false);

		const destroy = await adapter.destroy(program);
		expect(destroy.resources.hello.status).toBe("destroyed");
	});

	it("keys state per resource workspace (deploymentId/resourceName)", () => {
		const program = createTrivialIacProgram();
		expect(createWorkspaceKey(program, "hello")).toBe("trivial-demo/hello");
	});

	it("fails closed on partial apply and reports drift on refresh", async () => {
		const stateBackend = createInMemoryStateBackend();
		const engine = createInMemoryHclEngine({
			stateBackend,
			failAfterResource: "first",
		});
		const adapter = createTerraformAdapter({ engine, stateBackend });
		const program = createTrivialIacProgram({
			resources: [
				{
					name: "first",
					type: "hobo:trivial/greeting",
					provider: "local",
					inputs: { message: "one" },
					outputs: ["greeting", "resourceId"],
				},
				{
					name: "second",
					type: "hobo:trivial/greeting",
					provider: "local",
					inputs: { message: "two" },
					outputs: ["greeting", "resourceId"],
				},
			],
			stackOutputs: {},
		});

		await expect(adapter.apply(program)).rejects.toThrowError(
			TerraformApplyError,
		);
		const drift = await adapter.refresh(program);
		expect(drift.drifted).toBe(true);
		expect(drift.resources.map((r) => r.reason)).toContain(
			"partial-apply-provisioned",
		);
	});

	it("surfaces state-lock contention as a typed error", () => {
		const stateBackend = createInMemoryStateBackend();
		stateBackend.holdLock("trivial-demo/hello", "someone-else");
		expect(() =>
			stateBackend.holdLock("trivial-demo/hello", "resource-actor:self"),
		).toThrowError(TerraformStateError);
	});

	it("passes the shared @hobo/conformance/iac-backend smoke", async () => {
		const result = await runIacBackendConformance({
			adapter: createTerraformAdapter(),
			program: createTrivialIacProgram(),
		});
		expect(result.passed).toBe(true);
		expect(result.provider).toBe("terraform");
		expect(result.assertions).toEqual([
			"preview-diff",
			"apply-outputs",
			"binding-outputs",
			"refresh-clean",
			"destroy-clean",
		]);
	});

	it("reports adapter identity: id, default binary, pinned toolchain", () => {
		const adapter = createTerraformAdapter();
		expect(adapter.id).toBe(ADAPTER_ID);
		expect(adapter.binary).toBe("tofu");
		expect(adapter.toolchainVersion).toBe(PINNED_TOFU_VERSION);
	});
});
