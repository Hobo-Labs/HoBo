---
name: verify-yard-camp-constraints
description: Verify that unimplemented Camp capability, runtime, label and nested-layout requirements are refused before quoting or provider work.
---

# Yard Camp constraint admission

**Properties:** A request with Camp capability, runtime or label requirements, or nested Camp layouts in the requested Yard, is refused before quote preparation, host authorization, budget reservation or provider work. Direct Yard matching, layout comparison, generation planning and saga execution also refuse nested Camp layouts. A request without these unverified requirements can proceed to its other checks.

**Review baseline:** commit `0b8c44da3d9fe7f80ff997e6c77e343d67a938cb`. PASS for the bounded models and executable checks below. The separate `verify-yard-generation-policy-gate` skill checks unsupported generation effects, unavailable approval or attestation, and property locks.

## Covered code

- `packages/broker/src/yard-placement/camp-constraints.ts` identifies the unverified Camp requirements; `deploy.ts` refuses them before preparing a quote or authorizing placement.
- `packages/broker/src/yard-placement/matching.ts` refuses nested Camp layouts in both the inventory matcher and `layoutSubsetCompatible`; `generation.ts` refuses them in the planner and before a saga consults a connector or cached attempt.
- `packages/broker/src/rejections.ts` catalogs the placement refusal.
- `packages/broker/test/yard-camp-constraints.test.ts` checks each unsupported field, special label keys, an unconstrained control, 40 generated cases (seed 614593), repeated nested layouts, a self-consistent older generation plan and a retry after a cached attempt. `yard-event-store-folds.test.ts` uses a real SQLite budget authority and generation connector to verify that a legacy peer's quote does not trigger policy authorization, a hold or provider work.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-camp-constraints
```

The shared runner checks the pinned TLC 1.7.4 jar. Set `TLA2TOOLS` to an installed copy or let it obtain one. Java 11+, Python, Node, Vitest, fast-check and workspace dependencies are required. Use `/statechart` with each model and adjacent view to inspect transitions and counterexamples.

## Scope and evidence

`CampConstraintAdmission` explores 20 states for quote and deployment paths with hard Camp requirements or nested layouts. Its nine-state projection hides eight same-label steps and abstracts other policy decisions as successful. `YardNestedCamp` explores 16 states for direct matching, layout comparison, generation planning and saga execution; its six-state projection hides eight same-label steps. Six weakened model guards produce counterexamples.

The executable check runs real broker fixtures. `python3 .agents/skills/verify-yard-camp-constraints/mutations/runtime.py` first requires an unmodified control for each mutation, then an actual assertion failure. The source mutations cover both admission paths, the three hard Camp fields, nested layouts, both matchers, planning, saga execution and a retry, and funded generation.

This is a fail-closed boundary, not an implementation of Camp matching. Requests with these requirements are unavailable until the host can verify them; a named Camp's existence, environment, preferences and complete selection-mode semantics remain unverified. The models abstract identity and constraint values as Booleans, assume the other authorization and budget gates, and do not prove TypeScript refinement, external provider behavior, liveness, concurrency or crash recovery. The `verify-yard-camp-binding` and `verify-yard-generation-authority` skills check separate bounded slices.

For a broken-code check, copy `packages/broker` to a scratch package with linked `node_modules`, remove its copied `tsconfig.json`, set `BROKER_CAMP_CONSTRAINTS_VERIFY_PACKAGE_ROOT`, and make the second `if (hasUnverifiedCampConstraints(request))` false in the copied `deploy.ts`. This skill must fail a real placement assertion. Restore the source and rerun the unmodified skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update models and tests for intended changes, replay counterexamples against code, test a broken scratch implementation and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
