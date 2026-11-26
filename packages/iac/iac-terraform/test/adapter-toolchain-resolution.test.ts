/**
 * Which binary the adapter reports, and which version it pins to it.
 *
 * `terraform-adapter.test.ts` covers what the adapter *does* — program
 * parsing, per-resource workspace state, divergence and partial apply. This
 * covers what it *says it is*, which is a smaller surface with a sharper
 * failure mode.
 *
 * `binary` and `toolchainVersion` are read off the frozen adapter and reported
 * into receipts. Terraform and OpenTofu are separate projects on separate
 * version lines, so a version reported against the wrong binary is not a
 * cosmetic slip: it claims a provisioning run was made by a toolchain that
 * never touched it, on a receipt whose whole job is to say what did.
 *
 * The resolution is a three-step fallback — caller, then engine, then a
 * default keyed on which binary won — and every step matters to someone. A
 * caller naming a binary is pinning it. An engine reporting one is the CLI
 * lane describing the binary it actually found on PATH. The default is what
 * the offline in-memory lane runs as.
 *
 * `snapshotState` is here for the same reason: it is a capability probe
 * (`engine.snapshot instanceof Function`) rather than a fixed call, so an
 * engine that does not implement snapshotting has to fall through to the state
 * backend rather than throwing.
 */
import { describe, expect, it } from "vitest";

import { createTerraformAdapter } from "../src/terraform-adapter.js";

type Engine = NonNullable<
	NonNullable<Parameters<typeof createTerraformAdapter>[0]>["engine"]
>;

/** A minimal engine; every capability beyond preview/apply is optional. */
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
		// The offline default. OpenTofu is what the in-memory lane stands in for,
		// so an adapter built with no options must not claim to be terraform.
		expect(createTerraformAdapter().binary).toBe("tofu");
	});

	it("takes the caller's binary over everything else", () => {
		// A caller naming a binary is pinning it -- usually because their
		// environment has exactly one of the two.
		expect(createTerraformAdapter({ binary: "terraform" }).binary).toBe(
			"terraform",
		);
	});

	it("takes the engine's binary when the caller names none", () => {
		// The CLI lane reports the binary it actually resolved on PATH, which is
		// more truthful than a default guess.
		expect(
			createTerraformAdapter({ engine: engineStub({ binary: "terraform" }) })
				.binary,
		).toBe("terraform");
	});

	it("prefers the caller even when the engine disagrees", () => {
		// The order is caller, then engine. Worth pinning because the reverse
		// would silently ignore an explicit pin.
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
		// The two projects are on separate version lines. Reporting a tofu
		// version against a terraform run would put a toolchain on the receipt
		// that never touched the provisioning.
		const tofu = createTerraformAdapter({ binary: "tofu" }).toolchainVersion;
		const terraform = createTerraformAdapter({
			binary: "terraform",
		}).toolchainVersion;
		expect(terraform).toMatch(/^\d+\.\d+\.\d+$/u);
		expect(terraform).not.toBe(tofu);
	});

	it("keys the default off the resolved binary, not the caller's argument", () => {
		// The binary here comes from the engine, and the version default has to
		// follow it. If the default were keyed on `options.binary` it would be
		// undefined and fall to the tofu line while reporting terraform.
		const adapter = createTerraformAdapter({
			engine: engineStub({ binary: "terraform" }),
		});
		expect(adapter.binary).toBe("terraform");
		expect(adapter.toolchainVersion).toBe(
			createTerraformAdapter({ binary: "terraform" }).toolchainVersion,
		);
	});

	it("takes the caller's version verbatim", () => {
		// An operator pinning a version knows something about their environment
		// that this package does not.
		expect(
			createTerraformAdapter({ toolchainVersion: "1.2.3-rc1" })
				.toolchainVersion,
		).toBe("1.2.3-rc1");
	});

	it("takes the engine's reported version over the pinned default", () => {
		// The CLI lane reports the version it actually ran `--version` against.
		// A pinned default that overrode it would report a version the binary on
		// disk does not have.
		expect(
			createTerraformAdapter({
				engine: engineStub({ toolchainVersion: "9.9.9" }),
			}).toolchainVersion,
		).toBe("9.9.9");
	});
});

describe("snapshotting estate state", () => {
	it("asks the engine when it can snapshot", () => {
		// The CLI lane reads real state; only it knows how.
		const adapter = createTerraformAdapter({
			engine: engineStub({ snapshot: () => ({ from: "engine" }) }),
		});
		expect(adapter.snapshotState()).toEqual({ from: "engine" });
	});

	it("falls back to the state backend when the engine cannot", () => {
		// `snapshot` is optional on the engine shape, so this is a capability
		// probe rather than a call. Without the fallback, drift and import would
		// throw against any engine that does not implement it.
		expect(() =>
			createTerraformAdapter({ engine: engineStub() }).snapshotState(),
		).not.toThrow();
	});

	it("does not mistake a non-callable snapshot property for a capability", () => {
		// `instanceof Function`, not a truthiness check. An engine carrying a
		// `snapshot` string would otherwise be called and throw.
		// SAFETY: deliberately outside the engine type, where `snapshot` is a
		// method; the adapter probes it with `instanceof Function`, pinned here.
		const engine = { ...engineStub(), snapshot: "not-callable" } as never;
		const adapter = createTerraformAdapter({ engine });
		expect(() => adapter.snapshotState()).not.toThrow();
	});
});

describe("the adapter it hands back", () => {
	it("is frozen, because callers hold it across provisioning runs", () => {
		// A mutated binary or version between preview and apply would put one
		// toolchain on the plan and another on the receipt.
		const adapter = createTerraformAdapter();
		expect(Object.isFrozen(adapter)).toBe(true);
	});

	it("describes its state backend rather than exposing it", () => {
		// `stateBackend.describe()`, not the backend itself: the description is
		// safe to serialise into a receipt, the backend is not.
		const adapter = createTerraformAdapter();
		expect(adapter.stateBackend).toBeDefined();
		expect(adapter.stateBackend).not.toBeTypeOf("function");
	});
});
