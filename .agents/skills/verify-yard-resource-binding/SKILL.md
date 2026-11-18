---
name: verify-yard-resource-binding
description: Verify exact associations between Yard resource requests, selected definitions and execution units when changing parsing or Yard receipt construction.
---

# Yard resource-to-definition binding

**Properties:** Every resource execution unit records exactly the definition selected for that resource, duplicate or malformed resource identities are refused, and later mutation of the caller's resource list cannot change the accepted request. A failure can attach another resource's provider definition, omit the selected definition, or produce ambiguous duplicate execution units.

**Review baseline:** commit `3d9ddf95b2738567113427457b47497b5d5750e1`. PASS for the bounded models, symbolic abstraction and generated tests below. The request parser refuses malformed constraints and estimates before resource placement; `verify-yard-request-validation` checks that boundary separately. `verify-yard-json-constraints` covers special keys and structural property matching, and `verify-yard-residency-validation` covers residency preflight.

## Covered code

- `packages/broker/src/yard-placement/deploy.ts` snapshots and parses the request before callbacks, validates resource IDs and ports, rejects duplicate resource IDs, places each resource, and passes explicit selected resource/definition pairs to receipt construction.
- `packages/broker/src/yard-placement/resolvers.ts` implements `buildExecutionUnits`. It checks unique nonempty resource identities and nonempty definition identities and records each pair directly. Its public input is `resourcePlacements`, not the former parallel ID arrays.
- `packages/broker/test/yard-resource-binding.test.ts` checks a concrete substring collision, direct duplicate IDs, malformed request input, a caller mutation during a capability callback and 100 generated resource/definition arrays (seed 614523). The surrounding Yard placement, parsing, residual-placement and event-store tests exercise integration.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-resource-binding
```

The shared runner checks the pinned TLC 1.7.4 jar and Z3 4.15.4. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to existing installations or let the runner obtain them. Java 11+, Python, Node, Vitest, fast-check and installed workspace dependencies are required. Use `/statechart` on each model and view to inspect transitions and counterexamples.

## Scope and evidence

`YardBinding` explores 64 states for two abstract resource identities and two arbitrary definition labels. It checks that both units contain exactly their own selected definition and that duplicate resource identities cannot be accepted. The three-state projection hides 32 same-label steps. `YardRequestSnapshot` explores four states where the caller may change its resource identity while a callback is in progress; its three-state projection hides two same-label steps. Four weakened model checks yield counterexamples.

Z3 checks two arbitrary resource and definition IDs under a unique-resource premise and a private snapshot. Separate non-vacuity witnesses and three broken proof variants exercise association, uniqueness and snapshot premises. Six implementation mutations reproduce substring matching, wrong-definition assignment, duplicate parser and unit admission, missing identity validation and a missing input snapshot. The full skill is also run on a broken scratch implementation and then restored.

The models abstract catalog selection as an already chosen association and do not prove capability matching, actual provider execution, atomic persistence or TypeScript refinement. They cover the copied resource list, not mutable host callbacks or every nested request field. Camp parsing and the new preflight refusals precede residual binding; `verify-yard-camp-binding` checks them separately. The separate `verify-yard-request-wire` skill checks the request codec, while the protobuf receipt still omits execution-unit details; this model does not establish a wire round trip. `verify-yard-local-hosting` checks local host authorization, and `verify-yard-funded-admission` checks funded quote-to-work and context fences separately; the outer broker receipt requires separate work.

For implementation mutation, copy `packages/broker` to a scratch package with linked `node_modules`, set `BROKER_YARD_BINDING_VERIFY_PACKAGE_ROOT`, and replace the direct definition association with substring filtering. The real-code tests must fail. Restore the source and rerun the unmodified skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update the models and tests for intended changes, replay counterexamples, test a broken scratch implementation, and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
