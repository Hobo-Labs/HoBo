/**
 * The visible secondary resiliency layer (ADR-0136).
 *
 * Two guarantees carry the weight here and both are security- or
 * correctness-relevant rather than cosmetic.
 *
 * First, **never retry a `policy.Decided` deny, a terminal failure, or a
 * cancellation.** Retrying a policy denial is an authorization bypass attempt
 * dressed as resilience — it asks the same question until the answer changes.
 * Retrying a cancellation resurrects work the caller explicitly stopped. The
 * applicator enforces those three classes unconditionally, whatever the profile
 * says, and `parseNeverRetry` re-adds them even when the author left them out.
 *
 * Second, **the retry schedule is deterministic.** `computeDelay` is a pure
 * function of the seed and the attempt number, so a replay reconstructs the
 * same schedule from persisted facts without re-running the operation. A
 * `Math.random` in there would make the facts unreproducible and every replay
 * a new set of timings.
 */
import { describe, expect, it } from "vitest";

import type { EffectSpec } from "../src/effects.js";
import type { JsonObject } from "../src/json.js";
import {
	applyResilienceProfile,
	computeDelay,
	createResilienceProfile,
	type DeterministicRetryStrategy,
	inspectResilienceFromFacts,
	parseResilienceProfile,
	RESILIENCE_PROFILE_SCHEMA_VERSION,
	RESILIENCE_STRATEGY_KINDS,
	type ResilienceFact,
	ResilienceValidationError,
	validateResilienceAgainstEffects,
} from "../src/resilience.js";

const RETRY = {
	kind: "retry",
	seed: "seed-1",
	maxAttempts: 3,
	baseDelayMs: 10,
	maxDelayMs: 100,
	retryOn: "transient-only",
};

const NOW = () => "2026-08-08T00:00:00.000Z";

function codeOf(thunk: () => void): string {
	try {
		thunk();
	} catch (error) {
		expect(error).toBeInstanceOf(ResilienceValidationError);
		// SAFETY: the preceding assertion establishes the thrown domain error type.
		return (error as ResilienceValidationError).code;
	}
	// SAFETY: Vitest's unreachable assertion always throws and returns never.
	return expect.unreachable("expected a ResilienceValidationError") as never;
}

