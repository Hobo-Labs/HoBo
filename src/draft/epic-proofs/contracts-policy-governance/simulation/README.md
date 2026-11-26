# Contracts, Policy & Governance Simulation

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src/draft/epic-proofs/contracts-policy-governance run simulate
```

What this proves:

- A compatible production deploy produces deterministic Gatekeeper evidence.
- Mandatory gates survive lower-scope policy attempts to disable them.
- Policy provider uncertainty fails closed.

Mocked boundaries:

- Contract Engine: local compatibility matrix fixture.
- Policy Engine: local signed policy-pack and deny-ceiling fixture.
- Obligation Engine: local obligation lifecycle fixture.
- Cost/Quota Policy: local quota fixture.
- Artifact Provenance Verifier: local provenance fixture.
- RBAC Directory: local role/grant fixture.
- Audit Log/Event Projection: local append-only evidence fixture.
- Governance Conformance Suite: local replay over evidence fixture.

Contracts:

- `../contracts/pact-inventory.md`
