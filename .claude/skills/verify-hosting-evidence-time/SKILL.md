---
name: verify-hosting-evidence-time
description: Verify hosting quote, budget and entitlement freshness and observation ordering when changing broker financial timestamps.
---

# Hosting financial evidence time

**Properties:** Hosting quotes and budget snapshots must have valid explicit-offset timestamps, cannot be observed in the future, and must be unexpired. Within a budget period, spend and entitlement observations cannot move backwards; changed values at the same instant need the applicable reconciliation evidence. Equivalent offsets or fractional spellings denote the same instant, and sub-millisecond ordering is preserved.

**Review baseline:** commit `719f8cbe6cf9a5cb9635f6d0055dd66ae2393604`. PASS for the tests, bounded models and exact-real abstraction below.

## Covered code

- `packages/broker/src/financial-time.ts` validates calendar components and explicit `Z` or numeric offsets, compares whole UTC seconds and arbitrary fractional seconds, adds integer milliseconds, and rounds elapsed intervals to whole minutes.
- `packages/broker/src/budget-authority.ts` applies that comparison to quote and snapshot freshness, entitlement admission, retained observation history and policy reconfiguration. `packages/hobo/src/hosting-budget-authority.ts` uses the same comparison at the integer-millisecond trusted-clock boundary.
- `packages/broker/test/hosting-evidence-time.test.ts` reproduces future observations, normalized impossible dates, equivalent timestamp spellings and earlier or genuinely newer observations within one millisecond. It checks 500 generated freshness pairs (seed 614506) and 1,000 generated offset and fractional comparisons (seed 614507), 500 generated timestamp additions (seed 614511), and 500 generated elapsed-minute intervals (seed 614514). Existing history and generated authority tests exercise surrounding transitions. The HoBo bridge tests cover future sub-millisecond entitlements, future snapshots and invalid authority timestamps; the broker suite passed 608 tests with 13 skipped.

## Run

From the repository root after installing workspace dependencies and initializing the pinned submodules:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-hosting-evidence-time
```

The bridge check builds HoBo workspace dependencies before its integration test. The runner uses checksum-pinned TLC 1.7.4; set `TLA2TOOLS` to that jar or let it download the jar. Set `BUDGET_Z3_PYTHONPATH` to `z3-solver==4.15.4.0`, or let the proof install it temporarily. Java 11+, Python with pip, Node, Vitest, fast-check and built workspace dependencies are required. Use `/statechart` to read each model and its view.

## Scope and evidence

`FinancialFreshness` explores 256 states for four abstract instants, valid or invalid calendar input, and an accepted or refused decision. It checks future observations, expiry, calendar validity and acceptance of valid current evidence. Its projection draws six states and hides 128 same-label steps. `FinancialHistory` explores 320 states for spend or entitlement updates, four abstract instants, changed values, evidence and equivalent or different spellings. It checks older and equal-time changes and accepts genuinely newer observations. Both models assume non-time fields and other admission checks are valid and abstract away storage and concurrent updates. `BridgeEvidence` explores 16 states for an integer clock and finer-grained evidence, checking that future observations are refused. Its projection hides eight same-label steps; the historical truncation model accepts a future observation and the real bridge regression reproduces it. The old millisecond model produces counterexamples for future evidence, impossible dates, false expiry, backwards updates, equal-time spend changes and rejected newer entitlement observations. The real-code tests reproduce those cases.

The Z3 obligations hold for arbitrary exact-real time values under the stated guards, including observations compared with a nonnegative integer-millisecond bridge clock; each premise has a witness. Removing the future check or same-time evidence guard produces counterexamples. These are proofs of abstractions, not proofs of the TypeScript parser, offset conversion, persistent storage, concurrency, clock accuracy or authenticity of provider evidence. Generated actual-code tests exercise the correspondence but do not prove it for every string.

Financial timestamps now need an explicit `Z` or numeric offset and a valid calendar date. Persisted ambiguous or normalized-invalid timestamps need reconciliation before replay. The addition and elapsed-time abstraction is checked separately by `verify-ci-financial-time`. The HoBo bridge clock and planning inputs use integer milliseconds; external source authenticity and the broader provider-to-budget path are outside this check. This skill does not prove that an external source supplied truthful times or that all provider effects are fenced.

For a scratch mutation, copy `packages/broker` to a temporary package directory, link its `node_modules`, and set `BROKER_TIME_VERIFY_PACKAGE_ROOT` to that copy. Truncate the fractional part in `financial-time.ts` or restore the earlier `budget-authority.ts`; the real-code tests must fail. For a bridge mutation, set `HOBO_TIME_VERIFY_PACKAGE_ROOT` to a copied HoBo package with linked `node_modules` and restore the earlier bridge comparisons. Restore the code and rerun the skill.

## Keep in sync

Review changes to the covered files and any uncommitted work since the baseline. Update the tests and models for intended behavior, replay model counterexamples against the implementation, run a deliberately broken scratch version and then the unmodified skill, and advance the baseline only after review. Use `/maintain-formal-verification-skill`.
