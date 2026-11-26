import { describe, expect, it } from "vitest";

import {
	declareExperiment,
	featureSpecsToStoreInputs,
	features,
	rollout,
} from "../src/index.js";

describe("Bindle features / experiment / rollout IfC", () => {
	it("features() is zero-config friendly and content-hashed", () => {
		const decl = features({
			"new-checkout-flow": {
				state: "ENABLED",
				variants: { control: false, treatment: true },
				defaultVariant: "control",
				targeting: {
					fractional: {
						key: ["identity.userId"],
						variants: [{ treatment: 10 }, { control: 90 }],
					},
				},
				metadata: { owner: "payments" },
			},
			"simple-flag": {},
		});
		expect(decl.schemaVersion).toContain("bindle-features");
		expect(decl.contentHash.startsWith("sha256:")).toBe(true);
		const inputs = featureSpecsToStoreInputs(decl);
		expect(inputs).toHaveLength(2);
		expect(inputs.find((i) => i.key === "simple-flag")?.state).toBe("ENABLED");
	});

	it("experiment + rollout declarations parse", () => {
		const exp = declareExperiment("checkout-exp", {
			flag: "new-checkout-flow",
			variants: ["control", "treatment"],
			metrics: ["conversion"],
		});
		expect(exp.name).toBe("checkout-exp");
		const ro = rollout({
			name: "checkout-canary",
			flag: "new-checkout-flow",
			stages: [
				{ percent: 5, duration: "1h", analysis: { golden: true } },
				{ percent: 100 },
			],
			traffic: "gateway-weighted",
			autoRollback: true,
		});
		expect(ro.spec.autoRollback).toBe(true);
		expect(ro.spec.stages).toHaveLength(2);
	});

	it("featureSpecsToStoreInputs is consumable by FeatureFlagStore.define layout", () => {
		const decl = features({
			promo: {
				state: "ENABLED",
				percentage: 100,
				variants: { control: false, treatment: true },
				defaultVariant: "treatment",
			},
		});
		const inputs = featureSpecsToStoreInputs(decl);
		const promo = inputs.find((i) => i.key === "promo");
		expect(promo?.defaultValue).toBe(true);
		expect(promo?.defaultVariant).toBe("treatment");
		expect(promo?.percentage).toBe(100);
	});
});
