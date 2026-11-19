import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeConcern } from "@hobo/contract-harness";
import { decideCreditDispatch } from "@hobo/dispatcher";
import { describe, expect, it } from "vitest";
import * as sdkDispatcher from "../src/dispatcher.js";
import { dispatcher, runner } from "../src/dispatcher.js";
import { DISPATCHER_DECLARATION_SCHEMA } from "../src/schema.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

describeConcern("runner", {
	subject: () => runner,
	cases: path.join(dir, "runner.cases.jsonl"),
});

describeConcern("dispatcher", {
	subject: () => sdkDispatcher,
	cases: path.join(dir, "dispatcher.cases.jsonl"),
});

describe("the declaration the engine actually consumes", () => {
	it.each([
		["min-cost", "cheap"],
		["maximize-credits", "credited"],
	] as const)("honors the %s objective", (objective, selectedProvider) => {
		const fleet = dispatcher({ objective }, [
			runner.github({ id: "cheap", listUnitCost: 1 }),
			runner.depot({ id: "credited", listUnitCost: 10 }),
		]);
		const decision = decideCreditDispatch({
			category: "runner",
			objective: fleet.objective,
			dispatchId: "job-objective",
			units: 10,
			registry: fleet.registry,
			ledgerView: {
				view: "CreditLedgerView",
				seq: 0,
				accounts: [
					{ providerId: "cheap", dimension: "runner.minutes", freeHeadroom: 0 },
					{
						providerId: "credited",
						dimension: "runner.minutes",
						freeHeadroom: 1,
					},
				],
			},
		});
		expect(decision.selectedProvider).toBe(selectedProvider);
	});

	it("feeds decideCreditDispatch and records dispatch.Decided", () => {
		const fleet = dispatcher({ objective: "min-cost" }, [
			runner.selfHosted({ behind: "relay" }),
			runner.github({ listUnitCost: 2 }),
			runner.depot({ listUnitCost: 3 }),
			runner.blacksmith({ listUnitCost: 4 }),
		]);
		const decision = decideCreditDispatch({
			category: "runner",
			objective: fleet.objective,
			dispatchId: "ci-job-1",
			registry: fleet.registry,
			ledgerView: { view: "CreditLedgerView", seq: 0, accounts: [] },
		});
		expect(fleet.schema).toBe(DISPATCHER_DECLARATION_SCHEMA);
		expect(fleet.objective).toBe("min-cost");
		expect(Object.isFrozen(fleet.runners)).toBe(true);
		expect(fleet.registry.records).toHaveLength(4);
		expect(fleet.registry.byCategory.get("runner")).toHaveLength(4);

		expect(decision.ok).toBe(true);
		expect(decision.selectedProvider).toBe("runner.self-hosted");
		expect(decision.dispatchEvent.type).toBe("dispatch.Decided");
		expect(
			decision.dispatchEvent.data.candidates.map(
				(candidate: { provider: string }) => candidate.provider,
			),
		).toContain("runner.github");
	});
});
