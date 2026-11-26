/**
 * Two concerns as data, and one thing that is genuinely not a concern.
 *
 * `runner.*` is a namespace of factories and `dispatcher()` is a function, so
 * both are case files. The last test is a cross-package integration — it feeds
 * the declaration into `@hobo/dispatcher`'s real engine — and that is a
 * sequence, not an input/output pair, so it stays hand-written.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeConcern } from "@hobo/contract-harness";
import { decideDispatch } from "@hobo/dispatcher";
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
	it("feeds decideDispatch and records dispatch.Decided", () => {
		// The walkthrough §5.2 fleet: cost-routed CI runners.
		const fleet = dispatcher({ objective: "min-cost" }, [
			runner.selfHosted({ behind: "relay" }),
			runner.github({ listUnitCost: 2 }),
			runner.depot({ listUnitCost: 3 }),
			runner.blacksmith({ listUnitCost: 4 }),
		]);
		const decision = decideDispatch({
			category: "runner",
			objective: fleet.engineObjective,
			dispatchId: "ci-job-1",
			registry: fleet.registry,
			ledgerView: { view: "CreditLedgerView", seq: 0, accounts: [] },
		});
		// The positive shape cannot be a case: `dispatcher` refuses candidates it
		// cannot see were authored by `runner.*`, so its input has to be built
		// rather than written down. The refusals are data; this is not.
		expect(fleet.schema).toBe(DISPATCHER_DECLARATION_SCHEMA);
		expect(fleet.engineObjective).toBe("maximize-credits");
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
