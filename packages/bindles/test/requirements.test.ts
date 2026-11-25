import { describe, expect, it } from "vitest";

import {
	assertNoBindleProviderSelection,
	BINDLE_PROVIDER_SELECTION_FORBIDDEN,
	bindle,
	parseBindleRequirements,
} from "../src/index.js";

describe("bindle requirements + provider selection rejection", () => {
	it("accepts provider-neutral requirements", () => {
		const shop = bindle(
			"shop",
			{
				require: ["managed-http-runtime"],
				prefer: ["scale-to-zero"],
				runtimes: ["wasm"],
				labels: { workload: "customer-facing" },
			},
			(b) => {
				const api = b.api(() => "ok");
				return { api };
			},
		);
		expect(shop.requirements.require).toContain("managed-http-runtime");
		expect(shop.requirements.runtimes).toContain("wasm");
		expect(() => assertNoBindleProviderSelection(shop)).not.toThrow();
	});

	it("rejects provider key on requirements", () => {
		expect(() => parseBindleRequirements({ provider: "azure" })).toThrow(
			/bindle-provider-selection-forbidden/,
		);
	});

	it("rejects cloud provider annotations at collection", () => {
		expect(() =>
			bindle("shop", (b) => {
				const api = b
					.api(() => "ok")
					.with({
						provider: "azure",
						option: "containerApp",
						config: {},
					});
				return { api };
			}),
		).toThrow(new RegExp(BINDLE_PROVIDER_SELECTION_FORBIDDEN));
	});

	it("allows platform env annotations", () => {
		const shop = bindle("shop", (b) => {
			const api = b
				.api(() => "ok")
				.with({
					provider: "hobo",
					option: "env",
					config: { FOO: "bar" },
				});
			return { api };
		});
		// App Kit default session-replay comes first; env is appended via .with.
		expect(
			shop.resources.api?.annotations.some((a) => a.option === "env"),
		).toBe(true);
		expect(
			shop.resources.api?.annotations.some(
				(a) => a.option === "session-replay",
			),
		).toBe(true);
	});
});
