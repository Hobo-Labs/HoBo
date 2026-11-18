---
name: verify-yard-generation-policy-gate
description: Verify that unsupported generation effects, unavailable evidence and property locks are refused before funded deployment effects.
---

# Yard generation policy gate

**Properties:** The planner refuses unknown and unsupported generation effects, any policy that does not explicitly say approval and attestation are unnecessary, and nonempty or invalid locked-property lists. Through the checked funded deployment path, these refusals precede host authorization, reservation and provider work. A modeled policy with the supported effect, explicit no-approval and no-attestation settings, and an empty property-lock list is not rejected by these checks.

**Review baseline:** commit `b79a7d7ab3c7a048c88eba1ab9f2d806ad6a4c6b`. PASS for the bounded model and executable checks below. The separate `verify-yard-generation-saga` skill checks in-process retry coalescing and plan identity.

## Covered code

- `packages/broker/src/yard-placement/generation.ts` implements the policy-effect, approval, attestation and property-lock checks in `planYardGeneration`; `deploy.ts` calls that planner before funded authorization and generation.
- `packages/broker/src/rejections.ts` catalogs the deployment rejection.
- `packages/broker/test/yard-generation-approval.test.ts` checks approval required, explicit false, malformed settings, unsupported effects and 40 generated approval settings (seed 614594). `yard-event-store-folds.test.ts` uses a real SQLite budget authority and generation connector to check old quoted requests under approval-required, invalid-effect and dedicated-Yard policies. The check asserts zero authorization calls, zero reserved budget and zero provider calls. `yard-generation-attestation.test.ts` covers required and malformed attestation, invalid and nonempty property locks, and 40 generated nonempty lists (seed 614595); funded tests check both new refusals before authorization, a hold or a provider call. Residency, Camp and parser suites run alongside those tests.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-generation-policy-gate
```

The shared runner checks the pinned TLC 1.7.4 jar. Set `TLA2TOOLS` to an installed copy or let it obtain one. Java 11+, Python, Node, Vitest, fast-check and workspace dependencies are required. Use `/statechart` with the model and adjacent view to inspect transitions and counterexamples.

## Scope and evidence

`YardGenerationPolicyGate` explores 27 states for four abstract policy effects and three approval settings through planning, authorization, reservation and provider work. Its seven-state projection hides 12 same-label steps. Four weakened model checks produce counterexamples. `YardGenerationEvidence` explores 21 states for attestation and property-lock settings through the same stages; its seven-state projection hides nine same-label steps. Four weakened evidence-model checks produce counterexamples. Twelve real-source mutations in `python3 .agents/skills/verify-yard-generation-policy-gate/mutations/runtime.py` each first require an unmodified passing control, then an assertion failure.

The model abstracts other policy, quote and budget checks as successful and does not prove TypeScript refinement, remote provider behavior, persistence, liveness, concurrency or crash recovery. It does not implement approval, dedicated-Yard, attestation or property-lock evidence: those generation paths are refused. `maxConcurrentGenerations` and `maxYardsPerTenant` are not enforced by the planner. The direct planner assumes its caller established no matching Yard. Direct use of the generation saga does not itself receive or verify a policy; the checked deployment path supplies policy and authority fences. These gaps need separate work. The `verify-yard-generation-authority` and `verify-yard-camp-constraints` skills check separate bounded slices.

For broken-code checks, copy `packages/broker` to a scratch package with linked `node_modules`, remove its copied `tsconfig.json`, set `BROKER_GENERATION_POLICY_VERIFY_PACKAGE_ROOT`, and separately change the effect, approval, attestation and locked-property guards in the copied `generation.ts` to `if (false)`. Each of the four full skill runs must fail real-code assertions. Restore the source and rerun the unmodified skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update models and tests for intended changes, replay counterexamples against code, test all four broken scratch implementations and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
