# V1 Vibe Example Gap Closure Reference Implementation

HOBO-539 is the parent blocker for the v1 vibe example backlog. This package proves the corrected
DX-first parent acceptance by checking that HOBO-566 owns the API/SDK/CLI/MCP backbone, HOBO-567
through HOBO-577 carry branch-sized DX slices, and the older visual/support/docs/launch artifacts
stay downstream of accepted quickstart and envelope evidence instead of inventing behavior.

## What is real

- `src/vibe-gap-closure.ts` contains a deterministic child issue matrix for HOBO-540 through
  HOBO-565 plus the corrected DX backbone graph for HOBO-566 through HOBO-577.
- Tests prove each child targets `src/draft/exp-proofs/<slug>` and
  `docs/design/proofs/<issue-slug>/README.md`.
- Tests prove the DX backbone keeps `dx-first`, `api`, `sdk`, `cli`, and `contract` label coverage
  across CLI, MCP & Developer Experience slices.
- Tests prove M1 shape slices block M2 deploy/manage/migrate transcript work before HOBO-577
  quickstart examples unblock downstream docs, support, launch, visual, and accessibility artifacts.
- Tests prove the HOBO-577 downstream consumer list matches the actual HOBO-540 through HOBO-565
  child matrix, with HOBO-558 held back by CLI/refusal/fixture foundations.
- Tests prove the shared vibe coverage requirements: happy path, blocked path, stale/unknown
  evidence path, support handoff, accessibility notes, and proof-mode labels.
- Tests prove every child scope-out guard includes production CLI/API/SDK, production UI, live
  provider, customer data, credential, and unsupported launch-claim exclusions.
- Pact-style fixtures record the mocked child backlog, DX backbone, scope guard, and unblock ledger
  boundaries.

## What is mocked

- Linear child issue retrieval is represented by a checked-in fixture so tests do not need live
  Linear access.
- The production CLI/API/SDK, production UI, provider calls, customer data, credentials, support
  tooling, and launch-site publication are explicitly out of scope.

## Running

```powershell
npm.cmd --prefix src\draft\epic-proofs\v1-vibe-example-gap-closure test
npm.cmd --prefix src\draft\epic-proofs\v1-vibe-example-gap-closure run simulate
```

## BDD slices

```gherkin
Feature: V1 vibe example backlog closure

  Persona: Product/design maintainer
  Scenario: enforce the DX-first backbone
    Given HOBO-539 was corrected to prioritize API, SDK, CLI, and MCP resource lifecycle examples
    When the DX backbone graph is evaluated
    Then HOBO-566 owns HOBO-567 through HOBO-577 with M1 foundations before M2 transcript work

  Persona: Product/design maintainer
  Scenario: coordinate branch-sized artifact children
    Given HOBO-539 blocks the vibe example child backlog
    When the child matrix is evaluated
    Then every child targets an isolated exp proof package and proof note

  Persona: Reviewer
  Scenario: reject production scope creep
    Given a requested addition to production CLI/API/SDK, live UI, providers, customer data, credentials, or launch claims
    When the scope guard evaluates the request
    Then the request is rejected as outside HOBO-539

  Persona: Automation worker
  Scenario: unblock downstream Backlog work after merge
    Given the parent acceptance is branch-reviewable and tests pass
    When HOBO-539 is merged and moved Done
    Then the DX backbone and downstream artifact issues can continue under their own blockers
```

## Files

- `src/vibe-gap-closure.ts`
- `tests/vibe-gap-closure.test.ts`
- `contracts/consumer/vibe-gap-boundaries.test.ts`
- `contracts/pact-inventory.md`
- `poc-rollup-ledger.md`
- `reference-implementation.yaml`
- `architecture.md`

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the child backlog and evaluation.
- `architecture/pacts/` - Pact fixture for the package boundary.
- `architecture.md` - parse-don't-validate and event-architecture evidence.
