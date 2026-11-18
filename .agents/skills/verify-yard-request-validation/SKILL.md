---
name: verify-yard-request-validation
description: Verify that malformed Yard placement requirements and missing estimates are refused before host authorization.
---

# Yard deployment request validation

**Property:** Placement refuses malformed explicit estimates, selection modes, exact Yard requests without an ID, and Yard, Bindle and Camp constraints before asking a host to authorize work. Dropping a malformed constraint could otherwise route a workload without a restriction the caller intended, such as data residency.

**Review baseline:** commit `2e7dd7cfd6854acc1d5fb52eb11da6f87daa9868`. PASS for the model and executable checks below. Special JSON key preservation and nested immutability are checked separately by `verify-yard-json-constraints`; semantic residency tags and the funded-generation preflight are checked by `verify-yard-residency-validation`. Exact Camp selection without an ID is checked by `verify-yard-camp-binding`.

## Covered code

- `packages/broker/src/yard-placement/deploy.ts`: `resolveBindleDeployment` snapshots and parses a request before policy or host callbacks. `parseBindleDeploymentRequest` requires a finite nonnegative estimate and an ID for exact Yard selection, preserves explicit zero, rejects invalid explicit selection modes and blank Yard IDs, and validates supplied constraint lists, labels, layouts and nested Camp declarations before normalization.
- `packages/broker/test/yard-request-validation.test.ts` reproduces the former bug: a malformed residency value was dropped, and a local host authorized the resulting unrestricted request. It checks rejection before authorization, a missing exact Yard ID, invalid amounts and constraint fields, the intentional default selection modes, and 100 generated unrecognized modes (seed 614579). Parser, Camp and wire suites run with it.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-request-validation
```

The shared runner checks the pinned TLC 1.7.4 jar. Set `TLA2TOOLS` to an installed copy or let the runner obtain it. Java 11+, Node, Vitest, fast-check and workspace dependencies are required. The wire suite also needs CUE 0.14.0 at `.tools/cue/v0.14.0/cue` or in `HOBO_CUE_BIN`. Use `/statechart` on the model and view to inspect transitions and counterexamples.

## Scope and evidence

`YardRequestValidation` explores 25 states for 11 request classes, including explicit zero, positive estimates, the default selection mode and malformed amounts, modes, Yard identity, constraint lists, labels, Bindle requirements and Camp requirements. It checks refusal before an authorization callback and that the modeled valid requests are not rejected. Its four-state projection has three arrows and hides 11 same-label steps. Five weakened model guards produce counterexamples. Seven real-source mutations can be run with `python3 .agents/skills/verify-yard-request-validation/mutations/runtime.py`; each first requires a passing control and then a failed assertion.

The parser model treats the synchronous parse as one step and abstracts Yard matching, policy and the host as a later authorization request. `verify-yard-request-wire` separately models exact Yard identity at the decoder and CUE boundaries. This skill does not prove that valid restrictions are satisfied by the selected Yard, that the host approves, that JavaScript refines the model, or that non-JSON JavaScript values survive the initial JSON snapshot. An absent selection mode intentionally defaults to `compatible`; an absent estimate no longer defaults to zero. Existing callers must supply an estimate and exact Yard ID explicitly and recompute affected request digests and quotes.

For the mandatory broken-code check, copy `packages/broker` to a scratch directory, link its `node_modules`, remove its copied `tsconfig.json`, set `BROKER_REQUEST_VERIFY_PACKAGE_ROOT`, and remove `validateRequestedYardLayout(yardRaw.requestedLayout);` from the copied `deploy.ts`. Run this skill: the real-code residency test must fail on an assertion showing that invalid work was authorized. Restore the source and rerun the unmodified skill.

## Keep in sync

Review every change to covered code since the baseline. Update the model and tests from the code, preserve the property unless there is evidence of an intended policy change, replay counterexamples on the implementation, exercise a broken scratch implementation and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
