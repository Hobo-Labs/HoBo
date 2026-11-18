---
name: verify-hobo-embedded-camp-binding
description: Verify that HoBo's embedded placement captures the caller's Camp and returns the broker-approved Camp.
---

# Embedded HoBo Camp handoff

**Property:** The embedded placement adapter snapshots the requested Camp before asynchronous startup, sends it to the broker as an exact Camp request, and reports the selected Camp from the broker receipt. A foreign-Yard Camp is refused and its original ID is reported. Otherwise a caller can receive a Camp different from the one the broker approved, including an identity in another Yard.

**Review baseline:** commit `2e7dd7cfd6854acc1d5fb52eb11da6f87daa9868`. PASS for the bounded model and executable checks below.

## Covered code

- `packages/hobo/src/broker-runtime.ts`: `resolveBindlePlacement` captures the optional Camp ID, includes it in the Yard-first request, returns `selectedCampId` from the successful Yard receipt and reports the captured ID on rejection.
- `packages/broker/src/yard-placement/deploy.ts` parses the exact Camp request, refuses a foreign or nested Camp and binds the request into local authorization. `verify-yard-camp-binding` separately checks the broker's Camp and quote paths.
- `packages/hobo/test/embedded-camp-binding.test.ts` checks an explicitly named Camp, refusal of a foreign Yard, changes to caller options during startup on success and rejection, and 20 generated local IDs with seed 614586.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-hobo-embedded-camp-binding
```

The shared runner checks the pinned TLC 1.7.4 jar. Set `TLA2TOOLS` to an installed copy or let it obtain one. Java 11+, Node, pnpm, Vitest, fast-check and installed workspace dependencies are required. The real-code check builds `@hobo/hobo` and its dependencies first. Use `/statechart` to inspect each model transition and counterexample.

## Scope and evidence

`EmbeddedCamp` explores 47 states and 71 transitions for absent, same-Yard and foreign requests, with a caller edit before sending, during the broker call or after approval. It checks that the sent request matches the captured input, a foreign Camp cannot be approved, the returned identity matches the receipt, and a rejection reports the original request. The six-state projection has five arrows and hides 36 same-label transitions, including caller edits. Four weakened model checks yield counterexamples. The optional `python3 .agents/skills/verify-hobo-embedded-camp-binding/mutations/runtime.py` requires an unmodified control and four actual assertion failures when capture, forwarding, rejection reporting or receipt use is weakened.

The model treats the broker's foreign-Camp check and receipt as trusted atomic inputs and abstracts provider work, budget admission and later execution. The generated cases do not prove TypeScript refinement. A matching Camp name does not establish that the Camp exists or meets its requested capabilities. Synchronous getters or mutations during the initial read are outside this model.

For a broken-code check, copy `packages/hobo` to a scratch package with linked `node_modules`, remove its copied `tsconfig.json`, set `HOBO_EMBEDDED_CAMP_VERIFY_PACKAGE_ROOT`, and make `requestedCampId === undefined` always true in the copied `broker-runtime.ts`. This skill must fail the real foreign-Camp assertion. Restore the source and rerun the unmodified skill.

## Keep in sync

Review the covered code and uncommitted changes since the baseline. Update the model and tests for intended changes, replay counterexamples against code, exercise a broken scratch implementation and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
