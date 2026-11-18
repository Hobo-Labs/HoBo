---
name: verify-broker-budget-authority
description: Verify quote authorization, hosting budget admission, execution claims, uncertain holds, journal commits, and settlement when changing the broker budget authority.
---

# Broker hosting budget authority

**Properties:** Quote authorization requires a current, intact and eligible quote with a trusted host attestation of its conservative liability bound, or an explicitly trusted legacy estimate; it compares exact liabilities against explicit bounds and rounds accepted numeric output upward. Admission counts the complete liability bound and existing outside exposure; claimed or uncertain execution retains its hold; a journal callback that fails before appending leaves no acknowledged state change; evidence-backed settlement is idempotent.

**Why:** A missing hold or lost journal entry can fund multiple provider operations with the same money, while a premature release can leave running work unaccounted for.

**Review baseline:** commit `a9c02ab220cd3b795e7e835f866ae21baf5c608d`. PASS for the stated generated cases, bounded model, and exact-arithmetic abstraction under the assumptions below.

## Covered code

- `packages/broker/src/pricing-authorization.ts`, `packages/broker/src/billing-decimal.ts`, `packages/pricing/src/quote.ts`, and `packages/broker/test/{pricing-authorization,quote-provenance}.test.ts`: quote validation, host-attested liability, explicit estimate trust, exact decimal bounds, zero/unlimited policy, conservative numeric output, and generated cap cases (seeds 614493 and 614515).
- `packages/broker/src/budget-authority.ts` and `financial-time.ts`: `createBudgetAdmissionAuthority`, especially `reserve`, `claimExecution`, `uncertain`, `release`, `settle`, `save`, and journal replay.
- `packages/broker/test/budget-authority.property.test.ts`: generated actual-code cases.
- `packages/broker/src/budget-fence-settlement.ts` and `packages/broker/test/fenced-budget-settlement.test.ts`: receiver- and finance-signed settlement verification, with generated adversarial histories.
- `packages/hobo/src/hosting-budget-authority.ts` and `packages/hobo/test/hosting-budget-authority.test.ts`: existing SQLite-backed composition examples exercise the bridge from cloud planning and transitions to the broker authority.
- `packages/broker/src/budget-sqlite.ts` and `budget-postgres.ts` implement external persistence but are not themselves proven by these checks.
- `packages/broker/src/yard-placement/deploy.ts` consumes this authority; its whole execution and provider effects are not proven here.

## Run

