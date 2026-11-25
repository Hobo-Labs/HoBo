# Enterprise Deployment Hardening Scope Contract - Architecture Evidence

HOBO-453 is an M0 scope and acceptance proof. It does not implement a
production installer, deployment runner, hosted control plane, live self-host
rollout, identity system, backup/restore workflow, support queue, SLA, billing,
legal approval, compliance certification, or enterprise sales workflow.

## Schema Sources Of Truth

- **Protobuf** - `architecture/enterprise_deployment_hardening_scope_contract.proto`
  defines the M0 scope record, personas, deployment postures, operating
  boundaries, evidence requirements, and follow-up gate vocabulary.
- **CUE** - `architecture/enterprise_deployment_hardening_scope_contract.cue`
  constrains every protobuf type with the phase, posture, boundary, evidence,
  and gate rules used by this proof.
- **Pact** -
  `architecture/pacts/enterprise_deployment_hardening_scope_contract.pact.json`
  records the boundary between the enterprise follow-up gate and the M0 scope
  record.

## Parse, Don't Validate

Enterprise hardening inputs are parsed once into **derived domain types**:

- a raw scope record becomes `ParsedEnterpriseDeploymentHardeningScope` only
  after issue, phase, posture, boundary, and evidence constraints pass;
- a raw follow-up request becomes `ParsedEnterpriseHardeningFollowUp` only after
  M0 acceptance and phase constraints pass;
- a raw readiness claim becomes `ParsedEnterpriseReadinessClaim` only after
  proof source and owner route are present for customer-facing audiences.

After parsing, release, support, security, and assurance consumers receive
parsed types rather than raw DTOs plus repeated boolean checks. Unsupported
readiness claims, implementation creep, and blocked follow-ups are
unrepresentable past the parser boundary.

## Event Architecture

The live enterprise workflow is deferred, but the event boundary is named now so
follow-up issues inherit one vocabulary:

- **Command** - `AcceptEnterpriseDeploymentHardeningScope` records M0 scope
  acceptance.
- **Events** - accepted commands emit `enterpriseHardening.ScopeAccepted`;
  rejected scope claims emit `enterpriseHardening.ScopeRejected`.
- **Actor** - the Enterprise Deployment Hardening scope actor is the single
  writer for the project acceptance stream.
- **Event store** - acceptance and rejection events append to the launch
  readiness event-store.
- **Materialized view / projection** - the release cutline projection folds
  posture state, evidence links, unsupported modes, and accepted gaps.
- **Snapshot** - snapshots preserve the latest accepted M0 scope and proof
  digest for beta, RC, and GA gate reads.
- **Read store** - release, support, admin console, and customer-assurance
  surfaces read customer-safe enterprise hardening state from the read store,
  not raw implementation notes.

This package keeps M0 scoped to acceptance and vocabulary. Deployment
implementation, identity enforcement, backup/restore execution, support tooling,
customer contracts, and legal approval stay with follow-up owners.
