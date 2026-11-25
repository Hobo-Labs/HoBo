# Governance Planes S6-08 — Stage-6 Evidence Rollup

Independent draft POC for **HOBO-663**. Productionizes the four Stage-6
governance evidence items from `docs/design/governance-planes.md` (Plan 46) as
one runnable reference architecture. Promotes scenarios from
`src/draft/epic-proofs/contracts-policy-governance/` and the AI-safety gates of
`src/draft/epic-proofs/generation-pipeline-training-ai-safety/` without
importing unmerged production packages.

## Cascade reconciliation

The referenced `capability-indexed-discovery-contract` technical proof was refreshed in the latest technical-proof commit; this rollup retains its certified-listing governance scope and simulation.

## Stage-6 evidence (acceptance)

| Evidence item | Proven behavior |
|---|---|
| Consent-gated notify | `hobo:notify` send denied without consent; granted consent emits `notification.Requested` + `notification.Delivered` |
| Residency + crypto-shred | PHI outside allowed region denied at `can-deploy`; `hobo erase` crypto-shreds subject without log rewrite |
| Blocked flagged model output | Guardrail failure emits `guardrail.Blocked`; output withheld from Operator/agent |
| Certified-only Registry install | Matching discovery returns certified listing only; uncertified stays unlisted |

## BDD scenarios

```gherkin
Feature: Stage-6 governance planes

  Scenario: Consent-gated notify send
    Given a recipient with granted product-notification consent
    When the yard dispatches a notify send through hobo:notify
    Then notification.Requested is appended with the consent reference
    And notification.Delivered records the outcome

  Scenario: Residency obligation with crypto-shred erasure
    Given phi-classified data constrained to us-east-1
    When a deploy plan targets eu-central-1
    Then can-deploy denies with a residency violation
    And hobo erase crypto-shreds the subject key without rewriting history

  Scenario: Guardrail blocks flagged model output
    Given an agent output that fails the PII guardrail rail
    When the enforced guardrail step evaluates the buffered window
    Then guardrail.Blocked is recorded and output is not released

  Scenario: Certified-only Registry install via Matching
    Given a certified listing and a failed-certification listing
    When Matching discovers providers for a WIT port
    Then only the certified listing can install
```

## Run

```bash
pnpm --prefix src/draft/epic-proofs/governance-planes-s6-08 test
```

## Mocked boundaries

- Policy plane (`evaluateDataGovernancePolicy`, `decideGuardrailStep`)
- Crypto-shred keyring + append-only log
- Capability discovery index (Registry + Matching projection)
- The validated capability-indexed discovery proof is included in this rollup; its deterministic simulation contract is unchanged.
- Consent registry (in-memory fixture)

## Architecture evidence

- `architecture/` — protobuf + CUE + PACT boundary contract
- `ADR.md` — parse-don't-validate + event architecture notes
- `architecture.md` — service boundary map

## Scope out

- Production `packages/cloud`, `packages/policy`, `packages/registry` code
- Live NeMo Guardrails / Microsoft Responsible AI toolkit
- Stage-6 acceptance record (owned by HOBO-656 / S6-01)
