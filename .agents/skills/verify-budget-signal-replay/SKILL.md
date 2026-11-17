---
name: verify-budget-signal-replay
description: Verify budget signal reconstruction, replay and conflicting journal identities when changing the broker's threshold signal fold.
---

# Broker budget signal replay

**Properties:** A replay suppresses a reconstructed reset, threshold crossing or recovery only when the recorded signal has the same scope and payload. A conflicting signal or occupied idempotency key and an incomplete relevant financial fact refuse the fold. Distinct foreign signals do not suppress it. Without those checks, a threshold alert or recovery can disappear or be emitted using incomplete spend evidence.

**Review baseline:** commit `235c92be61026383fbb19a2a35b8a7a7953f5502`. PASS for the generated tests, bounded model and symbolic decision proof below.

## Covered code

- `packages/broker/src/budget-signals.ts` reconstructs signals from usage and credits, compares recorded signals and journal metadata against each reconstructed transition, and returns event inputs with deterministic idempotency keys.
- `packages/broker/test/budget-signal-identity.test.ts` checks foreign tenants and periods, same-key payload changes, mixed matching and conflicting records, missing scope and amounts, invalid credits, overflow, and a real SQLite key collision. It runs 500 generated usage and credit histories with seed 614508. `budget-signal-history.test.ts` checks orphaned crossings and recoveries, versioned resets, and 500 generated histories with a fact removed (seed 614509). `budget-signals.test.ts` checks resets, crossing, recovery, and replay through SQLite.
- `packages/storage-sqlite/src/journal.ts` provides the real journal used by those tests. Its per-stream idempotency deduplication can hide an event if an unrelated event occupied the key.

## Run

From the repository root after installing and building workspace dependencies:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-budget-signal-replay
```

The runner checks the checksum-pinned TLC 1.7.4 jar; set `TLA2TOOLS` to that jar or let it download it. Set `BUDGET_Z3_PYTHONPATH` to `z3-solver==4.15.4.0`, or let the proof install it temporarily. Java 11+, Python with pip, Node, Vitest, fast-check and built workspace dependencies are required. Use `/statechart` to read the model and its view.

## Scope and evidence

`BudgetSignalReplay` explores 60 states. It abstracts a reset, crossing or recovery and nine record classes: absent, identical, independently keyed foreign, conflicting foreign, changed payload, mixed matching and conflicting records, an occupied metadata key, incomplete financial evidence, and an orphaned recorded signal. The model checks refusal, exact replay suppression and append in the absence of a concurrent writer. Its projection draws nine states and six arrows and hides 27 same-label steps. The historical variant suppresses a conflicting record, returns a signal with incomplete evidence, and lets the journal silently deduplicate a new signal, and accepts a recorded signal without a reconstructed transition. Real-code tests reproduce those paths, including an actual SQLite append.

The Z3 obligations cover every combination of abstract evidence-completeness, reconstructed history, key, event-kind, scope, payload and metadata checks. Their premises have witnesses; removing each guard yields a counterexample. This proves the abstract decision, not the TypeScript implementation, key construction, financial arithmetic, source authenticity or concurrent appends. Generated real-code histories and scratch mutations test correspondence but do not prove refinement.

Callers must replay the complete target stream and preserve metadata. A different event can occupy a key between reading and appending: inspect deduplicated append results and reconcile mismatches. The fold assumes its input stream and financial facts are truthful and complete; it cannot authenticate a perfectly forged matching record or detect an absent fact when no recorded signal exposes the omission. Older unscoped or incomplete records now require reconciliation. Legacy tenant/lifetime policy and versioned policy have different scope requirements. Arithmetic accuracy is outside this skill; see `verify-budget-signal-arithmetic` for the separately maintained threshold and wire checks.

For a scratch mutation, copy `packages/broker` to a temporary package directory, link its `node_modules`, set `BUDGET_SIGNAL_VERIFY_PACKAGE_ROOT` to that copy and restore the earlier `budget-signals.ts`. The real-code checks must fail. Restore the code and rerun the skill.

## Keep in sync

Review changes to the covered files and uncommitted work since the baseline. Update the tests and model for intended behavior, replay model counterexamples against the implementation, run a deliberately broken scratch version and then the unmodified skill, and advance the baseline only after review. Use `/maintain-formal-verification-skill`.
