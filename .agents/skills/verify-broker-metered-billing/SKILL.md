---
name: verify-broker-metered-billing
description: Verify metered broker preflight, exact budget arithmetic, finalized evidence and replay ownership when changing broker billing or resolution.
---

# Broker metered billing

**Properties:** A fresh metered reservation is admitted only when the complete observed charge and all outstanding holds plus its estimate fit the bounded budget and its own amount fits the per-resolution cap. Unknown or changed observations cannot release a hold; finalized identities cannot be reused. A repeated broker resolution does not issue another receipt or release an earlier hold.

**Review baseline:** commit `3f0140e6b8fc1b1aeb4fe4b0b73368b16a1869e8`. PASS for the stated tests, bounded model and exact-real abstraction under the assumptions below.

## Covered code

- `packages/broker/src/metering.ts` folds serialized decimal costs, keeps in-memory holds, checks the observed meter-fact prefix, and processes finalization.
- `packages/broker/src/billing-decimal.ts`, `pricing-authorization.ts` and `planes.ts` validate bounded policies and share decimal conversion and rounding. `createBillingPlane` uses the same single-writer hold logic with an empty meter stream.
- `packages/broker/src/broker.ts` refuses an explicit replay and releases a newly created hold only when placement fails before receipt issuance. Custom planes must report `reservationCreated: true` for that release; a missing flag leaves the hold intact. Quote-backed admission also refuses to issue a receipt without that confirmation; the composition tests here explicitly exercise legacy estimate mode. The broker now also serializes request identities within one process; see `verify-broker-delivery-claim`.
- `packages/broker/test/metered-budget-integrity.test.ts` checks boundaries, invalid policies, evidence, finalization, and 1,000 generated integer-cent reference histories (seed 614502). `packages/broker/test/integrity.test.ts` exercises broker composition, including a successful resolution followed by a failed replay. `packages/broker/test/default-billing-holds.test.ts` exercises the default plane and broker path, including 1,000 generated integer-cent request histories (seed 614505).

## Run

After installing workspace dependencies, run from the repository root:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-broker-metered-billing
```

The shared runner uses checksum-pinned TLC 1.7.4. Set `TLA2TOOLS` to that jar or let the runner download it. Set `BUDGET_Z3_PYTHONPATH` to an installation of `z3-solver==4.15.4.0`, or let the proof install it temporarily. Java 11+, Python with pip, Node with the repo's `tsx`, Vitest, fast-check, and built workspace dependencies are required. Use `/statechart` to read the TLA+ result and its view.

## Scope and evidence

The real-code tests reproduce the prior `0.1 + 0.7` undercount, an affordable integer-cent history that floating point rejected, malformed bounded policies, a reused finalized identity, replaced meter facts, and the released-hold replay. Numeric inputs mean their JavaScript serialized decimal values, including exponent notation; the public folded number rounds upward or is infinity if no finite upper representation exists. The broker suite passed 671 tests with 13 skipped. Restoring the old stateless default fails the actual-code tests.

TLC explores 1,412 distinct states for two requests, a two-unit budget, zero-to-two-unit estimates and final charges, and three starting spend levels. It checks admission, retained holds after receipt, at most one receipt, and budget preservation until outside charges or an overrun. Placement success and failure are modeled as separate steps after reservation, allowing more interleavings than the synchronous broker path. Evidence is a Boolean abstraction: it does not model event contents, authentic producers, timestamps, policy changes, currency, or arbitrary storage and network effects. The 48-state `/statechart` projection hides 140 same-label steps, including failed replays, evidence changes and outside charges. Deliberately removing the budget or evidence guard violates `SafeAdmission`; releasing a prior hold on replay violates `IssuedRetainsHold`. In the constrained replay mutation, `/statechart` found the shortest path: reserve, issue a resolution, then release its hold on a failed replay. The broker composition regression test reproduces that path against the earlier implementation. A longer mutated path can issue a second receipt after that release.

Z3 proves the admission, confirmed-unused release and bounded-final-usage steps preserve the exact-real aggregate inequality for arbitrary values satisfying their premises. Each premise has a witness. Removing existing holds from the guard or allowing overrun settlement produces a counterexample. This is a proof of an abstraction, not a proof of TypeScript refinement or floating-point conversion.

This plane trusts its caller's estimates, release confirmation and meter reader. It cannot authenticate facts, detect missing history before its first observation, prove provider costs, or reconstruct holds after restart. It is single-writer only; separate processes or instances do not share admission. External charges, overruns and policy changes can exceed a previously safe cap. The default billing plane keeps holds only in its own memory and has no meter feed to finalize them. Custom planes that do not report replay ownership are outside the replay guarantee. Use the durable hosting budget authority for funded shared hosting; its adapters and provider effects have their own stated limits.

For a scratch real-code mutation, copy `packages/broker` to a temporary package directory, link its `node_modules`, and set `BROKER_METER_VERIFY_PACKAGE_ROOT` to that copy. For example, remove outstanding holds from the budget sum or release a prior replay's hold; this skill must then fail its actual-code tests. `BROKER_METER_VERIFY_PRICING_ROOT` can point at a pricing source copy. Restore the code and rerun the skill.

## Keep in sync

Inspect changes to the covered files since the review baseline, including uncommitted work. Recheck the intended financial and replay semantics, update tests and model, replay model counterexamples against the implementation, run a deliberately broken scratch implementation and then the unmodified skill, and advance the baseline only after review. Use `/maintain-formal-verification-skill`.
