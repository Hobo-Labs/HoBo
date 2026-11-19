import { describe, expect, it } from "vitest";
import {
	createHarness,
	FeatureFlagStore,
	OpenDeliveryEngine,
} from "../src/index.js";

describe("kill-switch restoration", () => {
	it.each([
		0, 30, 100,
	])("restores the configured %i%% ramp across repeated activation and clear", (percentage) => {
		const store = new FeatureFlagStore();
		store.define({
			key: "flag",
			percentage,
			defaultVariant: "control",
			variants: { control: false, treatment: true },
		});
		store.activateKillSwitch("flag");
		store.activateKillSwitch("flag");
		expect(store.get("flag")?.percentage).toBe(0);
		expect(store.evaluate("flag", { targetingKey: "subject" }).reason).toBe(
			"kill-switch",
		);
		expect(store.clearKillSwitch("flag")?.percentage).toBe(percentage);
		expect(store.clearKillSwitch("flag")?.percentage).toBe(percentage);
	});

	it("keeps explicit changes made while the switch is active for the next clear", () => {
		const store = new FeatureFlagStore();
		store.define({ key: "flag", percentage: 10 });
		store.activateKillSwitch("flag");
		store.define({ key: "flag", percentage: 45 });
		expect(store.get("flag")?.percentage).toBe(0);
		expect(store.get("flag")?.killSwitch).toBe(true);
		expect(store.clearKillSwitch("flag")?.percentage).toBe(45);
	});

	it("keeps rollout progress dark while switched and restores the latest stage", () => {
		const store = new FeatureFlagStore();
		store.define({ key: "flag", percentage: 10 });
		store.activateKillSwitch("flag");
		const harness = createHarness({ store });
		const run = harness.startProgressive({
			rollout: {
				name: "flag-rollout",
				flag: "flag",
				stages: [{ percent: 25 }, { percent: 50 }],
				traffic: "flag-only",
				autoRollback: true,
			},
		});
		harness.advance(run.rolloutId);
		expect(store.get("flag")?.percentage).toBe(0);
		expect(store.clearKillSwitch("flag")?.percentage).toBe(50);
	});

	it("does not enable a disabled flag while activating or clearing the switch", () => {
		const store = new FeatureFlagStore();
		store.define({
			key: "flag",
			enabled: false,
			state: "DISABLED",
			percentage: 0,
		});
		store.activateKillSwitch("flag");
		expect(store.get("flag")?.enabled).toBe(false);
		expect(store.get("flag")?.state).toBe("DISABLED");
		store.clearKillSwitch("flag");
		expect(store.get("flag")?.enabled).toBe(false);
		expect(store.get("flag")?.percentage).toBe(0);
	});

	it("preserves the suspended percentage in snapshots and change events", () => {
		const original = new FeatureFlagStore();
		original.define({ key: "flag", percentage: 30 });
		original.activateKillSwitch("flag");
		original.define({ key: "flag", percentage: 45 });
		const snapshot = original.get("flag");
		expect(snapshot?.percentage).toBe(0);
		expect(snapshot?.suspendedPercentage).toBe(45);
		expect(original.events.at(-1)?.data.suspendedPercentage).toBe(45);
		if (!snapshot) throw new Error("missing snapshot");
		const restored = new FeatureFlagStore();
		restored.loadDefinitions([snapshot]);
		expect(restored.get("flag")?.percentage).toBe(0);
		expect(restored.clearKillSwitch("flag")?.percentage).toBe(45);
	});

	it("keeps a legacy killed snapshot at 0% when its prior ramp is unavailable", () => {
		const restored = new FeatureFlagStore();
		restored.loadDefinitions([
			{ key: "flag", percentage: 0, killSwitch: true },
		]);
		expect(restored.clearKillSwitch("flag")?.percentage).toBe(0);
	});

	it("preserves a disabled flag through zero, partial, and full rollout stages", () => {
		const store = new FeatureFlagStore();
		store.define({
			key: "flag",
			enabled: false,
			state: "DISABLED",
			percentage: 0,
		});
		const delivery = new OpenDeliveryEngine({ store });
		const rollout = delivery.start({
			name: "flag-rollout",
			flag: "flag",
			stages: [{ percent: 0 }, { percent: 25 }, { percent: 100 }],
			traffic: "flag-only",
			autoRollback: true,
		});
		for (const percentage of [0, 25, 100]) {
			if (percentage !== 0) delivery.step(rollout.id);
			expect(store.get("flag")).toMatchObject({
				enabled: false,
				state: "DISABLED",
				percentage,
			});
			expect(store.evaluate("flag", { targetingKey: "subject" }).reason).toBe(
				"disabled",
			);
		}
		const fresh = new OpenDeliveryEngine({ store }).start({
			name: "new-rollout",
			flag: "new-flag",
			stages: [{ percent: 10 }],
			traffic: "flag-only",
			autoRollback: true,
		});
		expect(fresh.percent).toBe(10);
		expect(store.get("new-flag")).toMatchObject({
			enabled: true,
			state: "ENABLED",
		});
	});
});
