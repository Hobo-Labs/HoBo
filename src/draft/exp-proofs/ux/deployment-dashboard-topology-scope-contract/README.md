# Deployment Dashboard & Topology Explorer Scope Contract

Independent M0 proof for HOBO-410.

This package records the accepted productization scope for the Deployment
Dashboard & Topology Explorer. It names the user/business goal, primary
personas, scope in/out, service/UX/security/support boundaries, owning
initiatives, M1 evidence gate, and adversarial guards that keep M0 from
silently expanding into dashboard UI, projection runtime, live provider,
status-page, RBAC, or support automation work.

## Contract Boundaries

- In scope: M0 product scope, projection-backed surface taxonomy, follow-up
  gating, boundary ownership, and negative guards for scope creep.
- Consumed but not owned: `DeploymentView`, `TopologyView`, `RunView`,
  data-plane projections/read stores, tenant/RBAC decisions, SLO/cost/incident
  rollups, CLI/MCP parity, and support handoff records.
- Out of scope: production frontend, live provider traversal, projection
  engine/read-store/GraphQL runtime, public status-page publishing, RBAC or
  policy enforcement, and support-ticket automation.

## Proof

```powershell
npm.cmd --prefix src\draft\exp-proofs\deployment-dashboard-topology-scope-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the scope
  record.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event architecture evidence.
