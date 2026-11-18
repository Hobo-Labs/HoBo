---
name: verify-yard-local-hosting
description: Verify explicit local-hosting policy, zero-liability proof, current context, runtime requirements and funded generation when changing Yard-first admission.
---

# Yard local-hosting authorization

**Properties:** Local Yard placement without a durable hosting budget requires a host policy decision with fulfilled obligations, an evidence reference, a SHA-256 policy digest, an exact work-binding digest and zero managed-hosting liability. The authority, budget, broker, tenant, catalog, request and selected work must remain current around the callback. A local placement proof cannot authorize Yard generation. The embedded local-process proof only admits locally satisfiable resource-derived and declared runtime requirements, which must remain current at the observed authorization and handoff checks. A failure can run paid work without a financial hold or approve a different host from the one requested.

**Review baseline:** commit `b033962d0ba0eae3b3f3cc6402cd98cb2ee0b905`. PASS for the bounded models, symbolic abstraction and generated tests below. The request parser refuses malformed constraints and estimates before local authorization; `verify-yard-request-validation` checks that boundary separately. `verify-yard-json-constraints` checks structural property matching, and `verify-yard-residency-validation` checks residency preflight before authorization.

## Covered code

- `packages/broker/src/yard-placement/deploy.ts` gates local economic eligibility on an explicit host, hashes the request, catalog, Yard and selected placements, obtains the policy proof, validates its fields, checks context before and after the host callback, and attaches the proof to the receipt. The generation path has no selected placements and requires a durable budget authority.
- `packages/broker/src/yard-placement/types.ts` defines `LocalHostingProof`; the host API is `YardFirstPlacementDeps.authorizeLocalHosting` and its immutable context is `LocalHostingAuthorizationContext`.
- `packages/hobo/src/broker-runtime.ts` supplies an embedded local-process policy. It asserts only the HoBo local-process service fee, checks the local provider, catalog, tenant, region, unit and zero advertised service price, rejects nonlocal runtime requirements, binds a supplied SHA-256 workload digest into the Yard request, and rechecks resource-derived and declared requirements around approval and before returning the placement. Infrastructure and third-party charges are outside that assertion.
- `packages/broker/test/yard-local-funding.test.ts` checks missing and malformed proof, wrong work binding, denial, obligations, policy and evidence, nonzero liability, authority and context changes, and refusal before local generation. It compares 160 generated Boolean combinations to an independent reference (seed 614524). The surrounding Yard and hosting tests exercise integration.
- `packages/hobo/test/runtime-requirements.test.ts` and `declared-runtime-binding.test.ts` test real embedded placements, missing runtimes and requirement changes during authorization and handoff. They include 20 generated resource cases (seed 614529), 24 generated declared-runtime lists (seed 614530) and 100 Bindle inference combinations (seed 614531). `broker-runtime.test.ts`, `broker-runtime-catalog.test.ts` and `local-work-binding.test.ts` exercise the embedded host and supplied workload digest after a workspace build. The deployment test copies the example into a temporary workspace project, excluding its deployment state, before running `up` and `down`. `verify-bindles-runtime-inference` separately covers authoring inference.

## Run

```sh
bash scripts/verify-state-machine.sh .agents/skills/verify-yard-local-hosting
```

The shared runner checks the pinned TLC 1.7.4 jar and Z3 4.15.4. Set `TLA2TOOLS` and `BUDGET_Z3_PYTHONPATH` to existing installations or let the runner obtain them. Java 11+, Python, Node, pnpm, Vitest, fast-check and installed workspace dependencies are required. Use `/statechart` on each model and view to inspect the transitions and any counterexample.

## Scope and evidence

`LocalHostingProof` explores 128 states for abstract authority, binding, policy, obligations, evidence and zero-liability predicates. It checks that each is present before approval. Its three-state projection hides 64 same-label steps. `LocalHostingContext` explores 34 states for identity, authority and evidence changes around the host callback and before receipt issuance; its four-state projection hides 16 same-label steps. `LocalYardGeneration` explores eight states and checks durable funding is necessary before generation. Its three-state projection hides four same-label steps; actual paid admission also requires the other checks in the budget authority.

`EmbeddedLocalRuntime` explores 132 states, distinguishing resource-derived and declared requirements and whether each is stable at authorization and handoff. It checks local host and local requirements, plus the two observed stability checks. Its five-state projection hides 64 same-label steps. A mutant that ignores a declared nonlocal requirement reaches a local placement without the requested runtime; the real placement tests reproduce that failure.

Seventeen weakened model guards and nineteen symbolic premises yield counterexamples. Fifteen earlier broker mutations and six embedded-host mutations exercise proof checks, context changes, runtime scope and both requirement snapshots. The optional embedded checks are `python3 .agents/skills/verify-yard-local-hosting/mutations/runtime.py` and `python3 .agents/skills/verify-yard-local-hosting/mutations/declared.py`; each requires a passing control and actual assertion failures. The unmodified tests exercise the actual broker and embedded host. The models treat hash equality, runtime classification, host policy, zero liability and durable funding as trusted predicates; Z3 proves only the stated guard implications, not the TypeScript implementation.

The host callback is the trust boundary: a digest does not authenticate a dishonest policy or establish actual provider bills. The embedded proof excludes the machine's infrastructure and third-party costs. Requirement checks observe discrete points and cannot detect changes reverted between observations. Proofs are checked during resolution, not again at an external receiver, and the Yard protobuf and CUE receipt omit the local proof. Camp parsing and Yard containment are checked separately by `verify-yard-camp-binding`. This model trusts the workload digest's provenance and does not enforce what a receiver executes; `verify-hobo-local-work-binding` separately checks that HoBo's local fallback executes its content-addressed approved copy. Other receivers, remote effects, full liveness and funded quote checks remain outside this skill. `verify-yard-funded-admission` checks funded quote content, selected work, context and hold fences separately.

For an implementation mutation, copy `packages/broker` to a scratch package with linked `node_modules`, set `BROKER_YARD_LOCAL_VERIFY_PACKAGE_ROOT`, and remove the work-binding or zero-liability check. The real-code tests must fail. Restore the source and rerun the unmodified skill. Set `HOBO_YARD_LOCAL_VERIFY_PACKAGE_ROOT` to check a scratch embedded host; arrange its workspace example fixture before running the full skill.

## Keep in sync

Review covered code and uncommitted changes since the baseline. Update the models and tests for intended changes, replay counterexamples, test a broken scratch implementation, and rerun the unmodified skill before advancing the baseline. Use `/maintain-formal-verification-skill`.
