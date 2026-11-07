# PACT contract harness (draft POC)

Draft technical proof mirror for **HOBO-582 / S0-05**. Production harness and reference boundary live in:

- `packages/contract-harness/` — `@hobo/contract-harness` (`dependencies: {}`)
- `packages/core/contracts/` — reference `core-contract-surface` boundary

## Per-package `contracts/` convention

Every package that owns service boundaries keeps:

```text
contracts/
  pact-inventory.md
  pacts/<boundary>.pact.json
  consumer/<boundary>.contract.test.ts
  provider/<boundary>.provider.test.ts
  provider/fixtures/*.ts
```

Inventory table columns: Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status.

Status progresses `consumer_tested` → `provider_verified`.

## Public harness API

- `parsePactDocument` — parse-don't-validate entry for pact JSON (mirrors `data-models/contract-harness.cue`)
- `loadPactDirectory` — load non-recursive `*.pact.json` from a directory
- `createMockProviderFromPact` — consumer-side in-process mock
- `verifyPact` — provider verification (exact provider identity/status/headers; response body recursive-subset)
- `checkPactInventory` — pact file ↔ inventory drift gate

## Commands

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/pact-contract-harness
pnpm --prefix src/draft/technical-proofs/pact-contract-harness run test:contract:consumer
pnpm --prefix src/draft/technical-proofs/pact-contract-harness run test:contract:provider
```

Contract scripts use Vitest, matching the proof's unit tests and the Vitest
`describe`/`it` declarations in the consumer and provider contract suites.

## Verification

```bash
pnpm --prefix src/draft/technical-proofs/pact-contract-harness test
pnpm --prefix src/draft/technical-proofs/pact-contract-harness run test:contract:consumer
pnpm --prefix src/draft/technical-proofs/pact-contract-harness run test:contract:provider
```

## Architecture Evidence

See [`ADR.md`](./ADR.md) and [`data-models/`](./data-models/) for protobuf/CUE, parse-don't-validate, and event-architecture evidence required by `scripts/check-architecture-guardrails.mjs`.

## Data models

Protobuf-first shapes live in `data-models/contract-harness.proto`; CUE constraints in `data-models/contract-harness.cue`. TypeScript interfaces mirror the protobuf messages; parity is enforced by `test/pact-parse.test.ts` fixtures.
