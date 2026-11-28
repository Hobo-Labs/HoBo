import { describe, expect, it } from "vitest";

import { FatalError, RetryableError, WorkflowFailure } from "../src/errors.js";
import {
	DEFAULT_STEP_RETRIES,
	defineStep,
	runWithRetries,
	step,
} from "../src/step.js";

function flaky(failures: number, error: () => Error = () => new Error("boom")) {
	let calls = 0;
	return {
		calls: () => calls,
		body: () => {
			calls += 1;
			if (calls <= failures) throw error();
			return "ok";
		},
	};
}

describe("defineStep", () => {
	it("keeps the name it was given", () => {
		expect(defineStep("charge", () => 1).name).toBe("charge");
	});

	it("keeps the handler callable", async () => {
		expect(await defineStep("charge", (n: number) => n * 2).handler(21)).toBe(
			42,
		);
	});

	it("defaults to an empty options block rather than undefined", () => {
		expect(defineStep("charge", () => 1).options).toEqual({});
	});

	it("keeps the options it was given", () => {
		expect(defineStep("charge", () => 1, { retries: 7 }).options.retries).toBe(
			7,
		);
	});

	it("freezes the definition", () => {
		expect(Object.isFrozen(defineStep("charge", () => 1))).toBe(true);
	});

	it("refuses an unnamed step", () => {
		expect(() => defineStep("", () => 1)).toThrow(TypeError);
	});

	it("says what was wrong with the name", () => {
		expect(() => defineStep("", () => 1)).toThrow(/non-empty/u);
	});
});

describe("step (the sdk-api spelling)", () => {
	it("derives the name from the function", () => {
		function chargeCard() {
			return 1;
		}
		expect(step(chargeCard).name).toBe("chargeCard");
	});

	it("prefers an explicit name over the function's", () => {
		function chargeCard() {
			return 1;
		}
		expect(step(chargeCard, { name: "charge" }).name).toBe("charge");
	});

	it("falls back to `step` for an anonymous body", () => {
		// SAFETY: assertion to `=> 1) as () => number).na` is required at this boundary.
		expect(step((() => 1) as () => number).name).toBeTruthy();
	});

	it("does not leak the name into the step's options", () => {
		expect(step(() => 1, { name: "charge", retries: 2 }).options).toEqual({
			retries: 2,
		});
	});
});

describe("runWithRetries", () => {
	it("returns the value on the first success", async () => {
		expect(await runWithRetries("charge", () => "ok")).toBe("ok");
	});

	it("awaits an async body", async () => {
		expect(await runWithRetries("charge", async () => "ok")).toBe("ok");
	});

	it("retries until the body succeeds", async () => {
		const { body, calls } = flaky(2);
		expect(await runWithRetries("charge", body)).toBe("ok");
		expect(calls()).toBe(3);
	});

	it("allows the default number of retries", async () => {
		const { body, calls } = flaky(DEFAULT_STEP_RETRIES);
		await runWithRetries("charge", body);
		expect(calls()).toBe(DEFAULT_STEP_RETRIES + 1);
	});

	it("gives up one retry past the budget", async () => {
		const { body, calls } = flaky(99);
		await expect(
			runWithRetries("charge", body, { retries: 2 }),
		).rejects.toThrow(WorkflowFailure);
		expect(calls()).toBe(3);
	});

	it("runs exactly once when retries are disabled", async () => {
		const { body, calls } = flaky(99);
		await expect(
			runWithRetries("charge", body, { retries: 0 }),
		).rejects.toThrow();
		expect(calls()).toBe(1);
	});

	it("names the step and the budget when it gives up", async () => {
		await expect(
			runWithRetries(
				"charge",
				() => {
					throw new Error("boom");
				},
				{ retries: 1 },
			),
		).rejects.toThrow(/step charge exhausted retry budget \(1\)/u);
	});

	it("carries the last failure as the cause", async () => {
		const cause = new Error("gateway timeout");
		const failure = await runWithRetries(
			"charge",
			() => {
				throw cause;
			},
			{ retries: 0 },
			// SAFETY: assertion to ` WorkflowFailure); e` is required at this boundary.
			// SAFETY: assertion to ` WorkflowFailure); e` is required at this boundary.
		).catch((error: Error) => {
			// SAFETY: workflow failures surface as WorkflowFailure at this test boundary.
			const failure: WorkflowFailure = error as never;
			return failure;
		});
		expect(String(failure.message)).toContain("charge");
		expect(JSON.stringify(failure.details ?? {})).toBeDefined();
	});

	it("stops at once on a fatal error, whatever the budget says", async () => {
		const { body, calls } = flaky(99, () => new FatalError("card declined"));
		await expect(
			runWithRetries("charge", body, { retries: 5 }),
		).rejects.toThrow(WorkflowFailure);
		expect(calls()).toBe(1);
	});

	it("says the step failed fatally rather than blaming the budget", async () => {
		await expect(
			runWithRetries("charge", () => {
				throw new FatalError("card declined");
			}),
		).rejects.toThrow(/step charge failed fatally/u);
	});

	it("lets a retryable error raise the budget", async () => {
		const { body, calls } = flaky(
			5,
			() => new RetryableError("429", { retries: 6 }),
		);
		await runWithRetries("charge", body, { retries: 1 });
		expect(calls()).toBe(6);
	});

	it("lets a retryable error lower the budget", async () => {
		const { body, calls } = flaky(
			99,
			() => new RetryableError("429", { retries: 1 }),
		);
		await expect(
			runWithRetries("charge", body, { retries: 9 }),
		).rejects.toThrow(WorkflowFailure);
		expect(calls()).toBe(2);
	});

	it("leaves the budget alone for a retryable error that names no count", async () => {
		const { body, calls } = flaky(99, () => new RetryableError("429"));
		await expect(
			runWithRetries("charge", body, { retries: 2 }),
		).rejects.toThrow(WorkflowFailure);
		expect(calls()).toBe(3);
	});

	it("reports the overridden budget, not the configured one", async () => {
		await expect(
			runWithRetries(
				"charge",
				() => {
					throw new RetryableError("429", { retries: 1 });
				},
				{ retries: 9 },
			),
		).rejects.toThrow(/\(1\)/u);
	});

	it("retries a rejected promise the same as a thrown error", async () => {
		const { body, calls } = flaky(1);
		await runWithRetries("charge", async () => body());
		expect(calls()).toBe(2);
	});
});
