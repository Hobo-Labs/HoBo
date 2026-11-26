# Networking, Connectivity, DNS & Relay Reference Implementation

This package rolls the Networking epic POCs into one repo-local reference architecture implementation. It demonstrates secure cross-cloud binds, shadow-gated custom domains, outbound-only Relay execution, and tenant-aware ingress without calling live providers.

## BDD Slices

```gherkin
Feature: Secure cross-cloud connectivity

  Persona: Platform engineer

  Scenario: Cross-provider bind stays private and policy-bounded
    Given an app API in an AWS Yard binds to a database in an Azure Yard
    When HoBo folds Yard manifests and plans connectivity
    Then the reference selects tier 3 private interconnect, enforces policy ceilings, validates mTLS, and emits mirrored per-Yard Junction halves
```

```gherkin
Feature: Safe custom-domain promotion

  Persona: Domain operator

  Scenario: Domain promotion is validation-first
    Given a custom domain fronts multiple Camps
    When HoBo stages DNS, validates evidence, issues certificates, and routes traffic
    Then only shadow DNS changes before validation and rebinding or split-horizon evidence blocks promotion
```

```gherkin
Feature: HoBo Relay private execution

  Persona: SecOps engineer

  Scenario: Relay cannot become an SSRF pivot
    Given a private target is reachable only through Relay
    When HoBo dispatches scoped work
    Then Relay uses outbound-only SVID-authenticated transport and denies metadata, proxy, and credential movement attempts
```

```gherkin
Feature: Tenant-aware ingress

  Persona: Application operator

  Scenario: Tenant context resolves before handlers
    Given subdomain, custom-domain, path, or JWT tenant signals
    When ingress routes a request
    Then ctx.tenant is resolved before the handler and mismatched claims fail closed
```

## Running

```bash
npm.cmd --prefix src\draft\epic-proofs\networking-connectivity-dns-relay test
npm.cmd --prefix src\draft\epic-proofs\networking-connectivity-dns-relay run simulate
```

## What Is Real

- Existing POC modules are executed for connectivity tier selection, policy enforcement, mTLS, Yard manifests, Junction planning, DNS shadow writes, validation gates, ACME, private ACME, gateway routing, cost routing, Relay, and tenant routing.
- The tenant-routing rollup also covers the leaf proof's boundary-type hardening; the deterministic simulation contract is unchanged.
- The validated Cross-Camp routing policy and connectivity cost feedback proofs are included in this rollup; their deterministic simulation contracts are unchanged.
- DNS validation threat-model and domain-event-body changes are absorbed without changing the deterministic connectivity simulation.
- Pact fixtures in `contracts/pacts/` pin each mocked boundary used by the simulation.
- The simulation fixture is deterministic and contains no secrets or customer data.

## What Is Mocked

- Providers, DNS adapters, ACME endpoints, gateway edge, cost ledger, Relay target, and tenant claim provider are in-memory mocks.
- Provider verification is documented as mocked-provider-unavailable until production providers exist.

## Follow-Ups

- Replace mock provider verifiers with real provider verification when Networking providers are promoted out of POC status.
- Add scenario coverage for geo and latency routing when product acceptance requires those policies as primary vertical slices.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Networking Connectivity Dns Relay.
- `architecture/pacts/` — PACT contract for the package boundary.
- `architecture.md` — parse-don't-validate and event-architecture evidence.

## Cascade reconciliation (83d9b5c92)

The split-horizon, public-mTLS, and topology-override technical proof refreshes are absorbed without changing connectivity or DNS evidence.
