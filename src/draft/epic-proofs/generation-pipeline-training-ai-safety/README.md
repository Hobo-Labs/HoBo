# Generation Pipeline, Training & AI Safety

This epic reference implementation rolls the Generation Pipeline child POCs into one runnable architecture slice. It is intentionally not production code: service boundaries are mocked, external providers are absent, and the implementation demonstrates the intended architecture with deterministic fixtures.

Reference service: `services/generation-reference-architecture.ts`

Simulation command:

```bash
npm.cmd --prefix src\draft\epic-proofs\generation-pipeline-training-ai-safety run simulate
```

Test command:

```bash
npm.cmd --prefix src\draft\epic-proofs\generation-pipeline-training-ai-safety test
```

## Persona And BDD

```gherkin
Feature: Certify generated providers

  Persona: Platform engineer certifying a generated provider

  Scenario: Generate and certify a database provider
    Given a target WIT port, capability manifest, sanitized material, and recorded traces
    When the generation loop scaffolds, fills, validates, repairs, and certifies the candidate
    Then the artifact is signed and published only after sandbox validation and safety gates pass
```

```gherkin
Feature: Promote trained semantic functions

  Persona: ML operations engineer improving a generated semantic function

  Scenario: Promote a challenger from trusted training evidence
    Given OpenInference trajectories, privacy filtering, live eval rewards, and poisoning checks
    When the built-in OPTO training engine proposes a region-scoped candidate
    Then the challenger promotes only after conformance, eval, policy, and provenance gates pass
```

```gherkin
Feature: Gate live fixes and generated-stack propagation

  Persona: SRE repairing a drifted generated stack

  Scenario: Retain failing traces and require approval for risky generated changes
    Given a failing production trace and a candidate generated fix
    When the live-fix flow validates the candidate and evaluates blast radius
    Then production or high-risk changes require human approval and generated regions remain synchronized
```

## Vertical Slices

| Slice | Implemented behavior | Main POCs |
|---|---|---|
| Cold-start provider certification | Scaffold, LLM-fill, no-egress validation, bounded repair, safety gate, signed certification, registry publication | HOBO-307, HOBO-320, HOBO-321, HOBO-324, HOBO-327, HOBO-330, HOBO-333, HOBO-346, HOBO-348, HOBO-352, HOBO-355 |
| Training and eval promotion | Trajectory capture, privacy filtering, OPTO candidate generation, live-eval rewards, poisoning guard, champion/challenger promotion | HOBO-309, HOBO-317, HOBO-335, HOBO-338, HOBO-341, HOBO-344, HOBO-351, HOBO-358, HOBO-364 |
| Live-fix and cross-layer propagation | Failing trace retention, live-fix gating, human approval, five-layer generated-stack propagation | HOBO-360, HOBO-368, HOBO-371 |

## What Is Real

- Existing POC contract modules are imported and executed directly.
- The focused package test exercises the reference service, negative cases, and Pact inventory.
- Pact files declare every service boundary used by the simulation.
- Bounded repair, LLM fill, material sanitization, and generation-pipeline IO changes are absorbed without weakening the safety gates.
- Generation safety-gate, validation-stage, and human-approval changes are absorbed without changing the deterministic safety simulation.

OpenInference trajectory-capture changes are absorbed without changing the deterministic generation safety simulation.

## What Is Mocked

- Sandbox validation provider.
- Certification registry provider.
- Trajectory store provider.
- Promotion policy provider.
- Human approval hook provider.

No live external service, network call, credential, customer data, or production token is required.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Generation Pipeline Training Ai Safety.
- `architecture/pacts/` — PACT contract for the package boundary.
- `architecture.md` — parse-don't-validate and event-architecture evidence.

## Cascade reconciliation (83d9b5c92)

The `slsa-provenance-certification-contract` technical proof refresh is absorbed without changing generation, training, or safety evidence.
