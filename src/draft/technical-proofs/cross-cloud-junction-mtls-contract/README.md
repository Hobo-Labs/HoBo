# Cross-Cloud Junction mTLS Contract POC

Independent proof for **HOBO-642** (S4-06).

Builds the `@hobo/junctions`-shaped seam as a draft package composing existing networking contracts:

- `junction()` federates peer Yards (ADR-0043, no shared mutable state)
- Connectivity planner selects tier (native private → interconnect → overlay → public+mTLS)
- Bind edges annotated with tier + estimated egress
- SVID-keyed mTLS authorizes cross-cloud data-path calls
- Policy-ceiling violations fail closed before invoke

## BDD acceptance

```gherkin
Feature: Cross-cloud Junction connectivity

  Scenario: AWS service calls Azure service over SVID-keyed mTLS
    Given a Junction federating AWS and Azure Yards
    When HoBo plans cross-cloud connectivity and invokes the bind edge
    Then tier 3 private interconnect is selected, egress is annotated, mirrored halves are delivered, and mTLS succeeds

  Scenario: Policy ceiling violation is refused
    Given a mandatory max tier below the required cross-provider interconnect
    When HoBo plans cross-cloud connectivity
    Then the plan is blocked before any cross-cloud invoke
```

## Run

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/cross-cloud-junction-mtls-contract
```

## Scope boundary

This POC does not ship `packages/junctions/` production code, live AWS/Azure networking, or credentialed cloud E2E. It promotes the cross-cloud bind and mirrored Junction-halves scenarios from `src/draft/epic-proofs/networking-connectivity-dns-relay/` into a branch-sized HOBO-642 acceptance surface.

## Architecture evidence

- `architecture/` — protobuf + CUE constraints
- `architecture/pacts/` — PACT boundary contract
- `architecture.md` — parse-don't-validate + event architecture evidence
- `ADR.md` — design rationale

## Design refs

- [Plan 12 — Security & connectivity](../../../docs/design/security-networking.md#plan-12)
- [ADR-0043 — Junction federation](../../../docs/design/adr/07-portability-extensibility.md#adr-0043)

## Maintenance

HOBO-642 draft POC. Gates: `pnpm exec turbo run test --filter ./src/draft/technical-proofs/cross-cloud-junction-mtls-contract`, architecture guard on `architecture/`.