describe("parseResilienceProfile", () => {
	it("parses a minimal profile and stamps the schema version", () => {
		const profile = parseResilienceProfile({ id: "p", strategies: [RETRY] });
		expect(profile.schemaVersion).toBe(RESILIENCE_PROFILE_SCHEMA_VERSION);
		expect(profile.id).toBe("p");
		expect(profile.strategies).toHaveLength(1);
	});

	it("freezes the profile, its strategies and each strategy", () => {
		// A profile is shared across every invocation of a contract. A caller that
		// mutated `maxAttempts` in place would change the retry budget for
		// everyone else holding the same reference, with no parse step to notice.
		const profile = parseResilienceProfile({ id: "p", strategies: [RETRY] });
		expect(Object.isFrozen(profile)).toBe(true);
		expect(Object.isFrozen(profile.strategies)).toBe(true);
		expect(Object.isFrozen(profile.strategies[0])).toBe(true);
	});

	it("refuses undefined and null distinctly from a bad object", () => {
		// A dedicated `missing-profile` code, because "you passed nothing" and
		// "you passed something wrong" send an author to different places.
		expect(codeOf(() => parseResilienceProfile(undefined))).toBe(
			"missing-profile",
		);
		expect(codeOf(() => parseResilienceProfile(null))).toBe("missing-profile");
		expect(codeOf(() => parseResilienceProfile(7))).toBe("expected-object");
		expect(codeOf(() => parseResilienceProfile([]))).toBe("expected-object");
	});

	it("refuses a missing, empty or whitespace-only id", () => {
		// The id is what every emitted fact is attributed to. A blank one makes a
		// resilience fact unattributable in an incident review.
		expect(codeOf(() => parseResilienceProfile({ strategies: [RETRY] }))).toBe(
			"expected-string",
		);
		expect(
			codeOf(() => parseResilienceProfile({ id: "  ", strategies: [RETRY] })),
		).toBe("expected-string");
	});

	it("requires at least one strategy", () => {
		// A profile with no strategies is indistinguishable in behaviour from no
		// profile at all, so it is almost certainly a truncated record.
		expect(codeOf(() => parseResilienceProfile({ id: "p" }))).toBe(
			"strategies-required",
		);
		expect(
			codeOf(() => parseResilienceProfile({ id: "p", strategies: [] })),
		).toBe("strategies-required");
		expect(
			codeOf(() => parseResilienceProfile({ id: "p", strategies: {} })),
		).toBe("strategies-required");
	});

	it("parses every declared strategy kind", () => {
		const profile = parseResilienceProfile({
			id: "p",
			strategies: [
				RETRY,
				{
					kind: "circuitBreaker",
					failureThreshold: 5,
					resetTimeoutMs: 0,
					halfOpenMaxCalls: 1,
				},
				{ kind: "timeout", deadlineMs: 1000 },
				{ kind: "bulkhead", maxConcurrent: 2, maxQueue: 0 },
				{ kind: "fallback", fallbackRef: "cache" },
				{ kind: "hedging", delayMs: 0, maxHedges: 2 },
			],
		});
		expect(profile.strategies.map((s) => s.kind)).toEqual([
			...RESILIENCE_STRATEGY_KINDS,
		]);
	});

	it("forces retryOn to transient-only whatever the input says", () => {
		// The field is not read from input at all. Letting an author widen it to
		// "all" would be exactly the never-retry bypass the layer exists to
		// prevent — and it would look like a supported configuration.
		const profile = parseResilienceProfile({
			id: "p",
			strategies: [{ ...RETRY, retryOn: "all" }],
		});
		// SAFETY: the parser guarantees the first strategy retains retry's refined shape.
		expect((profile.strategies[0] as DeterministicRetryStrategy).retryOn).toBe(
			"transient-only",
		);
	});

	it("refuses an unknown strategy kind, naming it", () => {
		// Not ignored. An unrecognised kind means the author configured a
		// behaviour the runtime does not implement, and silently dropping it
		// would deploy an operation with less protection than its author believes.
		expect(
			codeOf(() =>
				parseResilienceProfile({
					id: "p",
					strategies: [{ kind: "bulkheadd" }],
				}),
			),
		).toBe("unknown-strategy");
	});

	it("refuses a non-object or unnamed strategy", () => {
		expect(
			codeOf(() => parseResilienceProfile({ id: "p", strategies: [null] })),
		).toBe("expected-object");
		expect(
			codeOf(() => parseResilienceProfile({ id: "p", strategies: [{}] })),
		).toBe("expected-string");
	});

	it("distinguishes positive from non-negative fields", () => {
		// `baseDelayMs: 0` is a legitimate no-backoff retry; `maxAttempts: 0` is a
		// retry strategy that never attempts anything. The two integer checks are
		// not interchangeable and the tests pin which field uses which.
		expect(
			parseResilienceProfile({
				id: "p",
				strategies: [{ ...RETRY, baseDelayMs: 0, maxDelayMs: 0 }],
			}).strategies,
		).toHaveLength(1);
		expect(
			codeOf(() =>
				parseResilienceProfile({
					id: "p",
					strategies: [{ ...RETRY, maxAttempts: 0 }],
				}),
			),
		).toBe("expected-positive-int");
		expect(
			codeOf(() =>
				parseResilienceProfile({
					id: "p",
					strategies: [{ ...RETRY, baseDelayMs: -1 }],
				}),
			),
		).toBe("expected-nonneg-int");
	});

	it("refuses fractional and unsafe integers in every numeric field", () => {
		for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
			expect(
				codeOf(() =>
					parseResilienceProfile({
						id: "p",
						strategies: [{ ...RETRY, maxAttempts: bad }],
					}),
				),
			).toBe("expected-positive-int");
			expect(
				codeOf(() =>
					parseResilienceProfile({
						id: "p",
						strategies: [{ ...RETRY, baseDelayMs: bad }],
					}),
				),
			).toBe("expected-nonneg-int");
		}
	});

	it("refuses each per-kind required field", () => {
		const bad: Array<[JsonObject, string]> = [
			[
				{ kind: "circuitBreaker", resetTimeoutMs: 0, halfOpenMaxCalls: 1 },
				"expected-positive-int",
			],
			[{ kind: "timeout" }, "expected-positive-int"],
			[{ kind: "bulkhead", maxConcurrent: 1 }, "expected-nonneg-int"],
			[{ kind: "fallback" }, "expected-string"],
			[{ kind: "hedging", delayMs: 0 }, "expected-positive-int"],
		];
		for (const [strategy, code] of bad) {
			expect(
				codeOf(() =>
					parseResilienceProfile({ id: "p", strategies: [strategy] }),
				),
			).toBe(code);
		}
	});
});

