# DX Result Refusal Proof Envelopes

Independent HOBO-571 experience proof for shared typed result, gate,
refusal, and proof-mode envelopes across API, SDK, CLI, MCP, docs, and later
visual mockups.

## Audience

- App developers need actionable terminal and SDK output that separates a
  successful fixture from live deploy readiness.
- Platform engineers need plan, capability, contract, and migration refusal
  states that can route to the right owner.
- SecOps and GitOps reviewers need deterministic machine codes and trace ids
  for policy, approval, and compatibility gates.
- SRE and support operators need customer-safe handoff evidence with redaction
  classes.
- Agent/MCP callers need the same typed cases as human CLI users.

## Scenario

The proof records eleven shared envelopes: success, plan warning, Gatekeeper
denial, approval required, contract incompatibility, stale projection, unknown
evidence, non-reactive sink, migration blocked, rollback available, and support
handoff. Each envelope carries human copy, machine code, remediation, proof
mode, fixture id, trace id, correlation id, redaction class, accessibility
notes, and copy notes.

## Scope

- Defines the common envelope vocabulary and deterministic fixtures for
  downstream DX examples.
- Builds SDK consumer, CLI JSON, and MCP tool-result examples for the same
  cases, including equivalent non-error semantics for warning, rollback, and
  support handoff outcomes.
- Fails closed when proof evidence, remediation, or required cases are missing.
- Labels proof evidence as `live`, `simulated`, `reference-fixture`, or
  `scope-out`.

## Non-Scope

This package does not implement production CLI/API/SDK runtime behavior, live
provider calls, customer data processing, support routing systems, production
telemetry, polished launch copy, or visual mockups.

## Mocked Boundaries

- Production CLI/API/SDK execution.
- Live providers and credentials.
- Customer data and support systems.
- Production telemetry and trace stores.

## Proof Command

```powershell
npm.cmd --prefix src\draft\exp-proofs\dx-result-refusal-proof-envelopes test
```

## Architecture Evidence

- `architecture/dx_result_refusal_proof_envelopes.proto` defines envelope,
  example, fixture, and claim-classification records.
- `architecture/dx_result_refusal_proof_envelopes.cue` constrains required
  fields, proof modes, redaction classes, and fail-closed outcomes.
- `architecture/pacts/dx_result_refusal_proof_envelopes.pact.json` records the
  read contract consumed by SDK, CLI JSON, and MCP tool-result examples.
- The deterministic fixture set carries a stable SHA-256 digest over the
  unsigned fixture payload for downstream transcript/doc reuse.
- `ADR.md` records the experience decision and alternatives.
