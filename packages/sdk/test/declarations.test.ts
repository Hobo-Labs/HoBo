import { describe, expect, it } from "vitest";

import {
	CHAOS_SCHEMA,
	chaos,
	GENERATE_PROVIDER_SCHEMA,
	generateProvider,
	RUNBOOK_SCHEMA,
	runbook,
	SdkDeclarationError,
	WAIVER_SCHEMA,
	waiver,
} from "../src/index.js";

describe("waiver (walkthrough §4.6)", () => {
	const breakGlass = waiver("pol_7f31", {
		reason: "EU capacity incident; temporary US failover, approved by IR.",
		approver: "role:security-admin",
		expires: "2026-07-01T00:00:00Z",
	});

	it("produces a frozen, schema-versioned declaration", () => {
		expect(Object.isFrozen(breakGlass)).toBe(true);
		expect(breakGlass.schema).toBe(WAIVER_SCHEMA);
		expect(breakGlass.decisionId).toBe("pol_7f31");
		expect(breakGlass.approver).toBe("role:security-admin");
	});

	it("rejects an approver without a principal prefix (SoD)", () => {
		expect(() =>
			waiver("pol_1", {
				reason: "r",
				approver: "security-admin",
				expires: "2026-07-01T00:00:00Z",
			}),
		).toThrow(SdkDeclarationError);
	});

	it("rejects a non-timestamp expiry", () => {
		expect(() =>
			waiver("pol_1", {
				reason: "r",
				approver: "role:security-admin",
				expires: "next tuesday-ish",
			}),
		).toThrow(SdkDeclarationError);
	});

	it("rejects an empty reason", () => {
		expect(() =>
			waiver("pol_1", {
				reason: "",
				approver: "role:security-admin",
				expires: "2026-07-01T00:00:00Z",
			}),
		).toThrow(SdkDeclarationError);
	});
});

describe("chaos (walkthrough §6.4)", () => {
	const experiment = chaos("db-failover-holds-checkout-slo", {
		steadyState: "slo:checkout.latency",
		inject: { fault: "provider-degraded", target: "db@prod-azure" },
		blastRadius: "1 camp",
		abortIf: "slo:photos.availability < 99.9%",
	});

	it("produces a frozen typed hypothesis", () => {
		expect(Object.isFrozen(experiment)).toBe(true);
		expect(Object.isFrozen(experiment.inject)).toBe(true);
		expect(experiment.schema).toBe(CHAOS_SCHEMA);
		expect(experiment.steadyState).toBe("slo:checkout.latency");
		expect(experiment.blastRadius).toBe("1 camp");
		expect(experiment.abortIf).toBe("slo:photos.availability < 99.9%");
	});

	it("rejects a missing injection target", () => {
		expect(() =>
			chaos("x", {
				steadyState: "slo:a",
				inject: { fault: "provider-degraded", target: "" },
				blastRadius: "1 camp",
			}),
		).toThrow(SdkDeclarationError);
	});

	it("rejects a missing blast radius", () => {
		expect(() =>
			chaos("x", {
				steadyState: "slo:a",
				inject: { fault: "f", target: "t" },
				blastRadius: "",
			}),
		).toThrow(SdkDeclarationError);
	});
});

describe("runbook (walkthrough §6.2)", () => {
	const highFive = runbook("high-5xx-on-api", {
		on: { alert: "api.5xx-burst", severity: ">=SEV2" },
		diagnose: ["logs api", "drift api", "slo checkout.latency"],
		fix: [
			{
				when: "provider-degraded",
				do: "failover",
				camp: "staging-cf",
				gate: "auto",
			},
			{ when: "capacity-exhausted", do: "scale", to: { min: 6 }, gate: "auto" },
			{ when: "unknown", do: "escalate", to: "on-call" },
		],
	});

	it("produces a frozen trigger → diagnosis → gated fixes declaration", () => {
		expect(Object.isFrozen(highFive)).toBe(true);
		expect(highFive.schema).toBe(RUNBOOK_SCHEMA);
		expect(highFive.on).toEqual({ alert: "api.5xx-burst", severity: ">=SEV2" });
		expect(highFive.diagnose).toHaveLength(3);
		expect(highFive.fix[0]).toEqual({
			when: "provider-degraded",
			do: "failover",
			gate: "auto",
			args: { camp: "staging-cf" },
		});
		expect(highFive.fix[1]?.args).toEqual({ to: { min: 6 } });
	});

	it("defaults an ungated fix step to require-approval (fail closed)", () => {
		expect(highFive.fix[2]?.gate).toBe("require-approval");
	});

	it("rejects an empty diagnosis", () => {
		expect(() =>
			runbook("x", {
				on: { alert: "a" },
				diagnose: [],
				fix: [{ when: "w", do: "escalate" }],
			}),
		).toThrow(SdkDeclarationError);
	});

	it("rejects an unknown gate", () => {
		expect(() =>
			runbook("x", {
				on: { alert: "a" },
				diagnose: ["logs api"],
				fix: [{ when: "w", do: "failover", gate: "yolo" as never }],
			}),
		).toThrow(SdkDeclarationError);
	});
});

describe("generateProvider (walkthrough §2.1)", () => {
	it("produces a frozen generation request with the fixed pipeline", async () => {
		const request = await generateProvider(
			"https://niche-eu-cloud.example.com/docs",
		);
		expect(Object.isFrozen(request)).toBe(true);
		expect(request.schema).toBe(GENERATE_PROVIDER_SCHEMA);
		expect(request.docsUrl).toBe("https://niche-eu-cloud.example.com/docs");
		expect(request.pipeline).toEqual([
			"scaffold",
			"llm-fill",
			"sandbox-conformance",
			"sign",
		]);
	});

	it("rejects a non-URL", async () => {
		await expect(generateProvider("not a url")).rejects.toThrow(
			SdkDeclarationError,
		);
	});

	it("rejects a non-http(s) scheme", async () => {
		await expect(generateProvider("ftp://docs.example.com")).rejects.toThrow(
			SdkDeclarationError,
		);
	});
});
