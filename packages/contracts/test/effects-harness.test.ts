import { must } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import {
	captureContractEffects,
	createEffectIsolation,
	dualFixturesForEffects,
	filterPureContracts,
	runResilienceFaultInjection,
} from "../src/effects-harness.js";
import {
	createBoundaryContract,
	createResilienceProfile,
	pureEffects,
} from "../src/index.js";

describe("effect-aware harness", () => {
	it("isolates pure contracts with zero infrastructure", () => {
		const pure = createBoundaryContract({
			id: "pure-math",
			effects: pureEffects(),
		});
		const report = createEffectIsolation(pure);
		expect(report.pure).toBe(true);
		expect(report.isolationMode).toBe("zero-infra");
		expect(report.mocks).toHaveLength(0);
	});

	it("generates domain mocks for network contracts", () => {
		const net = createBoundaryContract({
			id: "orders-http",
			effects: {
				purity: "varies",
				capabilities: ["decides", "suspends"],
				domains: ["network", "externalCall"],
			},
		});
		const report = createEffectIsolation(net);
		expect(report.isolationMode).toBe("domain-mocked");
		expect(report.mocks.map((m) => m.domain).sort()).toEqual([
			"externalCall",
			"network",
		]);
		const dual = dualFixturesForEffects(must(net.effects));
		expect(dual.purePath.infrastructure).toBe("none");
		expect(dual.effectPath.mocks.length).toBeGreaterThan(0);
	});

	it("filters pure contracts", () => {
		const contracts = [
			createBoundaryContract({ id: "a", effects: pureEffects() }),
			createBoundaryContract({
				id: "b",
				effects: {
					purity: "varies",
					capabilities: ["decides"],
					domains: ["storage"],
				},
			}),
		];
		expect(filterPureContracts(contracts).map((c) => c.id)).toEqual(["a"]);
	});

	it("fault injection never retries policy.Decided", async () => {
		const contract = createBoundaryContract({
			effects: {
				purity: "varies",
				capabilities: ["decides"],
				domains: ["network"],
			},
			resilience: createResilienceProfile({ id: "net-retry" }),
		});
		const result = await runResilienceFaultInjection({
			contract,
			failures: [
				{ attempt: 1, failureClass: "policy.Decided", message: "deny" },
			],
		});
		expect(result.attempts).toBe(1);
		expect(result.neverRetriedPolicyOrTerminal).toBe(true);
	});

	it("captures effects for replay inspection without re-execution", () => {
		const contract = createBoundaryContract({
			effects: {
				purity: "varies",
				capabilities: ["decides"],
				domains: ["eventEmit"],
			},
		});
		const cap = captureContractEffects(contract);
		expect(cap.facts).toHaveLength(2);
		expect(cap.inspect()).toHaveLength(2);
	});
});
