---
name: verify-yard-residency-validation
description: Verify that Yard residency requirements are syntactically valid before a matching explicit attestation can make a Yard eligible.
---

# Yard residency attestation validation

**Property:** A Yard is eligible for a residency requirement only if the requested jurisdiction and optional data classification are recognized, even when the Yard repeats the same tag. Otherwise a malformed or unknown restriction can reach host authorization as though it were valid.

**Review baseline:** commit `ca55d130e271c6e102534dbe6178b0c8c53296f9`. PASS for the model and executable checks below.

## Covered code

- `packages/broker/src/yard-placement/matching.ts`: `residencyFailure` parses the classification and jurisdiction before accepting an exact Yard attestation; otherwise it checks the Yard's declared regions through the core residency evaluator. `matchYard` makes failures ineligible.
- `packages/broker/test/yard-residency-validation.test.ts` exercises invalid jurisdictions and classifications that are repeated by the Yard, a valid explicit attestation, and the real placement path with no host authorization on invalid evidence. It generates 100 unknown jurisdiction names with seed 614583. Existing Yard placement and matcher tests run alongside it.
- `packages/core/src/ports/jurisdiction.ts` defines recognized classifications and jurisdictions and the region evaluator; the finite model treats their result as an input rather than proving the dictionary or evaluator.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-residency-validation
```

The shared runner checks the pinned TLC 1.7.4 jar. Set `TLA2TOOLS` to an installed copy or let the runner obtain it. Java 11+, Node, pnpm, Vitest, fast-check and workspace dependencies are required. The real-code check builds `@hobo/core` first so it exercises the current jurisdiction parser. Use `/statechart` on the model and view to inspect transitions and counterexamples.

## Scope and evidence

`YardResidency` explores 16 states for valid or invalid tags, an explicit matching attestation, and sufficient or insufficient region evidence. It checks that invalid tags are refused, evidence is required, and a valid explicit attestation is accepted. Its three-state projection has two arrows and hides eight same-label steps. Restoring early explicit acceptance produces a model counterexample and a real-source assertion failure; run `python3 .agents/skills/verify-yard-residency-validation/mutations/runtime.py` for the latter.

The finite model abstracts the core jurisdiction parser, the region evaluator and the Yard's attestation. An explicit valid attestation is trusted and takes precedence over region-derived evidence; this check does not independently establish actual data location, prove that the attestation is honest, or prove TypeScript refinement. Camp residency, remote execution and liveness are outside this skill.

For the mandatory broken-code check, copy `packages/broker` to a scratch directory, link its `node_modules`, remove its copied `tsconfig.json`, set `BROKER_RESIDENCY_VERIFY_PACKAGE_ROOT`, and insert `if (yard.layout.residency.includes(entry)) return undefined;` before the `const separator = entry.indexOf(":");` line in the copied matcher. Run this skill: the real placement test must fail on an assertion because the invalid attestation reaches authorization. Restore the source and rerun the unmodified skill.

## Keep in sync

Review every change to covered code since the baseline. Update the model and tests from the code, preserve the property unless there is evidence of an intended policy change, replay counterexamples on the implementation, exercise a broken scratch implementation and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
