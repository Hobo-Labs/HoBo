import { createLocalFeatureClient, type FeatureFlagPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import { createFlagEmulator, createTestHarness } from "../src/index.js";
import { fakeBindle } from "./fixtures.js";

function app() {
	return fakeBindle({
		resources: {
			flags: { kind: "flag" },
			other: { kind: "flag" },
			cache: { kind: "kv" },
		},
		handlers: {},
	});
}

describe("in-process feature flags", () => {
	it("allows a controlled event clock", () => {
		const flags = createFlagEmulator({ now: () => "2026-01-01T00:00:00.000Z" });
		flags.port.define({ key: "checkout" });
		expect(flags.inspector?.events()[0]?.time).toBe("2026-01-01T00:00:00.000Z");
	});

	it("isolates event snapshots from nested flag values", () => {
		const flags = createFlagEmulator();
		flags.port.define({
			key: "config",
			defaultValue: { nested: { value: "original" } },
		});
		const snapshot = flags.inspector?.events()[0];
		if (!snapshot) throw new Error("expected a flag event");
		// SAFETY: the flag above defines this nested value; mutate the snapshot to
		// verify it cannot change the store or a later snapshot.
		const value = snapshot.data.defaultValue as { nested: { value: string } };
		value.nested.value = "changed";
		expect(flags.port.get("config")?.defaultValue).toEqual({
			nested: { value: "original" },
		});
		expect(flags.inspector?.events()[0]?.data.defaultValue).toEqual({
			nested: { value: "original" },
		});
	});

	it("uses the shared flag port for changes, evaluation, tenant isolation, and kill switches", async () => {
		const harness = createTestHarness();
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		try {
			const flags = graph.flag("flags");
			flags.define({
				key: "checkout",
				percentage: 100,
				metadata: { tenant: "acme" },
			});
			const client = createLocalFeatureClient(flags, {
				tenant: "acme",
				userId: "alice",
			});
			expect(client.getBooleanValue("checkout")).toBe(true);
			expect(
				flags.evaluateBoolean("checkout", {
					targetingKey: "alice",
					tenant: "other",
				}).value,
			).toBe(false);
			expect(graph.flag("other").get("checkout")).toBeUndefined();
			expect(
				graph
					.flagInspector("flags")
					?.events()
					.some((event) => event.type === "flag.Evaluated"),
			).toBe(true);
			flags.activateKillSwitch("checkout");
			expect(client.getBooleanValue("checkout")).toBe(false);
			expect(graph.resource("flags").fidelity).toBe("simulated");
			expect(() => graph.flag("cache")).toThrowError(
				expect.objectContaining({ code: "HARNESS_EMULATOR_UNAVAILABLE" }),
			);
		} finally {
			await harness.destroy(bindle)();
		}
	});

	it("accepts a structural replacement, closes it, and starts fresh on redeploy", async () => {
		let closed = 0;
		const harness = createTestHarness({
			emulators: {
				flag: () => {
					const real = createFlagEmulator().port;
					const port: FeatureFlagPort = {
						get rulesetSeq() {
							return real.rulesetSeq;
						},
						list: () => real.list(),
						get: (key) => real.get(key),
						define: (input) => real.define(input),
						loadDefinitions: (defs) => real.loadDefinitions(defs),
						evaluateBoolean: (key, context, fallback) =>
							real.evaluateBoolean(key, context, fallback),
						evaluate: (key, context, fallback) =>
							real.evaluate(key, context, fallback),
						activateKillSwitch: (key, actor) =>
							real.activateKillSwitch(key, actor),
						clearKillSwitch: (key) => real.clearKillSwitch(key),
						archive: (key) => real.archive(key),
					};
					return {
						port,
						fidelity: "mocked",
						close: () => {
							closed += 1;
						},
					};
				},
			},
		});
		const bindle = app();
		let graph = await harness.deploy(bindle)();
		graph.flag("flags").define({ key: "checkout" });
		expect(
			createLocalFeatureClient(graph.flag("flags")).getBooleanValue("checkout"),
		).toBe(true);
		expect(graph.flagInspector("flags")).toBeUndefined();
		expect(graph.fidelity().prodReadinessClaimable).toBe(false);
		await harness.destroy(bindle)();
		graph = await harness.deploy(bindle)();
		try {
			expect(graph.flag("flags").get("checkout")).toBeUndefined();
		} finally {
			await harness.destroy(bindle)();
		}
		expect(closed).toBe(4);
	});

	it("refuses an incomplete replacement and closes resources it returned", async () => {
		let closed = 0;
		const harness = createTestHarness({
			emulators: {
				flag: () => ({
					// SAFETY: exercise the runtime boundary with a malformed JavaScript factory.
					port: {} as FeatureFlagPort,
					fidelity: "mocked",
					close: () => {
						closed += 1;
					},
				}),
			},
		});
		await expect(harness.deploy(app())()).rejects.toMatchObject({
			code: "HARNESS_EMULATOR_INVALID",
		});
		expect(closed).toBe(1);
	});
});
