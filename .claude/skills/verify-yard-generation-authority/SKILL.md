---
name: verify-yard-generation-authority
description: Verify policy, runtime-catalog and connector evidence around funded Yard generation when changing generation admission or provider dispatch.
---

# Yard generation authority

**Properties:** Yard generation may claim and invoke a provider only while the selected generation policy, runtime catalog, connector and plan remain current. The provider call uses the approved connector methods even if another lookup changes. If authority changes after a provider effect, the original hold is marked uncertain, or a failed uncertainty write is reported while the hold remains. An unavailable initial runtime catalog returns a rejection before a hold or provider call. A failure can provision against a revoked policy or runtime, send work to another connector, issue a stale receipt or leave exposure unreconciled.

**Review baseline:** commit `e8df8145fe2600b9c2f16be91aeca704d8058c59`. PASS for the bounded models, symbolic abstraction and real-code tests below. The request parser refuses malformed constraints and estimates before generation; `verify-yard-request-validation` checks that boundary separately. `verify-yard-json-constraints` checks structural property matching, and `verify-yard-residency-validation` checks residency preflight before this generation flow.

## Covered code

- `packages/broker/src/yard-placement/deploy.ts` snapshots generation policy, runtime catalog and connector identity and methods, checks them around the policy callback, claim, provider effect and receipt, pins the selected methods for the saga and inspection, and retains or marks the original hold on the covered failures.
- `packages/broker/src/yard-placement/generation.ts` plans a generation and invokes the supplied connector; `packages/broker/src/rejections.ts` describes unavailable runtime and uncertain-generation outcomes.
- `packages/broker/test/yard-event-store-folds.test.ts` uses a real SQLite authority and a real generation connector to exercise changed or replaced policy, runtime, catalog reader, registry, connector and method before and after a claim or provider effect. It checks an unavailable initial catalog, a redirected lookup, a policy change during final receipt authorization, and a foreign Camp refused before funding or provisioning. It also runs 80 generated combinations (seed 614528). Yard placement and event-store resolver tests exercise integration. `verify-yard-camp-binding` models Camp preflight separately.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-generation-authority
```

The shared runner checks the pinned TLC 1.7.4 jar and Z3 4.15.4. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to existing installations or allow the runner to obtain them. Java 11+, Python, Node, Vitest, fast-check and installed workspace dependencies are required. Use `/statechart` on each model and view to inspect its transitions and counterexamples.

## Scope and evidence

`YardGenerationAuthority` explores 140 states for abstract policy, runtime and connector currency before claim, authority at the provider effect and afterward, and uncertainty-write availability. Its six-state projection hides 64 same-label steps. The model starts with an already retained hold and abstracts each local check and the external provider operation; it does not establish atomicity between all TypeScript steps. `YardConnectorPin` explores four states for an approved connector and a redirected later lookup; its two-state projection hides two same-label steps. `YardRuntimeSnapshot` explores four states for available or unavailable initial runtime evidence; its three-state projection hides two same-label steps. Nine weakened model guards produce counterexamples.

Z3 checks the stated guard implications over arbitrary abstract connector identities and Boolean authority facts. Ten weakened premises produce counterexamples. Real-code tests replay the revoked-policy and runtime traces, and a redirected-lookup trace against the broker; the corresponding broken implementations fail. Fourteen real-code mutations first require a passing unmodified control, then require actual running tests to fail. Run them with `python3 .agents/skills/verify-yard-generation-authority/mutations/real-code.py`.

The host owns and authenticates policy, runtime, connector and provider facts. These checks observe evidence at discrete points and cannot detect a change restored between observations, prove what a remote connector executes, prove TypeScript refinement or establish liveness. They do not prove the full Yard generation saga or cross-process execution; `verify-yard-funded-admission` covers quote, financial hold and selected-work checks separately.

For an implementation mutation, copy `packages/broker` to a scratch package with linked `node_modules`, set `BROKER_YARD_GENERATION_VERIFY_PACKAGE_ROOT`, and remove the generation-policy content comparisons. The real-code tests must fail. Restore the source and rerun the unmodified skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update the models and tests for intended changes, replay counterexamples, test a broken scratch implementation, and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
