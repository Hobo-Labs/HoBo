# @hobo/contract-harness

Production PACT consumer/provider harness for HoBo service boundaries (`HOBO-582` / S0-05).

Zero runtime dependencies — consumed by other packages only as a `devDependency`.

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

## Public API

- `parsePactDocument` — parse-don't-validate entry for pact JSON (mirrors `data-models/contract-harness.cue`)
- `loadPactDirectory` — load non-recursive `*.pact.json` from a directory
- `createMockProviderFromPact` — consumer-side in-process mock
- `verifyPact` — provider verification (exact provider identity/status/headers; response body recursive-subset)
- `checkPactInventory` — pact file ↔ inventory drift gate

The effect-aware isolation/mocks/fault-injection helpers (ADR-0136:
`createEffectIsolation`, `mocksForEffects`, `filterPureContracts`,
`dualFixturesForEffects`, `runResilienceFaultInjection`, `captureContractEffects`)
live in `@hobo/contracts` so this package stays dependency-free (a
`@hobo/contract-harness → @hobo/contracts → @hobo/core` chain would close a
package-graph cycle with `@hobo/core`'s dev-time PACT usage of this harness).

## Commands

```bash
pnpm exec turbo run build test --filter ./packages/contract-harness
```

## Data models

Protobuf-first shapes live in `data-models/contract-harness.proto`; CUE constraints in `data-models/contract-harness.cue`. TypeScript interfaces mirror the protobuf messages; parity is enforced by `test/pact-parse.test.ts` fixtures.
