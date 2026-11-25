# SDK-to-CLI Golden Path

HOBO-576 proof for the TypeScript SDK consumer to CLI transcript path.

## What This Proves

- A smallest meaningful `@hobo/bindles` consumer declares an API and managed Postgres resource
  graph without embedding production cloud logic in SDK code.
- Compile/type tests pin the SDK imports, command result envelope, and CLI result kinds used by
  the transcript.
- Deterministic fixtures drive `hobo collect`, `hobo plan`, `hobo up`, `hobo inspect deploy`, and
  `hobo doctor` terminal steps.
- Happy path, policy refusal, contract incompatibility, stale or unknown evidence, and support
  handoff outcomes are all represented as typed result kinds.
- One fixture id links the SDK example, manifest IR, CLI transcript, API shape, MCP result,
  downstream handoffs, and proof README.

## Fixture

The reference fixture id is `dx.lifecycle.shop-api.v1`. It represents a `shop-api` Bindle with one
API workload and one managed Postgres data dependency. The fixture is reference evidence only; it
does not publish `@hobo/bindles`, call a live MCP server, create a production app scaffold, produce a
real deploy URL, or require dashboard screenshots.

## Transcript Commands

1. `hobo collect` returns `success` after producing manifest IR.
2. `hobo plan` returns `success` for the valid fixture.
3. `hobo up` returns `success` for the mocked deploy request.
4. `hobo up` returns `gatekeeper-denied` when policy blocks the request before provider dispatch.
5. `hobo plan` returns `contract-incompatible` when the mocked provider lacks a required
   capability.
6. `hobo inspect deploy` returns `stale-or-unknown-evidence` when deployment evidence cannot be
   trusted.
7. `hobo doctor` returns `support-handoff` with a safe support bundle id.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\sdk-to-cli-golden-path test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the golden-path proof record.
- `architecture/pacts/` - PACT contract for the SDK-to-CLI proof boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
