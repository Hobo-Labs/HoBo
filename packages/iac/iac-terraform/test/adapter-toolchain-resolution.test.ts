import { describe, expect, it } from "vitest";

import { createTerraformAdapter } from "../src/terraform-adapter.js";

type Engine = NonNullable<
	NonNullable<Parameters<typeof createTerraformAdapter>[0]>["engine"]
>;

function engineStub(over: Partial<Engine> = {}): Engine {
	return {
		async preview() {
			return { changes: [] };
		},
		async apply() {
			return { appliedChanges: [], outputs: {} };
		},
		refresh() {
			return {};
		},
		destroy() {
			return {};
		},
		...over,
	};
}

describe("which binary the adapter reports", () => {
	it("defaults to tofu", () => {
		expect(createTerraformAdapter().binary).toBe("tofu");
	});

	it("takes the caller's binary over everything else", () => {
		expect(createTerraformAdapter({ binary: "terraform" }).binary).toBe(
			"terraform",
		);
	});

	it("takes the engine's binary when the caller names none", () => {
		expect(
			createTerraformAdapter({ engine: engineStub({ binary: "terraform" }) })
				.binary,
		).toBe("terraform");
	});

	it("prefers the caller even when the engine disagrees", () => {
		expect(
			createTerraformAdapter({
				binary: "tofu",
				engine: engineStub({ binary: "terraform" }),
			}).binary,
		).toBe("tofu");
	});
});

describe("which toolchain version it pins", () => {
	it("pins the tofu version by default", () => {
		const { binary, toolchainVersion } = createTerraformAdapter();
		expect(binary).toBe("tofu");
		expect(toolchainVersion).toMatch(/^\d+\.\d+\.\d+$/u);
	});

	it("pins a different version once the binary is terraform", () => {
		const tofu = createTerraformAdapter({ binary: "tofu" }).toolchainVersion;
		const terraform = createTerraformAdapter({
			binary: "terraform",
		}).toolchainVersion;
		expect(terraform).toMatch(/^\d+\.\d+\.\d+$/u);
		expect(terraform).not.toBe(tofu);
	});

	it("keys the default off the resolved binary, not the caller's argument", () => {
		const adapter = createTerraformAdapter({
			engine: engineStub({ binary: "terraform" }),
		});
		expect(adapter.binary).toBe("terraform");
		expect(adapter.toolchainVersion).toBe(
			createTerraformAdapter({ binary: "terraform" }).toolchainVersion,
		);
	});

	it("takes the caller's version verbatim", () => {
		expect(
			createTerraformAdapter({ toolchainVersion: "1.2.3-rc1" })
				.toolchainVersion,
		).toBe("1.2.3-rc1");
	});

	it("takes the engine's reported version over the pinned default", () => {
		expect(
			createTerraformAdapter({
				engine: engineStub({ toolchainVersion: "9.9.9" }),
			}).toolchainVersion,
		).toBe("9.9.9");
	});
});

describe("snapshotting estate state", () => {
	it("asks the engine when it can snapshot", () => {
		const adapter = createTerraformAdapter({
			engine: engineStub({ snapshot: () => ({ from: "engine" }) }),
		});
		expect(adapter.snapshotState()).toEqual({ from: "engine" });
	});

	it("falls back to the state backend when the engine cannot", () => {
		expect(() =>
			createTerraformAdapter({ engine: engineStub() }).snapshotState(),
		).not.toThrow();
	});

	it("does not mistake a non-callable snapshot property for a capability", () => {
		// SAFETY: deliberately outside the engine type, where `snapshot` is a
		// method; the adapter probes it with `instanceof Function`, pinned here.
		const engine = { ...engineStub(), snapshot: "not-callable" } as never;
		const adapter = createTerraformAdapter({ engine });
		expect(() => adapter.snapshotState()).not.toThrow();
	});
});

describe("the adapter it hands back", () => {
	it("is frozen, because callers hold it across provisioning runs", () => {
		const adapter = createTerraformAdapter();
		expect(Object.isFrozen(adapter)).toBe(true);
	});

	it("describes its state backend rather than exposing it", () => {
		const adapter = createTerraformAdapter();
		expect(adapter.stateBackend).toBeDefined();
		expect(adapter.stateBackend).not.toBeTypeOf("function");
	});
});
