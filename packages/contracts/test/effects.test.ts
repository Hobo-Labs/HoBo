import { must } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import {
	applyResilienceProfile,
	checkCompatibility,
	createBoundaryContract,
	createEffectSpec,
	createEffectTracer,
	createInMemoryEffectSink,
	createResilienceProfile,
	effectSubtype,
	effectUnion,
	formatContractDescribe,
	inspectResilienceFromFacts,
	isCompatible,
	isEffectWideningBreaking,
	isPure,
	parseEffectSpec,
	pureEffects,
	toEffectManifest,
} from "../src/index.js";

describe("EffectSpec lattice", () => {
	it("marks pure effects as isolatable", () => {
		const pure = pureEffects();
		expect(isPure(pure)).toBe(true);
		expect(pure.purity).toBe("pure");
		expect(pure.domains).toEqual([]);
	});

	it("rejects pure + network", () => {
		expect(() =>
			parseEffectSpec({
				purity: "pure",
				capabilities: [],
				domains: ["network"],
			}),
		).toThrow(/pure-forbids-domains/);
	});

	it("unions effects and supports subtyping", () => {
		const a = createEffectSpec({
			purity: "varies",
			capabilities: ["decides"],
			domains: ["storage"],
		});
		const b = createEffectSpec({
			purity: "transacts",
			capabilities: ["suspends"],
			domains: ["network"],
		});
		const u = effectUnion(a, b);
		expect(u.purity).toBe("transacts");
		expect(u.domains).toEqual(["network", "storage"]);
		expect(effectSubtype(a, u)).toBe(true);
		expect(effectSubtype(u, a)).toBe(false);
	});

	it("detects effect widening as breaking on contracts", () => {
		const prev = createBoundaryContract({
			version: "1.0.0",
			effects: {
				purity: "pure",
				capabilities: [],
				domains: [],
			},
		});
		const next = createBoundaryContract({
			version: "1.1.0",
			effects: {
				purity: "varies",
				capabilities: ["decides"],
				domains: ["network"],
			},
		});
		const result = checkCompatibility(prev, next);
		expect(isCompatible(result)).toBe(false);
		if (result.kind === "breaking") {
			expect(result.reasons.some((r) => r.code === "effect-widened")).toBe(
				true,
			);
		}
		expect(
			isEffectWideningBreaking(
				must(prev.effects, "prev.effects"),
				must(next.effects, "next.effects"),
			),
		).toBe(true);
	});

	it("exports EffectManifest and captures facts without re-execution", () => {
		const contract = createBoundaryContract({
			effects: {
				purity: "varies",
				capabilities: ["decides"],
				domains: ["network"],
			},
		});
		const manifest = toEffectManifest({
			contractId: contract.id,
			contractVersion: contract.version,
			channel: contract.edge.channel,
			effects: must(contract.effects, "contract.effects"),
		});
		expect(manifest.requiresNetwork).toBe(true);
		expect(manifest.isPure).toBe(false);

		const sink = createInMemoryEffectSink();
		const tracer = createEffectTracer(sink);
		tracer.declare({
			contractId: contract.id,
			channel: contract.edge.channel,
			effects: must(contract.effects, "contract.effects"),
			at: "t0",
		});
		tracer.invoked({
			contractId: contract.id,
			channel: contract.edge.channel,
			effects: must(contract.effects, "contract.effects"),
			at: "t1",
		});
		expect(sink.facts()).toHaveLength(2);
		// Replay inspection: same facts, no new invoke
		expect(sink.facts().map((f) => f.type)).toEqual([
			"contract.EffectDeclared",
			"contract.EffectInvoked",
		]);
	});
});

describe("ResilienceProfile applicator", () => {
	it("retries transient failures under deterministic schedule", async () => {
		const profile = createResilienceProfile({
			id: "retry-net",
			strategies: [
				{
					kind: "retry",
					seed: "seed-a",
					maxAttempts: 3,
					baseDelayMs: 5,
					maxDelayMs: 50,
					retryOn: "transient-only",
				},
			],
		});
		let calls = 0;
		const result = await applyResilienceProfile({
			profile,
			now: () => "2026-07-27T00:00:00.000Z",
			op: () => {
				calls += 1;
				if (calls < 3) {
					throw { failureClass: "transient", message: "flaky" };
				}
				return "ok";
			},
		});
		expect(result.ok).toBe(true);
		expect(result.value).toBe("ok");
		expect(result.attempts).toBe(3);
		expect(
			result.facts.some((f) => f.type === "resilience.Attempt" && f.retried),
		).toBe(true);
	});

	it("never retries policy.Decided deny", async () => {
		const profile = createResilienceProfile();
		const result = await applyResilienceProfile({
			profile,
			now: () => "t",
			op: () => {
				throw {
					failureClass: "policy.Decided",
					message: "denied",
					code: "policy-denied",
				};
			},
		});
		expect(result.ok).toBe(false);
		expect(result.attempts).toBe(1);
		expect(
			result.facts.every((f) => f.type !== "resilience.Attempt" || !f.retried),
		).toBe(true);
		const inspection = inspectResilienceFromFacts(result.facts);
		expect(inspection.retried).toBe(false);
		expect(inspection.terminal?.failureClass).toBe("policy.Decided");
	});

	it("never retries terminal failures", async () => {
		const profile = createResilienceProfile();
		const result = await applyResilienceProfile({
			profile,
			op: () => {
				throw { failureClass: "terminal", message: "fatal" };
			},
		});
		expect(result.attempts).toBe(1);
		expect(result.failureClass).toBe("terminal");
	});

	it("describes contract effects for CLI/MCP", () => {
		const contract = createBoundaryContract({
			effects: pureEffects(),
			resilience: createResilienceProfile({ id: "r1" }),
		});
		// pure + network-facing resilience strategies may fail validation
		// pure with default retry strategy that doesn't need network is ok
		const text = formatContractDescribe(contract);
		expect(text).toContain("purity: pure");
		expect(text).toContain("resilience:");
	});
});
