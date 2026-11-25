# Security Verification Scope Acceptance - Architecture Evidence

HOBO-441 is an M0 scope and acceptance proof. It does not implement a live
scanner, SIEM integration, ticketing workflow, incident service, customer
notification service, public security page, legal terms, bug bounty, CVE
workflow, Gatekeeper behavior, or runtime security engine.

## Schema Sources Of Truth

- **Protobuf** - `proto/security_verification_scope.proto` defines the M0
  scope record, personas, operating boundaries, evidence requirements, and
  state vocabulary.
- **CUE** - `cue/security_verification_scope.cue` constrains every protobuf
  type with the scope, boundary, and evidence rules used by this proof.
- **PACT** - `contracts/pacts/security-verification-scope.pact.json` records
  the boundary between the release cutline gate and the Security Verification
  scope record.

## Parse, Don't Validate

Security verification inputs are parsed once into **derived domain types**:

- a raw scope record becomes `ParsedSecurityVerificationScope` only after issue,
  phase, boundary, and evidence constraints pass;
- a raw follow-up request becomes `ParsedSecurityVerificationFollowUp` only
  after M0 acceptance and phase constraints pass;
- a raw release claim becomes `ParsedSecurityVerificationClaim` only after proof
  mode and source evidence are present for release-facing audiences.

After parsing, cutline, support, and security-review consumers receive parsed
types rather than raw DTOs plus repeated boolean checks. Unsupported public
claims, live-service scope creep, and blocked follow-ups are unrepresentable
past the parser boundary.

## Event Architecture

The live workflow is deferred, but the event boundary is named now so follow-up
issues inherit one vocabulary:

- **Command** - `AcceptSecurityVerificationScope` records M0 scope acceptance.
- **Events** - accepted commands emit `security.ScopeAccepted`; rejected scope
  claims emit `security.ScopeRejected`.
- **Actor** - the Security Verification scope actor is the single writer for
  the project acceptance stream.
- **Event store** - acceptance and rejection events append to the launch
  readiness event-store.
- **Materialized view / projection** - the release cutline projection folds
  security scope state, blocker state, evidence links, and accepted risks.
- **Snapshot** - snapshots preserve the latest accepted M0 scope and proof
  digest for beta, RC, and GA gate reads.
- **Read store** - release, support, and customer-assurance surfaces read the
  customer-safe security verification state from the read store, not raw
  security review notes.

This package keeps M0 scoped to acceptance and vocabulary. Threat-model
execution, scanner integration, support workflow implementation, disclosure
copy, customer notifications, and legal approval stay with follow-up owners.
