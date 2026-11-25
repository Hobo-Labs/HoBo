# Contracts, Policy & Governance Reference Implementation

This epic reference implementation rolls policy, contract compatibility, obligation, and governance conformance POCs into one mocked vertical slice.

It is not production HoBo runtime code. It is a repo-local reference architecture package that demonstrates how Gatekeeper evaluates a deploy request through consumer-driven contract compatibility, signed policy packs, deny-ceiling policy, RBAC subject context, obligations, cost/quota, provenance, and governance conformance boundaries.

## Persona and BDD mapping

Feature: governed deploy promotion

Persona: platform SRE responsible for safely promoting a bindle into a production camp.

Scenario: compatible deploy produces auditable approval obligations

```gherkin
Given a production camp has mandatory contract, policy, obligation, cost, provenance, and conformance gates
And the artifact has compatible consumer contracts and trusted provenance
When the platform SRE asks Gatekeeper to verify the deploy
Then Gatekeeper returns an allow decision with deterministic evidence
And required approval and canary obligations are linked to the deploy record
And governance conformance can replay the same decision from recorded evidence
```

Scenario: mandatory governance cannot be bypassed

```gherkin
Given yard policy marks contract and golden-suite gates as mandatory
When a bindle-level policy pack tries to disable those gates
Then the deny ceiling keeps the mandatory gates enabled
And Gatekeeper blocks the deploy if any mandatory gate is missing or failing
```

Scenario: policy uncertainty fails closed

```gherkin
Given the policy engine or signed policy-pack registry is unavailable
When Gatekeeper verifies a production deploy
Then the deploy is denied with a fail-closed reason
And no simulated live service call is required
```

## Reference implementation contents

| Path | Purpose |
|---|---|
| `architecture.md` | Synthesized epic architecture and service boundary map. |
| `poc-rollup-ledger.md` | Disposition of every POC considered for this epic rollup. |
| `scope-review.md` | Adversarial scope review before implementation. |
| `reference-implementation.yaml` | Machine-readable manifest for this run. |
| `contracts/pact-inventory.md` | Contract decisions for each internal and external boundary. |
| `simulation/` | Deterministic mocked harness for the accepted BDD scenarios. |
| `services/` | Reference architecture orchestration code. |
| `adapters/` | Contract generation and mock-provider helpers. |
| `tests/` | Node test harness for scenarios and Pact-style contracts. |

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src/draft/epic-proofs/contracts-policy-governance run simulate
```

What this proves:

- Gatekeeper can evaluate contract, policy, obligation, cost, provenance, and conformance decisions from deterministic mocks.
- Mandatory governance gates remain enforced across the deny ceiling.
- Policy and provider uncertainty fail closed.
- The validated control-plane action taxonomy proof is included in this rollup; its deterministic simulation contract is unchanged.
- The validated deny-ceiling algebra and Gatekeeper verification proofs retain their fail-closed simulation contracts.

Mocked boundaries:

- Contract Engine: in-memory consumer compatibility matrix.
- Policy Engine: signed policy-pack fixture plus deny-ceiling evaluation.
- Obligation Engine: in-memory approval and canary obligations.
- Cost/Quota Policy: deterministic quota fixture.
- Artifact Provenance Verifier: deterministic signing fixture.
- RBAC Directory: fixture-backed role grants.
- Audit Log/Event Projection: in-memory append-only evidence list.
- Governance Conformance Suite: local replay of recorded Gatekeeper evidence.
- Governance-conformance changes are absorbed without changing the deterministic replay or fail-closed policy behavior.

Contracts:

- See `contracts/pact-inventory.md`.


Policy fail-closed changes are absorbed without changing deterministic replay or mandatory governance behavior.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Contracts Policy Governance.
- `architecture/pacts/` — PACT contract for the package boundary.
- `architecture.md` — parse-don't-validate and event-architecture evidence.