describe("neverRetry parsing", () => {
	it("defaults to all three classes when omitted", () => {
		expect(
			parseResilienceProfile({ id: "p", strategies: [RETRY] }).neverRetry,
		).toEqual(["policy.Decided", "terminal", "cancellation"]);
	});

	it("re-adds every default class the author left out", () => {
		// This is the enforcement point. An author who writes
		// `neverRetry: ["terminal"]` does not thereby opt in to retrying policy
		// denials — the parser puts the other two back rather than trusting the
		// omission was deliberate.
		const profile = parseResilienceProfile({
			id: "p",
			strategies: [RETRY],
			neverRetry: ["terminal"],
		});
		expect(profile.neverRetry).toContain("policy.Decided");
		expect(profile.neverRetry).toContain("cancellation");
		expect(profile.neverRetry).toContain("terminal");
	});

	it("preserves the author's ordering ahead of the re-added defaults", () => {
		const profile = parseResilienceProfile({
			id: "p",
			strategies: [RETRY],
			neverRetry: ["cancellation"],
		});
		expect(profile.neverRetry[0]).toBe("cancellation");
	});

	it("does not duplicate a class the author already listed", () => {
		const profile = parseResilienceProfile({
			id: "p",
			strategies: [RETRY],
			neverRetry: ["policy.Decided", "terminal", "cancellation"],
		});
		expect(profile.neverRetry).toHaveLength(3);
	});

	it("refuses a non-array and an unrecognised entry", () => {
		// "deadline" and "transient" are real failure classes but are not
		// never-retry classes; accepting one here would silently make an
		// ordinarily-retryable failure permanent.
		expect(
			codeOf(() =>
				parseResilienceProfile({
					id: "p",
					strategies: [RETRY],
					neverRetry: "terminal",
				}),
			),
		).toBe("never-retry-array");
		expect(
			codeOf(() =>
				parseResilienceProfile({
					id: "p",
					strategies: [RETRY],
					neverRetry: ["deadline"],
				}),
			),
		).toBe("never-retry-value");
		expect(
			codeOf(() =>
				parseResilienceProfile({
					id: "p",
					strategies: [RETRY],
					neverRetry: [7],
				}),
			),
		).toBe("never-retry-value");
	});

	it("accepts an explicit empty list and fills it with the defaults", () => {
		// The most direct attempt to disable the guarantee, and it does not work.
		const profile = parseResilienceProfile({
			id: "p",
			strategies: [RETRY],
			neverRetry: [],
		});
		expect(profile.neverRetry).toHaveLength(3);
	});
});

describe("createResilienceProfile", () => {
	it("builds a usable default with no arguments", () => {
		const profile = createResilienceProfile();
		expect(profile.id).toBe("default-resilience");
		expect(profile.strategies[0]?.kind).toBe("retry");
		expect(profile.neverRetry).toHaveLength(3);
	});

	it("honours each override independently", () => {
		expect(createResilienceProfile({ id: "custom" }).id).toBe("custom");
		expect(
			createResilienceProfile({
				strategies: [{ kind: "timeout", deadlineMs: 5 }],
			}).strategies[0]?.kind,
		).toBe("timeout");
	});

	it("still enforces never-retry through the parse path", () => {
		// `createResilienceProfile` delegates to `parseResilienceProfile` rather
		// than assembling the object directly, which is what keeps the convenience
		// constructor from becoming a way around the guarantee.
		expect(
			createResilienceProfile({ neverRetry: ["terminal"] }).neverRetry,
		).toHaveLength(3);
	});

	it("refuses an invalid override rather than falling back to the default", () => {
		expect(codeOf(() => createResilienceProfile({ id: "  " }))).toBe(
			"expected-string",
		);
	});
});

