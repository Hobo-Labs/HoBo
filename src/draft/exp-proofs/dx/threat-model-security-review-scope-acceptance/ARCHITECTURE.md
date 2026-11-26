# Threat Model & Security Review Scope Acceptance - Architecture Evidence

HOBO-451 is an M0 scope and acceptance proof. It does not implement a live
scanner, SAST/DAST integration, SIEM integration, exploit runner, incident
service, support queue, legal/advisory copy, public security page, bug bounty,
CVE workflow, Gatekeeper behavior, or release gate bypass.

## Schema Sources Of Truth

- **Protobuf** - `proto/threat_model_security_review_scope.proto` defines the
  M0 scope record, personas, operating boundaries, intake fields, review gates,
  and state vocabulary.
- **CUE** - `cue/threat_model_security_review_scope.cue` constrains every
  protobuf type with the scope, boundary, intake, and gate rules used by this
  proof.
- **PACT** - `contracts/pacts/threat-model-security-review-scope.pact.json`
  records the boundary between Security Verification and the Threat Model &
  Security Review scope record.

## Parse, Don't Validate

Threat review inputs are parsed once into **derived domain types**:

- a raw scope record becomes `ParsedThreatModelSecurityReviewScope` only after
  issue, phase, boundary, intake, and review-gate constraints pass;
- a raw follow-up request becomes `ParsedThreatReviewFollowUp` only after M0
  acceptance and phase constraints pass;
- a raw finding becomes `ParsedThreatReviewFinding` only after severity,
  exploitability, customer-data, credential, and fix-verification facts are
  present.

After parsing, release, support, and security-verification consumers receive
parsed types rather than raw DTOs plus repeated boolean checks. Scanner scope
creep, gate bypass, legal-copy ownership, and blocked follow-ups are
unrepresentable past the parser boundary.

## Event Architecture

The live workflow is deferred, but the event boundary is named now so follow-up
issues inherit one vocabulary:

- **Command** - `AcceptThreatReviewScope` records M0 scope acceptance.
- **Events** - accepted commands emit `threatReview.ScopeAccepted`; rejected
  claims emit `threatReview.ScopeRejected`; classified findings emit
  `threatReview.FindingClassified`.
- **Actor** - the Threat Model & Security Review scope actor is the single
  writer for the project acceptance stream.
- **Event store** - acceptance, rejection, and finding-classification events
  append to the launch readiness event-store.
- **Materialized view / projection** - the Security Verification projection
  folds threat-review scope, finding class, blocker state, fix evidence, and
  support handoff.
- **Snapshot** - snapshots preserve the latest accepted M0 scope, review-gate
  set, and proof digest for beta, RC, and GA reads.
- **Read store** - release, support, customer-assurance, and admin surfaces read
  customer-safe threat-review state from the read store, not raw exploit notes.

This package keeps M0 scoped to acceptance and vocabulary. Scanner execution,
exploit-runner implementation, release gate changes, support workflow
implementation, disclosure copy, and legal approval stay with follow-up owners.
