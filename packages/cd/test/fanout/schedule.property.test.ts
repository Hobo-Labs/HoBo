import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { FanoutPlan } from "../../src/fanout/policy.js";
import { type SlotState, schedule } from "../../src/fanout/schedule.js";

const slotState = fc.constantFrom<SlotState>(
	"pending",
	"in-flight",
	"succeeded",
	"failed",
	"deferred",
);
const CHECK = { seed: 614437, numRuns: 500 };

describe("CD fan-out scheduling properties", () => {
	it("only offers mandatory camps until they succeed, and offers nothing while halted or full", () => {
		fc.assert(
			fc.property(
				fc.array(slotState, { minLength: 1, maxLength: 5 }),
				fc.array(slotState, { minLength: 1, maxLength: 5 }),
				fc.integer({ min: 1, max: 6 }),
				fc.constantFrom("ALL", "PROGRESSIVE", "PROGRESSIVE_PER_GROUP"),
				fc.boolean(),
				(pilotStates, productionStates, maxConcurrency, strategy, halted) => {
					const pilot = pilotStates.map((_, index) => `pilot-${index}`);
					const production = productionStates.map(
						(_, index) => `prod-${index}`,
					);
					const campIds = [...pilot, ...production];
					const plan: FanoutPlan = {
						strategy,
						maxConcurrency,
						maxFailures: 0,
						minSuccessMs: 0,
						progressDeadlineMs: 100,
						rollbackOnHalt: false,
						groups: [
							{ name: "pilot", campIds: pilot, mandatory: true },
							{ name: "production", campIds: production, mandatory: false },
						],
						campIds,
					};
					const states = [...pilotStates, ...productionStates];
					const slots = new Map(
						campIds.map((campId, index) => {
							const state = states[index];
							if (state === undefined)
								throw new Error("missing generated state");
							return [campId, { campId, state }] as const;
						}),
					);
					const result = schedule(plan, slots, { halted, catchUp: false });
					const active = states.filter((state) => state === "in-flight").length;
					expect(result.free).toBe(Math.max(0, maxConcurrency - active));
					expect(new Set(result.candidates).size).toBe(
						result.candidates.length,
					);
					for (const campId of result.candidates) {
						expect(["pending", "deferred"]).toContain(slots.get(campId)?.state);
					}
					if (
						halted ||
						active >= maxConcurrency ||
						pilotStates.includes("failed")
					)
						expect(result.candidates).toEqual([]);
					if (pilotStates.some((state) => state !== "succeeded"))
						expect(
							result.candidates.every((campId) => pilot.includes(campId)),
						).toBe(true);
				},
			),
			CHECK,
		);
	});
});

it("keeps mandatory gating during catch-up and treats missing slots as pending", () => {
	const maybeState = fc.option(slotState, { nil: undefined });
	fc.assert(
		fc.property(
			fc.array(maybeState, { minLength: 1, maxLength: 5 }),
			fc.array(maybeState, { minLength: 1, maxLength: 5 }),
			fc.integer({ min: 1, max: 6 }),
			fc.boolean(),
			fc.boolean(),
			(pilotStates, productionStates, maxConcurrency, catchUp, halted) => {
				const pilot = pilotStates.map((_, index) => `pilot-${index}`);
				const production = productionStates.map((_, index) => `prod-${index}`);
				const campIds = [...pilot, ...production];
				const states = [...pilotStates, ...productionStates];
				const plan: FanoutPlan = {
					strategy: "PROGRESSIVE_PER_GROUP",
					maxConcurrency,
					maxFailures: 0,
					minSuccessMs: 0,
					progressDeadlineMs: 100,
					rollbackOnHalt: false,
					groups: [
						{ name: "pilot", campIds: pilot, mandatory: true },
						{ name: "production", campIds: production, mandatory: false },
					],
					campIds,
				};
				const slots = new Map<string, { campId: string; state: SlotState }>();
				for (const [index, campId] of campIds.entries()) {
					const state = states[index];
					if (state !== undefined) slots.set(campId, { campId, state });
				}
				const result = schedule(plan, slots, { halted, catchUp });
				const expectedComplete = states.every(
					(state) =>
						state !== undefined && state !== "pending" && state !== "in-flight",
				);
				expect(result.complete).toBe(expectedComplete);
				if (pilotStates.some((state) => state !== "succeeded")) {
					expect(result.mandatoryGate).toBe(true);
					expect(
						result.candidates.every((campId) => pilot.includes(campId)),
					).toBe(true);
				}
				if (halted) expect(result.candidates).toEqual([]);
			},
		),
		{ seed: 614452, numRuns: 500 },
	);
});

it("stops all new starts after a mandatory failure in either mode", () => {
	fc.assert(
		fc.property(fc.boolean(), fc.boolean(), (catchUp, failFirst) => {
			const plan: FanoutPlan = {
				strategy: "PROGRESSIVE_PER_GROUP",
				maxConcurrency: 3,
				maxFailures: 3,
				minSuccessMs: 0,
				progressDeadlineMs: 100,
				rollbackOnHalt: false,
				groups: [
					{ name: "pilot", campIds: ["pilot"], mandatory: true },
					{ name: "canary", campIds: ["canary"], mandatory: true },
					{ name: "production", campIds: ["production"], mandatory: false },
				],
				campIds: ["pilot", "canary", "production"],
			};
			const slots = new Map<string, { campId: string; state: SlotState }>([
				[
					"pilot",
					{ campId: "pilot", state: failFirst ? "failed" : "deferred" },
				],
				[
					"canary",
					{ campId: "canary", state: failFirst ? "deferred" : "failed" },
				],
				["production", { campId: "production", state: "deferred" }],
			]);
			const result = schedule(plan, slots, { halted: false, catchUp });
			expect(result.mandatoryFailed).toBe(true);
			expect(result.candidates).toEqual([]);
		}),
		{ seed: 614453, numRuns: 100 },
	);
});