describe("validateResilienceAgainstEffects", () => {
	const pure: EffectSpec = {
		schemaVersion: "hobo.effect-spec/v1",
		purity: "pure",
		capabilities: [],
		domains: [],
	};
	const networked: EffectSpec = {
		schemaVersion: "hobo.effect-spec/v1",
		purity: "varies",
		capabilities: [],
		domains: ["network"],
	};

	it("allows retry and timeout on a pure contract", () => {
		// Deliberate: a pure local work unit can still time out or be retried, so
		// forbidding all resilience metadata on pure contracts would be wrong.
		expect(() =>
			validateResilienceAgainstEffects(
				parseResilienceProfile({
					id: "p",
					strategies: [RETRY, { kind: "timeout", deadlineMs: 5 }],
				}),
				pure,
			),
		).not.toThrow();
	});

	it("refuses circuitBreaker and hedging without network effects", () => {
		// A circuit breaker on a pure function protects nothing — there is no
		// remote dependency to trip on. Declaring one is a sign the contract's
		// effects were understated, which is the more serious of the two errors.
		for (const strategy of [
			{
				kind: "circuitBreaker",
				failureThreshold: 1,
				resetTimeoutMs: 0,
				halfOpenMaxCalls: 1,
			},
			{ kind: "hedging", delayMs: 0, maxHedges: 1 },
		]) {
			expect(
				codeOf(() =>
					validateResilienceAgainstEffects(
						parseResilienceProfile({ id: "p", strategies: [strategy] }),
						pure,
					),
				),
			).toBe("resilience-requires-effects");
		}
	});

	it("allows circuitBreaker once the contract declares network effects", () => {
		expect(() =>
			validateResilienceAgainstEffects(
				parseResilienceProfile({
					id: "p",
					strategies: [
						{
							kind: "circuitBreaker",
							failureThreshold: 1,
							resetTimeoutMs: 0,
							halfOpenMaxCalls: 1,
						},
					],
				}),
				networked,
			),
		).not.toThrow();
	});
});

