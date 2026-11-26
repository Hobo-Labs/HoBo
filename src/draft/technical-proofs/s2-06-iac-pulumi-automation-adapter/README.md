# S2-06 @hobo/iac-pulumi Automation API Adapter POC

Independent draft proof for HOBO-621 (S2-06). Models the production
`@hobo/iac-pulumi` package as an embeddable Pulumi Automation API adapter with
per-resource stacks, pluggable state backend config, and outputs returned as
bindings.

## Proven behavior

- `preview/apply/refresh/destroy` round-trip on a trivial `IacProgram` returns
  typed outputs and binding map without CLI shell-out.
- Each resource owns an isolated per-resource Pulumi stack keyed by
  `deploymentId/resourceName` (blast-radius isolation for compensation).
- State backend config is pluggable (`memory` fixture; production targets Yard
  object store per `docs/design/control-plane.md` IaC state model).
- Recorded providers-epic fixture (`providers-shop-api-iac-program.json`)
  exercises the `IacProgram` emission pipeline from
  `src/draft/epic-proofs/providers-iac-build-adapters/`.
- `@hobo/conformance/iac-backend` suite passes for trivial and providers
  fixtures.
- Preview/apply divergence, partial apply, state-lock contention, and
  unresolved output references fail closed with explicit errors.
- Parse-don't-validate: `validateIacProgram()` returns parsed derived types.
- Live smoke test is env-gated (`HOBO_IAC_PULUMI_LIVE=1`).

## Scope boundaries

Draft POC only — production promotion to `packages/iac/iac-pulumi/` is a
follow-up after this proof merges (HOBO-616 S2-01 M0 record is Done). No real
Pulumi SDK calls, Firecracker execution, or provider cloud APIs.

## Check

```bash
pnpm --prefix src/draft/technical-proofs/s2-06-iac-pulumi-automation-adapter test
```

## Architecture Evidence

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and per-resource stack evidence.

## Maintenance

HOBO-621 (2026-07-01): initial draft POC; gates are package tests +
`pnpm agent:check` architecture/docs lanes when touched.
