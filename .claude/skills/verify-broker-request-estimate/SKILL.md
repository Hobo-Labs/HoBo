---
name: verify-broker-request-estimate
description: Verify explicit broker spend estimates across JSON, protobuf and the broker CLI when changing request parsing or budget inputs.
---

# Broker request estimate presence

**Properties:** A request document must provide a finite nonnegative estimate, even when it is zero. Both JSON field spellings must agree. Protobuf round trips preserve the difference between an absent estimate and explicit zero. The CLI derives zero only for the built-in local-host catalog; registry-backed requests need an explicit request document.

**Review baseline:** commit `bd71ef73715bedf6cfc5f22874a5e0cd42fe6d19`. PASS for the checks and abstraction below.

## Covered code

- `packages/broker/src/policies.ts`, `packages/broker/data-models/broker.proto` and its generated `src/_generated/broker_pb.ts` define the JSON and wire boundary. `packages/broker/data-models/broker.cue` requires the estimate.
- `packages/hobo/src/broker-command.ts` chooses the local catalog or requires a request document for registry-backed `broker up`.
- `packages/broker/test/request-estimate-presence.test.ts` checks absent versus explicit zero through real protobuf binary and JSON, both aliases, 500 generated explicit values (seed 614503) and 500 generated conflicts (seed 614504). `packages/broker/test/local-host.test.ts` checks every local catalog definition has zero marginal price. `packages/hobo/test/broker-command.test.ts` exercises the real CLI assembly, local flow and registry refusal.

## Run

After installing and building workspace dependencies, run from the repository root:

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-broker-request-estimate
```

The check runs the actual parser and CLI tests, checks broker code generation with the repository's Buf and CUE tools, explores the TLA+ model and runs the exact-real Z3 proof. The shared runner uses checksum-pinned TLC 1.7.4; set `TLA2TOOLS` to that jar or let it download the jar. Set `BUDGET_Z3_PYTHONPATH` to `z3-solver==4.15.4.0`, or let the proof install it temporarily. Set `HOBO_CUE_BIN` to CUE 0.14.0 if it is not on PATH. Java 11+, Python with pip, Node, Vitest, fast-check and built workspace dependencies are required. Use `/statechart` to read the model and its view.

## Scope and evidence

TLC explores 14 states for document inputs classified as missing, zero, positive, invalid or conflicting, plus the two CLI paths. It checks that unknown and conflicting estimates do not reach billing, invalid inputs reject, and explicit zero is accepted. The 14-state `/statechart` view hides seven same-label steps. With historical behavior selected, the shortest counterexamples accept an omitted estimate and conflicting aliases; the real-code tests reproduce both. This classification assumes the implementation and protobuf codec map every concrete input to the modeled class; it is not a proof of that mapping.

Z3 proves for arbitrary exact-real numeric values that the abstract alias guards imply at least one value is present, present aliases agree, and the chosen amount is nonnegative. A witness establishes that the premises are satisfiable; removing presence or alias agreement yields counterexamples. This does not prove TypeScript refinement, numeric finiteness, serialization, or caller honesty.

The local CLI assumption depends on `createLocalHostCatalog` advertising only zero-priced definitions. All other estimates remain caller assertions: an explicit zero can still understate a paid deployment. This check does not authenticate prices, bind a quote to a provider or request, or wire the pricing quote helper into the general broker path. Protobuf clients must explicitly serialize zero; old scalar encoders that omitted zero produce an absent field and are rejected until migrated.

For a scratch implementation mutation, copy `packages/broker` or `packages/hobo` to a temporary package directory, link its `node_modules`, and set `BROKER_REQUEST_VERIFY_PACKAGE_ROOT` or `HOBO_REQUEST_VERIFY_PACKAGE_ROOT` respectively. Remove the required-estimate check or restore the registry CLI's fabricated zero; the real-code check must fail. Restore the code and rerun the skill.

## Keep in sync

Review changes to covered code and uncommitted work since the baseline, including the local catalog's prices and the generated wire descriptor. Update the tests and model for intended changes, replay model counterexamples against the code, run a broken scratch implementation and then the unmodified skill, and advance the baseline only after confirming correspondence. Use `/maintain-formal-verification-skill`.
