---
name: verify-yard-local-hosting
description: Verify explicit local-hosting policy, zero-liability proof, current context and funded generation when changing Yard-first admission.
---

# Yard local-hosting authorization

**Properties:** Local Yard placement without a durable hosting budget requires a host policy decision with fulfilled obligations, an evidence reference, a SHA-256 policy digest, an exact work-binding digest and zero managed-hosting liability. The authority, budget, broker, tenant, catalog, request and selected work must remain current around the callback. A local placement proof cannot authorize Yard generation. A failure can run a paid or policy-denied workload without a financial hold.

**Review baseline:** commit `2a3a383c304d96e1a0306a89c43838f1bfd80059`. PASS for the bounded models, symbolic abstraction and generated tests below.

## Covered code

- `packages/broker/src/yard-placement/deploy.ts` gates local economic eligibility on an explicit host, hashes the request, catalog, Yard and selected placements, obtains the policy proof, validates its fields, checks context before and after the host callback, and attaches the proof to the receipt. The generation path has no selected placements and requires a durable budget authority.
- `packages/broker/src/yard-placement/types.ts` defines `LocalHostingProof`; the host API is `YardFirstPlacementDeps.authorizeLocalHosting` and its immutable context is `LocalHostingAuthorizationContext`.
- `packages/hobo/src/broker-runtime.ts` supplies an embedded local-process policy. It asserts only the HoBo local-process service fee and checks the local provider, catalog, tenant, region, unit and zero advertised service price. Infrastructure and third-party charges are outside that assertion.
- `packages/broker/test/yard-local-funding.test.ts` checks missing and malformed proof, wrong work binding, denial, obligations, policy and evidence, nonzero liability, authority and context changes, and refusal before local generation. It compares 160 generated Boolean combinations to an independent reference (seed 614524). The surrounding Yard and hosting tests exercise integration. `broker-runtime.test.ts` and `broker-runtime-catalog.test.ts` exercise the embedded host after a workspace build.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-local-hosting
```

The shared runner checks the pinned TLC 1.7.4 jar and Z3 4.15.4. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to existing installations or let the runner obtain them. Java 11+, Python, Node, pnpm, Vitest, fast-check and installed workspace dependencies are required. Use `/statechart` on each model and view to inspect the transitions and any counterexample.

## Scope and evidence

`LocalHostingProof` explores 128 states for abstract authority, binding, policy, obligations, evidence and zero-liability predicates. It checks that each is present before approval. Its three-state projection hides 64 same-label steps. `LocalHostingContext` explores 34 states for identity, authority and evidence changes around the host callback and before receipt issuance; its four-state projection hides 16 same-label steps. `LocalYardGeneration` explores eight states and checks durable funding is necessary before generation. Its three-state projection hides four same-label steps; actual paid admission also requires the other checks in the budget authority.

Eleven weakened model guards and eleven symbolic Boolean premises yield counterexamples. Fifteen real-code mutations exercise missing or invalid proofs, policy and evidence, incorrect liability, authority, budget, broker, tenant and catalog changes, a post-callback receipt race, and an unbudgeted generation. The unmodified tests exercise the actual broker and embedded host. The model treats hash equality, host policy, zero liability and durable funding as trusted predicates; Z3 proves only the stated guard implications, not the TypeScript implementation.

The host callback is the trust boundary: a digest does not authenticate a dishonest policy or establish actual provider bills. The embedded proof excludes the machine's infrastructure and third-party costs. Proofs are checked during resolution, not again at an external receiver, and the Yard protobuf and CUE receipt omit the local proof. Cross-process execution claims, remote effects, full liveness and funded quote checks remain outside this skill. `verify-yard-funded-admission` checks funded quote content, selected work, context and hold fences separately.

For an implementation mutation, copy `packages/broker` to a scratch package with linked `node_modules`, set `BROKER_YARD_LOCAL_VERIFY_PACKAGE_ROOT`, and remove the work-binding or zero-liability check. The real-code tests must fail. Restore the source and rerun the unmodified skill. Set `HOBO_YARD_LOCAL_VERIFY_PACKAGE_ROOT` to check a scratch embedded host.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update the models and tests for intended changes, replay counterexamples, test a broken scratch implementation, and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
