---
name: verify-yard-json-constraints
description: Verify preservation, immutability and structural matching of Yard JSON placement properties and labels.
---

# Yard JSON constraints

**Property:** The broker preserves JSON property and label keys without using inherited setters, prevents mutation of the parsed nested values, and matches structured properties by value. Losing a key can remove a placement restriction; comparing object identities can reject two equal requests or rank the wrong Yard.

**Review baseline:** commit `6771c17c043c776bb4b6d5b14e451d4935eb8b97`. PASS for the model and executable checks below. Residency tag validation in the same matcher and request parser is checked separately by `verify-yard-residency-validation`.

## Covered code

- `packages/broker/src/yard-placement/types.ts` and `deploy.ts` construct string and JSON maps without invoking inherited setters, retain special keys such as `__proto__`, and freeze nested arrays and objects in the parsed Yard layout.
- `packages/broker/src/yard-placement/matching.ts` compares JSON properties structurally for both compatibility and specificity. Array order matters; object insertion order does not. Inherited object properties do not count as declared Yard properties. A property absent from a Yard remains unconstrained under the existing matching policy.
- `packages/broker/test/yard-json-constraints.test.ts` covers separately parsed nested values, conflicts, special keys, nested immutability, inherited names and version 2 wire round trips. It generates 100 JSON values with seed 614580 and 100 label maps with seed 614581. The matching, parsing and wire suites run alongside it.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-json-constraints
```

The shared runner checks the pinned TLC 1.7.4 jar. Set `TLA2TOOLS` to an installed copy or let the runner obtain it. Java 11+, Node, Vitest, fast-check and workspace dependencies are required. The wire suite also needs CUE 0.14.0 at `.tools/cue/v0.14.0/cue` or in `HOBO_CUE_BIN`. Use `/statechart` on the model and view to inspect transitions and counterexamples.

## Scope and evidence

`YardJsonConstraints` explores nine states for equal structured values, different values and a special key. It checks key preservation, an immutable captured array, structural matching and specificity, and refusal of different values. Its four-state projection has three arrows and hides three same-label steps. Four weakened model guards produce counterexamples. Five source mutations can be run with `python3 .agents/skills/verify-yard-json-constraints/mutations/runtime.py`; each must pass its control and then fail an actual assertion.

The finite model abstracts recursive JSON comparison and hashing; it does not prove TypeScript refinement, unbounded recursion, transport authentication, or that a Yard's declared properties are true. This skill retains the existing policy that a missing Yard property is unconstrained. The separate `verify-yard-request-wire` skill covers versioned encoding, duplicate-label refusal and the request digest; version 1-only receivers cannot consume the new version 2 encoder.

For the mandatory broken-code check, copy `packages/broker` to a scratch directory, link its `node_modules`, remove its copied `tsconfig.json`, set `BROKER_JSON_VERIFY_PACKAGE_ROOT`, and replace `!jsonValuesEqual(actual, value)` with `actual !== value` in the copied matcher. Run this skill: the nested JSON matching test must fail on an assertion. Restore the source and rerun the unmodified skill.

## Keep in sync

Review every change to covered code since the baseline. Update the model and tests from the code, preserve the property unless there is evidence of an intended policy change, replay counterexamples on the implementation, exercise a broken scratch implementation and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
