# Chaos & Resilience Tests Scope Acceptance - Architecture Evidence

HOBO-439 is an M0 scope and acceptance proof. It does not implement a live
chaos runner, production fault injection, provider mutation, external chaos
engine adapter, full Golden Suite, SLO engine, dashboard, support workflow, SRE
remediation engine, or credential mutation path.

## Schema Sources Of Truth

- **Protobuf** - `proto/chaos_resilience_tests_scope.proto` defines the M0
  scope record, personas, operating boundaries, evidence requirements, and
  state vocabulary.
- **CUE** - `cue/chaos_resilience_tests_scope.cue` constrains every protobuf
  type with the scope, boundary, and evidence rules used by this proof.
- **PACT** - `contracts/pacts/chaos-resilience-tests-scope.pact.json` records
  the boundary between the release cutline gate and the Chaos & Resilience Tests
  scope record.

## Parse, Don't Validate

Chaos resilience inputs are parsed once into **derived domain types**:

- a raw scope record becomes `ParsedChaosResilienceScope` only after issue,
  phase, boundary, and evidence constraints pass;
- a raw follow-up request becomes `ParsedChaosResilienceFollowUp` only after M0
  acceptance and phase constraints pass;
- a raw adjacent-work request becomes `ParsedChaosResilienceOwnershipRoute` only
  after scope ownership is classified.

After parsing, cutline, SRE, support, and security consumers receive parsed
types rather than raw DTOs plus repeated boolean checks. Live fault injection,
credential mutation, production chaos, and unaccepted follow-ups are
unrepresentable past the parser boundary.

## Event Architecture

The live workflow is deferred, but the event boundary is named now so follow-up
issues inherit one vocabulary:

- **Command** - `AcceptChaosResilienceScope` records M0 scope acceptance.
- **Event** - accepted commands emit `chaos.ScopeAccepted`; rejected scope
  claims emit `chaos.ScopeRejected`.
- **Actor** - the Chaos & Resilience Tests scope actor is the single writer for
  the project acceptance stream.
- **Event store** - acceptance and rejection events append to the launch
  readiness event store.
- **Materialized view / projection** - the release cutline projection folds
  chaos scope state, evidence links, known gaps, accepted risks, and release
  phase applicability.
- **Snapshot** - snapshots preserve the latest accepted M0 scope and proof
  digest for beta, RC, and GA gate reads.
- **Read store** - release, support, and customer-assurance surfaces read the
  customer-safe chaos evidence state from the read store, not raw experiment
  notes.

This package keeps M0 scoped to acceptance and vocabulary. Fault primitives,
external chaos engines, Golden Suite orchestration, SRE remediation, dashboard
implementation, and support execution stay with follow-up owners.
