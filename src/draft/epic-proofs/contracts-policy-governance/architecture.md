# Contracts, Policy & Governance Architecture

## Epic outcome

This reference implementation shows the epic-level governance path for a production deploy. Gatekeeper is the consumer-facing coordination point. It does not own every rule; it gathers focused decisions from policy, contract, obligation, quota, provenance, and conformance boundaries, then emits one deploy-verdict evidence record.

The implementation deliberately stays under `src/draft/epic-proofs/contracts-policy-governance/`. Existing POCs remain source evidence and are not copied wholesale into production paths.

## Personas

| Persona | Goal | Reference scenario |
|---|---|---|
| Platform SRE | Promote a bindle only when compatibility and governance evidence are complete. | Governed deploy promotion. |
| Security/governance lead | Ensure mandatory policy cannot be disabled lower in the hierarchy. | Deny-ceiling bypass prevention. |
| App team owner | Understand why a deploy was blocked and what obligation or contract must be repaired. | Fail-closed and contract-incompatible denial. |

## Vertical slices

| Slice | BDD scenario | Included behavior | Out of scope |
|---|---|---|---|
| Governed deploy promotion | Compatible deploy produces auditable approval obligations. | Contract compatibility, policy allow with obligations, RBAC context, quota/provenance mocks, conformance replay. | Live deploy orchestration, live policy-provider calls, production RBAC directory. |
| Mandatory governance enforcement | Mandatory governance cannot be bypassed. | Deny-ceiling merge from yard to bindle, mandatory gate enforcement, negative case for disabled gate. | Global tenant admin UI and policy authoring workflow. |
| Fail-closed uncertainty | Policy uncertainty fails closed. | Provider outage and invalid evidence denial, deterministic audit reason. | Retry orchestration, incident response workflow beyond a documented exemption surface. |

## Service boundaries

| Boundary | Consumer | Provider | Purpose | Contract strategy |
|---|---|---|---|---|
| Gatekeeper to Contract Engine | Gatekeeper Verify | Contract Engine | Check consumer/provider compatibility before deploy. | Pact-style request/response fixture plus consumer test. |
| Gatekeeper to Policy Engine | Gatekeeper Verify | Built-in Policy Engine | Evaluate signed policy packs, deny ceiling, and deployment context. | Pact-style request/response fixture plus consumer test. |
| Gatekeeper to Obligation Engine | Gatekeeper Verify | Obligation Engine | Create and verify approval/canary obligations. | Pact-style request/response fixture plus consumer test. |
| Gatekeeper to Cost/Quota Policy | Gatekeeper Verify | Cost/Quota Policy | Enforce quota and budget constraints as governance gates. | Mocked provider unavailable; contract documents expected interaction. |
| Gatekeeper to Artifact Provenance Verifier | Gatekeeper Verify | Artifact Provenance Verifier | Verify artifact signature/provenance trust before deploy. | Mocked provider unavailable; contract documents expected interaction. |
| Policy Engine to Policy Pack Registry | Built-in Policy Engine | Policy Pack Registry | Fetch signed policy packs and federation metadata. | Pact-style fixture backed by signed-pack POC behavior. |
| Policy Engine to RBAC Directory | Built-in Policy Engine | RBAC Directory | Resolve principal roles and grants. | Pact-style fixture backed by RBAC POC behavior. |
| Gatekeeper to Audit Log | Gatekeeper Verify | Audit Log/Event Projection | Persist deterministic decision evidence. | Pact-style message contract fixture. |
| Governance Suite to Evidence Store | Governance Conformance Suite | Audit Log/Event Projection | Replay decisions for conformance. | Pact-style message replay fixture. |

## Design decisions

- Gatekeeper remains the deploy gate aggregator, not a rule engine.
- Policy decisions use the Policy IR and deny-ceiling algebra from the selected POCs.
- Contract compatibility is consumer-driven and built-in; external Pact import/export remains interop only.
- Obligations are first-class governance outcomes. A deploy can be allowed with required obligations when those obligations are recorded and satisfied in the scenario.
- External providers that are not implemented in this repo are mocked with deterministic fixtures and explicit contract inventory rows.
- All simulation data is local. No live external service, secret, customer data, or production token is required.

## Follow-ups not implemented here

- Live OpenFeature or external policy-engine adapters.
- Production policy authoring UI.
- Cross-yard attestation network exchange.
- Performance targets for authz cache p99.
- Control-plane policy bypass PR repair work from a separate open child PR.
## Guardrail evidence

Parse, don't validate: incoming command payloads, Pact fixtures, and protobuf/CUE-backed scenario records cross a parser boundary before the epic simulation uses them. The parsed domain types are the scenario commands, boundary fixtures, and role-flow records described above; mocked providers receive only those derived domain types, not raw DTOs.

Event architecture: command handlers in the epic actors emit events into an in-memory event-store. Materialized views and projections are rebuilt from that event stream, snapshots represent the current read model, and historical snapshots are retained in a read store so CLI, MCP, operator, and simulation reads never infer state from mutable provider internals.
