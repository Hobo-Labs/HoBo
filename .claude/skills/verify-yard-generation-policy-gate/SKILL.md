---
name: verify-yard-generation-policy-gate
description: Verify that unsupported generation effects and unavailable approval are refused by the Yard planner before funded deployment effects.
---

# Yard generation policy gate

**Properties:** The planner refuses unknown and unsupported generation effects and any policy that does not explicitly say approval is unnecessary. Through the checked funded deployment path, these refusals precede host authorization, reservation and provider work. A valid modeled effect and explicit no-approval setting are not rejected by this gate.

**Review baseline:** commit `903b90d359ec71d63b6ee0e909ea9b8fe22eb8d0`. PASS for the bounded model and executable checks below.

## Covered code

- `packages/broker/src/yard-placement/generation.ts` implements the policy-effect and approval checks in `planYardGeneration`; `deploy.ts` calls that planner before funded authorization and generation.
- `packages/broker/src/rejections.ts` catalogs the deployment rejection.
- `packages/broker/test/yard-generation-approval.test.ts` checks approval required, explicit false, malformed settings, unsupported effects and 40 generated approval settings (seed 614594). `yard-event-store-folds.test.ts` uses a real SQLite budget authority and generation connector to check old quoted requests under approval-required, invalid-effect and dedicated-Yard policies. The check asserts zero authorization calls, zero reserved budget and zero provider calls. Residency, Camp and parser suites run alongside those tests.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-generation-policy-gate
```

The shared runner checks the pinned TLC 1.7.4 jar. Set `TLA2TOOLS` to an installed copy or let it obtain one. Java 11+, Python, Node, Vitest, fast-check and workspace dependencies are required. Use `/statechart` with the model and adjacent view to inspect transitions and counterexamples.

## Scope and evidence

`YardGenerationPolicyGate` explores 27 states for four abstract policy effects and three approval settings through planning, authorization, reservation and provider work. Its seven-state projection hides 12 same-label steps. Four weakened model checks produce counterexamples. Six real-source mutations in `python3 .agents/skills/verify-yard-generation-policy-gate/mutations/runtime.py` each first require an unmodified passing control, then an assertion failure.

The model abstracts other policy, quote and budget checks as successful and does not prove TypeScript refinement, remote provider behavior, persistence, liveness, concurrency or crash recovery. It does not implement approval evidence or dedicated-Yard evidence: those generation paths are refused. `maxConcurrentGenerations`, `maxYardsPerTenant`, `requireAttestation` and `lockedProperties` are not enforced by the planner. The direct planner assumes its caller established no matching Yard. Direct use of the generation saga does not itself receive or verify a policy; the checked deployment path supplies policy and authority fences. These gaps need separate work. The `verify-yard-generation-authority` and `verify-yard-camp-constraints` skills check separate bounded slices.

For broken-code checks, copy `packages/broker` to a scratch package with linked `node_modules`, remove its copied `tsconfig.json`, set `BROKER_GENERATION_POLICY_VERIFY_PACKAGE_ROOT`, and separately change the effect guard and the approval guard in the copied `generation.ts` to `if (false)`. Each full skill run must fail real-code assertions. Restore the source and rerun the unmodified skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update models and tests for intended changes, replay counterexamples against code, test both broken scratch implementations and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