describe("computeDelay", () => {
	const parsedRetry = parseResilienceProfile({ id: "p", strategies: [RETRY] });
	// SAFETY: RETRY is the only strategy in this parsed profile.
	const retry = parsedRetry.strategies[0] as DeterministicRetryStrategy;

	it("is a pure function of seed and attempt", () => {
		// The whole determinism claim in one assertion. If this ever varies, a
		// replay reconstructed from facts no longer matches the live run.
		expect(computeDelay(retry, 1)).toBe(computeDelay(retry, 1));
		expect(computeDelay(retry, 2)).toBe(computeDelay(retry, 2));
	});

	it("changes with the seed", () => {
		const parsedOther = parseResilienceProfile({
			id: "p",
			strategies: [{ ...RETRY, seed: "seed-2" }],
		});
		// SAFETY: the profile contains exactly one retry strategy.
		const other = parsedOther.strategies[0] as DeterministicRetryStrategy;
		// Different seeds must not collapse to the same schedule, or the seed
		// would be decorative and two contracts would thunder together.
		expect(computeDelay(retry, 1)).not.toBe(computeDelay(other, 1));
	});

	it("never exceeds maxDelayMs, even at a high attempt number", () => {
		// The exponent is `2 ** (attempt - 1)`, which overflows quickly. The two
		// `Math.min` calls are what stop a runaway attempt count from producing
		// an effectively infinite delay.
		for (const attempt of [1, 5, 20, 60]) {
			expect(computeDelay(retry, attempt)).toBeLessThanOrEqual(
				retry.maxDelayMs,
			);
		}
	});

	it("stays finite when the exponent overflows to Infinity", () => {
		expect(Number.isFinite(computeDelay(retry, 5000))).toBe(true);
		expect(computeDelay(retry, 5000)).toBe(retry.maxDelayMs);
	});

	it("tolerates a zero base delay", () => {
		// `Math.max(1, baseDelayMs)` guards the modulus: `h % 0` is NaN, and a
		// NaN delay would propagate into a fact and compare unequal to itself on
		// replay.
		const parsedZeroBase = parseResilienceProfile({
			id: "p",
			strategies: [{ ...RETRY, baseDelayMs: 0 }],
		});
		// SAFETY: the profile contains exactly one retry strategy.
		const zeroBase = parsedZeroBase.strategies[0] as DeterministicRetryStrategy;
		const delay = computeDelay(zeroBase, 3);
		expect(Number.isNaN(delay)).toBe(false);
		expect(delay).toBe(0);
	});

	it("is non-negative for every attempt", () => {
		// `Math.abs(h)` on the hash: the accumulator is coerced with `| 0`, so it
		// goes negative, and a negative modulus would yield a negative delay.
		for (let attempt = 1; attempt <= 32; attempt++) {
			expect(computeDelay(retry, attempt)).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("applyResilienceProfile", () => {
	const profile = parseResilienceProfile({ id: "p", strategies: [RETRY] });

	it("returns the value and emits no facts on first success", () => {
		return applyResilienceProfile({
			profile,
			now: NOW,
			op: () => "ok",
		}).then((result) => {
			expect(result.ok).toBe(true);
			expect(result.value).toBe("ok");
			expect(result.attempts).toBe(1);
			// No facts on a clean success: the fact stream is a record of trouble,
			// and emitting one per successful call would drown the signal.
			expect(result.facts).toEqual([]);
		});
	});

	it("awaits an async operation", async () => {
		const result = await applyResilienceProfile({
			profile,
			now: NOW,
			op: async () => {
				await Promise.resolve();
				return 42;
			},
		});
		expect(result.value).toBe(42);
	});

	it("passes the attempt number to the operation", async () => {
		const seen: number[] = [];
		await applyResilienceProfile({
			profile,
			now: NOW,
			op: (attempt) => {
				seen.push(attempt);
				if (attempt < 3) throw { failureClass: "transient", message: "again" };
				return "ok";
			},
		});
		// One-based and contiguous. A caller that keys idempotency off the attempt
		// number depends on both.
		expect(seen).toEqual([1, 2, 3]);
	});

	it("retries a transient failure up to maxAttempts then terminates", async () => {
		const result = await applyResilienceProfile({
			profile,
			now: NOW,
			op: () => {
				throw { failureClass: "transient", message: "flaky" };
			},
		});
		expect(result.ok).toBe(false);
		expect(result.attempts).toBe(3);
		expect(result.failureClass).toBe("transient");
		// Three attempt facts and one terminal, in that order: the terminal fact
		// is what an inspector reads to learn the operation stopped.
		expect(
			result.facts.filter((f) => f.type === "resilience.Attempt"),
		).toHaveLength(3);
		expect(result.facts.at(-1)?.type).toBe("resilience.Terminal");
		// The terminal fact carries the *last failure's* reason, not the string
		// "budget exhausted" that the post-loop block emits. Pinning the truth
		// rather than the code's apparent intent: the loop's final iteration has
		// `attempt < maxAttempts` false, so `retried` is false and the catch
		// block pushes its own terminal fact and returns. The post-loop
		// "budget exhausted" branch is therefore unreachable for every input —
		// success returns from the try, and every failure returns from the catch.
		//
		// Harmless as written, and arguably the better behaviour: "flaky" tells
		// an operator what actually went wrong where "budget exhausted" would
		// only restate the attempt count they can already see. Recorded so that
		// whoever removes the dead branch knows this is the behaviour to keep.
		const terminal = result.facts.at(-1);
		expect(terminal?.type).toBe("resilience.Terminal");
		if (terminal?.type === "resilience.Terminal") {
			expect(terminal.reason).toBe("flaky");
		}
	});

	it("records the deterministic delay only on facts that were actually retried", async () => {
		const result = await applyResilienceProfile({
			profile,
			now: NOW,
			op: () => {
				throw { failureClass: "transient", message: "flaky" };
			},
		});
		const attempts = result.facts.filter(
			(f): f is Extract<ResilienceFact, { type: "resilience.Attempt" }> =>
				f.type === "resilience.Attempt",
		);
		expect(attempts[0]?.delayMs).toBe(computeDelay(RETRY, 1));
		expect(attempts[1]?.delayMs).toBe(computeDelay(RETRY, 2));
		// The last attempt was not retried, so it records no delay — a non-zero
		// value there would tell a reader the system waited before giving up.
		expect(attempts[2]?.delayMs).toBe(0);
		expect(attempts[2]?.retried).toBe(false);
	});

	for (const [label, thrown] of [
		["failureClass", { failureClass: "policy.Decided", message: "denied" }],
		["code", { code: "policy-denied", message: "denied" }],
		["name", { name: "PolicyDeniedError", message: "denied" }],
	] as const) {
		it(`never retries a policy deny identified by ${label}`, async () => {
			// The three recognition routes exist because a denial can arrive from
			// the policy engine, from a transport that kept only the code, or from
			// a driver that kept only the class name. Missing any one of them would
			// turn a denial into a retry loop against the policy engine — an
			// authorization retry, not a resilience retry.
			const result = await applyResilienceProfile({
				profile,
				now: NOW,
				op: () => {
					throw thrown;
				},
			});
			expect(result.attempts).toBe(1);
			expect(result.failureClass).toBe("policy.Decided");
			expect(result.ok).toBe(false);
		});
	}

	it("never retries a terminal or a cancellation", async () => {
		for (const thrown of [
			{ failureClass: "terminal", message: "gone" },
			{ code: "TERMINAL", message: "gone" },
			{ name: "TerminalError", message: "gone" },
			{ failureClass: "cancellation", message: "stopped" },
			{ code: "CANCELLED", message: "stopped" },
			{ name: "CancellationError", message: "stopped" },
		]) {
			const result = await applyResilienceProfile({
				profile,
				now: NOW,
				op: () => {
					throw thrown;
				},
			});
			expect(result.attempts).toBe(1);
		}
	});

	it("retries a deadline failure, which is not a never-retry class", async () => {
		// `deadline` is a real class but is deliberately absent from the
		// never-retry set: a request that ran out of time may succeed on a
		// retry, unlike one that was refused.
		let calls = 0;
		const result = await applyResilienceProfile({
			profile,
			now: NOW,
			op: () => {
				calls++;
				throw { code: "DEADLINE", message: "too slow" };
			},
		});
		expect(calls).toBe(3);
		expect(result.failureClass).toBe("deadline");
	});

	it("classifies an unrecognised error object as terminal, so it is not retried", async () => {
		// Fail closed. An error nobody classified might be a bug, a bad request,
		// or a poison message; retrying it is the option most likely to make
		// things worse, so the default is to stop.
		let calls = 0;
		const result = await applyResilienceProfile({
			profile,
			now: NOW,
			op: () => {
				calls++;
				throw new Error("something unexpected");
			},
		});
		expect(calls).toBe(1);
		expect(result.failureClass).toBe("terminal");
		expect(result.facts.at(-1)).toMatchObject({
			reason: "something unexpected",
		});
	});

	it("classifies a thrown primitive as terminal and stringifies it", async () => {
		// `throw "boom"` happens. The classifier must not assume an object, or
		// the error handler itself would throw and hide the original failure.
		const result = await applyResilienceProfile({
			profile,
			now: NOW,
			op: () => {
				throw "boom";
			},
		});
		expect(result.failureClass).toBe("terminal");
		expect(result.facts.at(-1)).toMatchObject({ reason: "boom" });
		const nullish = await applyResilienceProfile({
			profile,
			now: NOW,
			op: () => {
				throw null;
			},
		});
		expect(nullish.failureClass).toBe("terminal");
		expect(nullish.facts.at(-1)).toMatchObject({ reason: "null" });
	});

	it("falls back to a class-appropriate message when the error has none", async () => {
		const result = await applyResilienceProfile({
			profile,
			now: NOW,
			op: () => {
				throw { failureClass: "policy.Decided" };
			},
		});
		expect(result.facts.at(-1)).toMatchObject({
			reason: "policy.Decided deny",
		});
	});

	it("attempts once when the profile carries no retry strategy", async () => {
		// `maxAttempts` falls back to 1 and `seed` to "no-retry". A profile of
		// timeouts and bulkheads is legitimate and must not loop.
		const noRetry = parseResilienceProfile({
			id: "p",
			strategies: [{ kind: "timeout", deadlineMs: 5 }],
		});
		const result = await applyResilienceProfile({
			profile: noRetry,
			now: NOW,
			op: () => {
				throw { failureClass: "transient", message: "flaky" };
			},
		});
		expect(result.attempts).toBe(1);
		expect(result.facts[0]).toMatchObject({ seed: "no-retry", retried: false });
	});

	it("attributes every fact to the profile and stamps the injected clock", async () => {
		const result = await applyResilienceProfile({
			profile,
			now: NOW,
			op: () => {
				throw { failureClass: "terminal", message: "x" };
			},
		});
		for (const fact of result.facts) {
			expect(fact.profileId).toBe("p");
			expect(fact.at).toBe("2026-08-08T00:00:00.000Z");
		}
	});

	it("defaults the clock to wall time when none is injected", async () => {
		// The `??` fallback. Production has no injected clock, so a regression
		// here would leave every fact with an undefined timestamp.
		const result = await applyResilienceProfile({
			profile,
			op: () => {
				throw { failureClass: "terminal", message: "x" };
			},
		});
		expect(Number.isNaN(Date.parse(result.facts[0]?.at ?? ""))).toBe(false);
	});

	it("succeeds on a later attempt without emitting a terminal fact", async () => {
		let calls = 0;
		const result = await applyResilienceProfile({
			profile,
			now: NOW,
			op: () => {
				calls++;
				if (calls < 2) throw { failureClass: "transient", message: "once" };
				return "recovered";
			},
		});
		expect(result.ok).toBe(true);
		expect(result.value).toBe("recovered");
		// One attempt fact recording the failure that was retried, and no
		// terminal fact — the operation did not terminate in failure.
		expect(result.facts).toHaveLength(1);
		expect(result.facts[0]).toMatchObject({ retried: true });
	});
});

describe("inspectResilienceFromFacts", () => {
	it("reports zero attempts for an empty stream", () => {
		expect(inspectResilienceFromFacts([])).toEqual({
			attempts: 0,
			terminal: undefined,
			retried: false,
		});
	});

	it("reconstructs the terminal state without re-running the operation", async () => {
		// This is the replay contract: the inspector reads facts only. A version
		// that re-invoked the op to learn the outcome would double every side
		// effect on every replay.
		const result = await applyResilienceProfile({
			profile: parseResilienceProfile({ id: "p", strategies: [RETRY] }),
			now: NOW,
			op: () => {
				throw { failureClass: "transient", message: "flaky" };
			},
		});
		const inspected = inspectResilienceFromFacts(result.facts);
		expect(inspected.attempts).toBe(3);
		expect(inspected.retried).toBe(true);
		expect(inspected.terminal?.failureClass).toBe("transient");
		expect(inspected.terminal?.attempts).toBe(3);
	});

	it("reports retried false when nothing was retried", async () => {
		const result = await applyResilienceProfile({
			profile: parseResilienceProfile({ id: "p", strategies: [RETRY] }),
			now: NOW,
			op: () => {
				throw { failureClass: "policy.Decided", message: "denied" };
			},
		});
		const inspected = inspectResilienceFromFacts(result.facts);
		expect(inspected.retried).toBe(false);
		expect(inspected.attempts).toBe(1);
		expect(inspected.terminal?.failureClass).toBe("policy.Decided");
	});

	it("returns the first terminal fact when a stream carries several", () => {
		// Streams get concatenated across replays. Reporting the first is the
		// conservative read: it is the one that actually ended the operation.
		const facts: ResilienceFact[] = [
			{
				type: "resilience.Terminal",
				profileId: "p",
				failureClass: "terminal",
				attempts: 1,
				reason: "first",
				at: NOW(),
			},
			{
				type: "resilience.Terminal",
				profileId: "p",
				failureClass: "transient",
				attempts: 3,
				reason: "second",
				at: NOW(),
			},
		];
		expect(inspectResilienceFromFacts(facts).terminal?.reason).toBe("first");
	});
});
