---
name: verify-hobo-budget-fallback
description: Verify that a required hosting budget cannot be waived by HoBo's local placement or preview fallback when a Yard returns a stub.
---

# HoBo budget-required fallback

**Property:** When a hosting budget is required, a remote request without an authoritative path is refused and a local Yard stub cannot fall through to local startup or a successful local preview. The local fallback rechecks observed runtime and flag requirements through its startup handoff. A failure can start work without the required financial admission.

**Review baseline:** commit `fcb3f335f037aa2c0097d50e8741a972947734d1`. PASS for the bounded model, symbolic abstraction and generated tests below.

## Covered code

- `packages/hobo/src/broker-up-command.ts` reads the initial manifest and runtime/flag requirements, dispatches to the Yard, refuses a budgeted fallback after a stub, and rechecks live runtime and flag requirements while preparing local placement and before the start or preview result. The startup path also reloads the manifest from the verified execution copy before placement.
- `packages/hobo/test/local-budget-fallback.test.ts` uses a Bindle whose collection fails but whose definition still loads. It checks refusal, a control that an unbudgeted fallback can reach startup, 32 generated combinations of runtime-required, default-budget, explicit budget and preview inputs (seed 614532), and changes during placement or preview loading. `local-work-binding.test.ts` checks that a budget manifest appearing before the approved copy cannot reach startup. `hosting-remote-admission.test.ts` checks the separate early remote refusal.
- `packages/cli/src/commands/up.ts` and `plan.ts` supply the stub when manifest collection returns no result. The model trusts a non-stub Yard result; it does not prove the Yard's admission.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-hobo-budget-fallback
```

The shared runner checks the pinned TLC 1.7.4 jar and Z3 4.15.4. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to existing installations or let the runner obtain them. Java 11+, Python, Node, pnpm, Vitest, fast-check and installed workspace dependencies are required. Use `/statechart` on the model and view to inspect transitions and counterexamples.

## Scope and evidence

`LocalBudgetFallback` explores 56 states with local or remote targets, a present or absent Yard, preview or startup, and a budget requirement that can appear while the local path is in progress. It checks the early remote gate, refusal before budgeted fallback, and the final local-start and preview gates. Its 13-state projection hides 22 same-label steps. Four weakened model guards and four weakened symbolic premises yield counterexamples. The Z3 proof reasons about Boolean observations and assumes the stated ordering; it does not prove the TypeScript implementation.

Four optional real-code mutants can be replayed with `python3 .agents/skills/verify-hobo-budget-fallback/mutations/runtime.py`. The fallback mutant removes the family of redundant local guards together; each run requires a passing control and an assertion failure in the affected test. A deliberately weakened start guard yields the path: request local deployment, enter fallback, require a budget during preparation, then start without admission. The real placement tests reproduce that failure.

The model treats budget requirements as monotonic while the modeled operation runs. The implementation preserves the initial observation, rechecks live runtime and flag values, and checks the manifest in the content-addressed execution copy, but cannot detect a requirement that appears and disappears between observations. The Boolean model treats creation and verification of that copy as trusted; `verify-hobo-local-work-binding` checks it separately. A non-stub Yard, the remote path after its initial check, trusted financial authority, provider behavior and actual costs remain outside this skill. Budget holds and Yard admission are covered separately by the broker budget skills.

For a full broken-code check, copy `packages/hobo` to a scratch package with linked `node_modules`, set `HOBO_BUDGET_FALLBACK_VERIFY_PACKAGE_ROOT`, and remove the fallback guard family. Confirm a real assertion failure in `test/local-budget-fallback.test.ts`; restore the source and rerun the unmodified skill.

## Keep in sync

Read the covered code and changes since the baseline. Update models and tests for intended changes, replay counterexamples, test a broken scratch implementation, and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
