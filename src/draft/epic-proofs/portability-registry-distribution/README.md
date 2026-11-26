# Portability, Registry & Distribution Reference Implementation

This reference implementation rolls the selected Linear epic into one runnable, mocked architecture slice. It is not production registry code. It shows how certified listings move from descriptor and discovery into install verification, deterministic resolution, policy gates, yank response, mirror selection, and air-gap import without live external services.

## BDD scenarios

```gherkin
Feature: Portable registry distribution

  Persona: Platform engineer curating production-safe provider inputs

  Scenario: Install a certified provider listing without selecting it automatically
    Given a certified provider Resource Pack listing in a curated catalog
    When the platform engineer installs it through the registry reference flow
    Then the artifact is signature, provenance, conformance, catalog, and trust verified
    And it becomes available to Matching without being selected automatically
```

```gherkin
Feature: Air-gap registry import

  Persona: Sovereign Yard operator

  Scenario: Import a signed offline bundle without live registry egress
    Given a signed offline bundle with revocation, anti-rollback, and transparency material
    When the operator imports it into an in-boundary mirror
    Then accepted artifacts are recorded in a registry.BundleImported event
    And revoked or rolled-back artifacts fail closed without live egress
```

```gherkin
Feature: Supply-chain response

  Persona: SecOps responder

  Scenario: Yank a compromised listing while preserving running-set evidence
    Given a certified listing pinned by a running Deployment Set
    When SecOps yanks the listing as critical
    Then new deploy selection is blocked
    And the running Set is flagged with a remediation obligation instead of being force-rewritten
```

```gherkin
Feature: Agent-driven registry planning

  Persona: Planning agent

  Scenario: Discover, resolve, and fetch only digest-identical artifacts
    Given a capability-indexed registry and registered artifact mirrors
    When the agent asks for a capability and resolves a floating range
    Then the resolver freezes a digest pin
    And mirror cost selection runs only after digest identity is verified
```

## Running the epic simulation

Command:

```bash
npm.cmd --prefix src\draft\epic-proofs\portability-registry-distribution run simulate
```

What this proves:

- Certified listing install is available to Matching but never auto-selected.
- Version resolution freezes a digest and refuses unsafe pin drift.
- Catalog and trust policy gates fail closed.
- Yanked listings block new selection and flag running Sets.
- Offline import uses in-boundary mocks and no live network.
- The validated registry-publish-flow proof is included in this rollup; its deterministic simulation contract is unchanged.
- The validated capability-indexed discovery proof is included in this rollup; its deterministic simulation contract is unchanged.
- Install-verification changes are absorbed without changing registry trust, offline import, or selection behavior.
- The validated curated-catalog-policy and distributed-artifact-version-policy proofs are included in this rollup; their deterministic simulation contracts are unchanged.
- Mirror cost tie-break runs only after digest identity verification.

Mocked boundaries:

- Artifact repository mirror: in-memory digest-pinned mirror fixtures.
- Registry discovery index: in-memory lifecycle event projection.
- Trust and install verifier: deterministic fixture signing keys and trust boundary.
- Catalog/policy gate: pure curated-catalog and trust-tier policy fixtures.
- Offline importer: in-boundary mirror fixture and egress-attempt trap.

Contracts:

- `contracts/pacts/registry-artifact-repository.pact.json`
- `contracts/pacts/registry-capability-discovery.pact.json`
- `contracts/pacts/registry-trust-policy.pact.json`
- `contracts/pacts/registry-offline-import.pact.json`

## Scope control

In scope: epic-level reference slice under the common reference implementation root, mocked boundary contracts, Pact fixture inventory, POC disposition ledger, and deterministic simulation.

Out of scope: production registry transport, real OCI/Sigstore/Rekor services, real cloud/provider APIs, full Junction federation rollout, production Matching scoring, and deleting or moving existing POCs.


Portability-swap, registry-import, and registry-publish changes are absorbed without changing registry trust, offline import, or selection behavior.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Portability Registry Distribution.
- `architecture/pacts/` — PACT contract for the package boundary.
- `architecture.md` — parse-don't-validate and event-architecture evidence.

## Cascade reconciliation (83d9b5c92)

The `trust-tier-policy-contract` technical proof refresh is absorbed without changing portability or registry evidence.
