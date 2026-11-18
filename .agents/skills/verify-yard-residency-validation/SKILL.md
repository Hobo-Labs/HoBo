---
name: verify-yard-residency-validation
description: Verify residency tags before Yard matching, request admission and direct generation calls.
---

# Yard residency attestation validation

**Property:** A Yard is eligible for a residency requirement only if the requested jurisdiction and optional data classification are recognized, even when the Yard repeats the same tag. The deployment request is checked before quoting, a generation hold or a provider call. Direct generation planning refuses invalid tags, and the saga refuses an invalid plan before consulting an attempt or invoking a connector. Otherwise a malformed restriction can reach host authorization or cause unnecessary Yard generation.

**Review baseline:** commit `38c50b2f1b3dcb19f926900ee8456fbd8b553166`. PASS for the models and executable checks below.

## Covered code

- `packages/broker/src/yard-placement/residency.ts` parses tags and validates a layout's residency list. `matching.ts` uses the parser before accepting an exact Yard attestation; otherwise it checks the Yard's declared regions through the core residency evaluator. `deploy.ts` uses it when capturing the request, before quote preparation or funded generation. `generation.ts` checks residency in the planner and again at the start of the saga, before consulting an attempt or connector.
- `packages/broker/test/yard-residency-validation.test.ts` exercises invalid jurisdictions and classifications that are repeated by the Yard, a valid explicit attestation, rejection before a quote, and the real placement path with no host authorization on invalid evidence. It generates 100 unknown jurisdiction names with seed 614583. `yard-event-store-folds.test.ts` supplies an old quote and a real SQLite budget authority and checks that invalid residency creates neither a hold nor a provider effect. `yard-generation-residency.test.ts` checks direct planning, a self-consistent invalid plan, an invalid retry, a valid provider call, and 100 generated invalid jurisdictions with seed 614584. Existing Yard placement and matcher tests run alongside them.
- `packages/core/src/ports/jurisdiction.ts` defines recognized classifications and jurisdictions and the region evaluator; the finite model treats their result as an input rather than proving the dictionary or evaluator.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-residency-validation
```

The shared runner checks the pinned TLC 1.7.4 jar. Set `TLA2TOOLS` to an installed copy or let the runner obtain it. Java 11+, Node, pnpm, Vitest, fast-check and workspace dependencies are required. The real-code check builds `@hobo/core` first so it exercises the current jurisdiction parser. Use `/statechart` on the model and view to inspect transitions and counterexamples.

## Scope and evidence

`YardResidency` explores 16 states for valid or invalid tags, an explicit matching attestation, and sufficient or insufficient region evidence. It checks that invalid tags are refused, evidence is required, and a valid explicit attestation is accepted. Its three-state projection has two arrows and hides eight same-label steps. `YardResidencyGeneration` explores six states for valid and invalid tags through parsing, a hold and a provider effect; its five-state projection has four arrows and hides two same-label steps. `YardResidencyDirect` explores nine states for direct planner and saga calls; its five-state projection has five arrows and hides four same-label steps. Five weakened model checks produce counterexamples. Four source mutations can be run with `python3 .agents/skills/verify-yard-residency-validation/mutations/runtime.py`; each passes a control and then fails an actual assertion.

The finite models abstract the core jurisdiction parser, the region evaluator, the Yard's attestation and financial admission. The direct-generation model assumes the supplied tag stays fixed through its abstract provider call. An explicit valid attestation is trusted and takes precedence over region-derived evidence; this check does not independently establish actual data location, prove that the attestation is honest, or prove TypeScript refinement. A valid residency tag does not authenticate or authorize a supplied plan or validate its other fields. Camp residency, remote execution and liveness are also outside this skill.

For the mandatory broken-code check, copy `packages/broker` to a scratch directory, link its `node_modules`, remove its copied `tsconfig.json`, set `BROKER_RESIDENCY_VERIFY_PACKAGE_ROOT`, and disable the saga's `hasValidYardResidency(plan.requestedLayout)` guard in the copied `generation.ts`. Run this skill: the self-consistent invalid-plan test must fail on an assertion because a provider was called. Restore the source and rerun the unmodified skill.

## Keep in sync

Review every change to covered code since the baseline. Update the model and tests from the code, preserve the property unless there is evidence of an intended policy change, replay counterexamples on the implementation, exercise a broken scratch implementation and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