From the repository root after installing workspace dependencies:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-broker-budget-authority
```

This runs quote and budget fast-check cases, signed-settlement cases, a cached HoBo workspace build before the hosting bridge integration tests, TLC 1.7.4, and a Z3 4.15.4 induction proof. Set `TLA2TOOLS` to the checksum-pinned jar or let the shared runner download it. Set `BUDGET_Z3_PYTHONPATH` to an existing `z3-solver==4.15.4.0` installation or let the test install that pinned version into a temporary directory. Java 11+, Python with pip, Node with the repo's `tsx`, Vitest, fast-check, workspace dependencies and initialized pinned submodules are required. Use `/statechart` to read the TLA+ result and its view.

## Scope and evidence

Quote authorization rejects raw quote amounts without the full quote, old or changed quote contents, ineligible or unpriced quotes, non-USD amounts, invalid bounded policy and exact liabilities above budget or cap. Zero means zero unless the corresponding unlimited flag is explicit. Accepted exact liabilities round upward when returned as a number; denials return zero authorized amount. A content hash detects changes but is not authentication. The caller supplies a trusted `attestQuote` callback that must authenticate and bind the quote and return a conservative liability bound; the helper cannot establish the callback’s honesty. A raw `spendEstimateUsd` is accepted only with explicit `trustEstimate: true`. The general broker invokes this helper with a host pricing authority unless legacy estimate trust is explicit; see `verify-broker-quote-admission` for that integration. The broker suite passed 822 tests with 13 skipped at this baseline. The durable authority and Yard policy use the same SHA-256 protobuf JSON quote digest; `verify-yard-funded-admission` checks the policy binding separately. Sixteen earlier deliberate implementation mutations covering quote checks, zero and unlimited handling, exact comparison, policy validation and rounding fail the real-code tests; restoring the old quote implementation also fails the provenance tests. See `verify-broker-quote-provenance` for the separate attestation, mutation and liability models.

BrokerQuoteAuthorization checks 2,304 reachable states for historical or current behavior, full quotes, raw quote amounts and trusted estimates, abstract quote validity (including trusted attestation), rounded or exact amount, and two independent bounds and unlimited flags. It checks that current authorization respects both bounds and requires valid full quote evidence for quote-based use. Its 96-state constrained projection hides 48 same-state steps. Three model mutations and two executable historical counterexamples violate those properties. The model abstracts hash verification, version, eligibility, currency and provenance into a validity flag; it does not prove cryptography, IEEE conversion, TypeScript refinement, persistent holds or caller honesty.

Z3 proves that abstract authorization under the stated guards implies valid quote evidence and unbounded exact-real budget and cap inequalities. The premises have a witness; `BROKER_QUOTE_PROOF_MUTATION=raw`, `quote`, `cap`, and `budget` give counterexamples. This mathematical obligation does not prove real-code refinement or provider evidence. For isolated quote mutations set `BROKER_QUOTE_VERIFY_PACKAGE_ROOT` to a package copy and place the pricing corpus at the same relative path used by its tests.

The generated tests use seed 614440 and 350 examples per property. They vary spend, unresolved liability, recovery reserves, outside commitments, request bounds and repeated holds; independently check provider-account and entitlement limits and reserved projections; check uncertain and claimed execution, journal replay and evidence-backed idempotent settlement; and inject a journal callback failure before append into reserve, claim, uncertain, release and settle. They exercise the synchronous authority with an in-memory journal. A callback that appends and then throws is not covered. The separate existing HoBo composition tests exercise concrete examples of SQLite authority connections, shared credits, reservation adoption, crash recovery and final settlement; they are not generated tests. Neither check proves the SQLite or PostgreSQL adapters, and the generated tests do not cover revision/period changes, competing processes, provider effects, or overrun settlement.

TLC explores 385 distinct states for two requests, one unit of budget, and one-unit holds. Atomic reserve, claim, uncertainty, evidence, release, and settlement actions model the synchronous authority. A request cannot be released after claim, settlement requires final evidence, and release requires unused-execution evidence. Actual cost may be zero, one, or two units; spent plus held remains within the cap until a provider overrun. The model abstracts observation contents, persistent storage, CAS, outside commitments, policy changes, retries, and account and entitlement dimensions. The chart follows the first request and hides the other request's same-label steps; release is possible only if execution was never claimed.

BrokerFence explores 129 distinct states and 830 steps for one reservation, a claimed or unclaimed hold, up to three evidence offers, and both release and settlement. Its invariants require both authentic, correctly bound proofs and a claim before settlement, and retain a claimed hold until settlement. The model treats signature verification, binding checks, trust enrollment, and persistence as correct atomic predicates; it does not prove cryptography, storage, concurrency, or the external receiver and finance authorities. The `/statechart` view collapses these to five displayed states and four arrows, hiding 723 same-label steps.

The signed-settlement property uses seed 614450 and 120 generated histories, with a 30-second verification timeout for loaded runners. It varies final usage including overruns, uncertainty, and sequences of forged receiver signatures, forged finance signatures, changed charges, evidence references, account usage, and receipt scopes. The receiver forgery is accompanied by an otherwise valid finance signature. Every rejection must retain the hold and produce no event; after valid settlement, repeated settlement and journal replay preserve the result. A PostgreSQL integration case is skipped without its configured database.

The Z3 induction proves that arbitrarily many exact-real reserve, release, and settlement steps preserve `spent + held + unresolved + recovery + external <= cap`, assuming a safe initial state, fixed nonnegative outside exposures, an admission guard counting the full quote, and final usage no larger than its released hold. Claims and uncertain outcomes retain the same aggregate. This is an unbounded mathematical proof of an abstraction, not a proof of TypeScript refinement, durable CAS, provider bills, or behavior when configuration changes exposure. The proof also demonstrates that an actual overrun can exceed the cap; the implementation records overruns rather than pretending they cannot occur.

In scratch copies, removing unresolved exposure from admission, omitting account or entitlement holds, permitting release after claim, or applying the current state before a failing commit causes the respective generated property to fail. Model mutations removing release or settlement evidence violate their independently stated invariants. Removing receiver signature verification makes the generated signed-settlement property fail; removing proof validation or allowing release after claim violates BrokerFence invariants. Setting `BROKER_PROOF_MUTATION=omit-unresolved` causes the abstract admission obligation to produce a counterexample. Rerun against unmodified code after exercising mutations.

## Keep in sync

Inspect changes to the covered files since the sync commit, including uncommitted changes. Update the model and generated checks for intended behavior, replay model counterexamples against real code, rerun the check and deliberately broken scratch variants, then advance the sync commit only after confirming correspondence. Use `/maintain-formal-verification-skill`.
