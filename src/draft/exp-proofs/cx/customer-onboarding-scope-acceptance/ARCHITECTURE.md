# Customer Onboarding Scope Acceptance - Architecture Evidence

HOBO-449 is an M0 scope and acceptance proof. It does not implement a CRM,
customer-success workflow, onboarding UI, support queue, marketing site, billing
flow, telemetry pipeline, live customer-data import, production tenant mutation,
or provider-backed customer launch.

## Schema Sources Of Truth

- **Protobuf** - `proto/customer_onboarding_scope.proto` defines the M0 scope
  record, personas, operating boundaries, evidence requirements, onboarding
  stages, and state vocabulary.
- **CUE** - `cue/customer_onboarding_scope.cue` constrains every protobuf type
  with the scope, boundary, stage, and evidence rules used by this proof.
- **PACT** - `contracts/pacts/customer-onboarding-scope.pact.json` records the
  boundary between the beta pilot readiness gate and the Customer Onboarding
  scope record.

## Parse, Don't Validate

Customer onboarding inputs are parsed once into **derived domain types**:

- a raw scope record becomes `ParsedCustomerOnboardingScope` only after issue,
  phase, boundary, stage, and evidence constraints pass;
- a raw follow-up request becomes `ParsedCustomerOnboardingFollowUp` only after
  M0 acceptance and phase constraints pass;
- a raw customer-facing claim becomes `ParsedCustomerOnboardingClaim` only after
  proof mode and source evidence are present.

After parsing, beta-pilot, support, release-cutline, and onboarding consumers
receive parsed types rather than raw DTOs plus repeated boolean checks. CRM
scope creep, live customer-data use, unsupported marketing claims, and blocked
follow-ups are unrepresentable past the parser boundary.

## Event Architecture

The live workflow is deferred, but the event boundary is named now so follow-up
issues inherit one vocabulary:

- **Command** - `AcceptCustomerOnboardingScope` records M0 scope acceptance.
- **Events** - accepted commands emit `customerOnboarding.ScopeAccepted`;
  rejected scope claims emit `customerOnboarding.ScopeRejected`.
- **Actor** - the Customer Onboarding scope actor is the single writer for the
  project acceptance stream.
- **Event store** - acceptance and rejection events append to the launch
  readiness event-store.
- **Materialized view / projection** - the beta pilot readiness projection folds
  onboarding scope state, evidence links, support routes, and accepted
  limitations.
- **Snapshot** - snapshots preserve the latest accepted M0 scope and proof
  digest for beta, RC, and GA gate reads.
- **Read store** - release, support, customer-success, and customer-facing
  surfaces read the customer-safe onboarding state from the read store, not raw
  pilot notes or support records.

This package keeps M0 scoped to acceptance and vocabulary. Customer-success
operations, CRM integrations, workspace onboarding UI, support workflows,
marketing copy, telemetry, and live provider launch evidence stay with follow-up
owners.
