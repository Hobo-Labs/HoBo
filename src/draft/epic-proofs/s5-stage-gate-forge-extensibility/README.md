# S5 Stage Gate — Forge & Extensibility

CI-runnable Stage-5 gate drill for **HOBO-655**. Composes existing generation, registry, eval, and live-fix draft contracts into one epic reference simulation — no production `packages/forge` code.

Reference service: `services/s5-stage-gate-reference.ts`

## Commands

```bash
pnpm --prefix src/draft/epic-proofs/s5-stage-gate-forge-extensibility test
pnpm --prefix src/draft/epic-proofs/s5-stage-gate-forge-extensibility run simulate
```

## Stage gate (BDD)

```gherkin
Feature: Forge a certified provider

  Persona: Platform engineer certifying a generated provider

  Scenario: hobo forge yields a signed Registry listing
    Given a reference backend URL and no-egress certification loop
    When the platform engineer runs hobo forge against the URL
    Then the provider passes per-interface conformance and trace replay
    And the Registry records gen.PluginCertified with SLSA provenance
    And install verification makes the listing available to Matching without auto-selection
```

```gherkin
Feature: Deploy forged provider

  Persona: Platform engineer on the J5 certify-generated-provider journey

  Scenario: Forged provider deploys a Bindle resource end-to-end
    Given a certified forged provider installed from the Registry
    When the engineer deploys a Bindle that claims the provider capability
    Then the resource reaches ready status with the provider digest pinned
```

```gherkin
Feature: Promote stub implementation

  Persona: ML operations engineer promoting a generated semantic function

  Scenario: Stub port implementation reproduces traces and passes eval gate
    Given recorded stub traces and a conformance-green candidate
    When the eval promotion gate runs with policy allow
    Then the challenger promotes through conformance, eval, and policy lenses
```

```gherkin
Feature: Gated live-fix with auto-rollback

  Persona: SRE repairing a simulated SLO regression

  Scenario: Low-risk fix canaries, regresses, auto-rolls back, and keeps the failing trace as a test
    Given a staging incident and a low-risk generated fix candidate
    When the canary observes an SLO regression
    Then deployment rolls back and the failing trace is retained as a permanent regression test
```

## Adversarial coverage

- Tampered signed artifacts fail install verification (`artifact.digest_mismatch`).
- Unsigned artifacts are refused (`signature.required`).
- Production live-fix candidates require human approval before canary.

## Composed POCs

| Slice | Source contracts |
|---|---|
| Forge + certification | `generation-reference-run-contract`, `generation-certify-stage-contract` |
| Registry install | `signed-artifact-publish-install-contract` |
| Eval promotion | `eval-promotion-gate-contract` |
| Live-fix rollback | `live-fix-gated-candidate-contract` |

## Architecture evidence

- `architecture/` — protobuf + CUE guard artifacts
- `architecture.md` — parse-don't-validate and event-sourcing notes
- `contracts/pacts/` — four mocked service boundaries
- `tests/reference-architecture.test.ts` — architecture artifact boundary test pins proto/CUE/Pact/event-architecture evidence (S3-08 pattern)
