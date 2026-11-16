import { featureSpecsToStoreInputs, features } from "@hobo/bindles";
import {
	createHarness,
	createLocalFeatureClient,
	FeatureFlagStore,
} from "@hobo/identity";
import { describe, expect, it } from "vitest";
import { createFeatureCommand } from "../src/feature-command.js";
import { isJsonBoolean, isJsonObject, type JsonObject } from "../src/json.js";

function runInput(args: string[], flags: JsonObject = {}) {
	return {
		args,
		flags,
		context: { cwd: "/tmp", projectDir: "/tmp" },
		emitProgress: () => {},
	};
}

describe("hobo feature (OpenFeature observe)", () => {
	it("list / set / eval / kill against an injected store", async () => {
		const store = new FeatureFlagStore();
		const cmd = createFeatureCommand({ store, env: {} });

		const set = await cmd.run(
			// SAFETY: assertion required at this I/O or test boundary.
			runInput(["set", "checkout"], { percent: 40 }) as never,
		);
		expect(set.ok).toBe(true);
		expect(store.get("checkout")?.percentage).toBe(40);

		// SAFETY: assertion required at this I/O or test boundary.
		const list = await cmd.run(runInput(["list"]) as never);
		expect(list.ok).toBe(true);
		expect(list.data?.openFeatureOnly).toBe(true);
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			Array.isArray(list.data?.flags) &&
				list.data.flags.some(
					(flag) => isJsonObject(flag) && flag.key === "checkout",
				),
		).toBe(true);

		const evald = await cmd.run(
			// SAFETY: assertion required at this I/O or test boundary.
			runInput(["eval", "checkout"], {
				tenant: "acme",
				subject: "user:alice",
			}) as never,
		);
		expect(evald.ok).toBe(true);
		expect(evald.data?.provider).toBe("hobo-feature-flag");
		expect(isJsonBoolean(evald.data?.value)).toBe(true);

		// SAFETY: assertion required at this I/O or test boundary.
		const kill = await cmd.run(runInput(["kill", "checkout"]) as never);
		expect(kill.ok).toBe(true);
		expect(store.get("checkout")?.killSwitch).toBe(true);
	});

	it("canary and experiment status are native subcommands", async () => {
		const store = new FeatureFlagStore();
		const cmd = createFeatureCommand({ store, env: {} });
		// SAFETY: assertion required at this I/O or test boundary.
		const canary = await cmd.run(runInput(["canary"]) as never);
		expect(canary.ok).toBe(true);
		expect(canary.code).toBe("HOBO_CANARY_STATUS");
		// SAFETY: assertion required at this I/O or test boundary.
		const exp = await cmd.run(runInput(["experiment"]) as never);
		expect(exp.ok).toBe(true);
		expect(exp.code).toBe("HOBO_EXPERIMENT_STATUS");
	});

	it("Bindle features → FeatureFlagStore → OpenFeature → progressive end-to-end", () => {
		const decl = features({
			checkout: {
				state: "ENABLED",
				percentage: 0,
				variants: { control: false, treatment: true },
				defaultVariant: "control",
			},
		});
		const store = new FeatureFlagStore({ sampleRate: 1 });
		store.loadDefinitions(featureSpecsToStoreInputs(decl));
		const client = createLocalFeatureClient(store, {
			userId: "user:e2e",
			tenant: "acme",
		});
		expect(client.getBooleanValue("checkout", false)).toBe(false);

		const harness = createHarness({ store });
		const run = harness.startProgressive({
			rollout: {
				name: "checkout-canary",
				flag: "checkout",
				stages: [{ percent: 100 }],
				traffic: "gateway-weighted",
				autoRollback: true,
			},
			experiment: {
				name: "checkout-exp",
				flag: "checkout",
				variants: ["control", "treatment"],
			},
		});
		expect(run.percent).toBe(100);
		expect(run.gatewayWeightPercent).toBe(100);
		expect(run.trafficSplit?.canary).toBe(100);
		const promoted = harness.advance(run.rolloutId);
		expect(promoted.status).toBe("promoted");
		expect(client.getBooleanValue("checkout", false)).toBe(true);
	});
});
