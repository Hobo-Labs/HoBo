# S1-10 Conformance Trust Boundary (HOBO-599)

Independent epic POC for the S1 trust boundary: `@hobo/conformance`
runtime-port durability suite + `component-host` portability suite.

Promotes behavior from:

- `src/draft/technical-proofs/runtime-port-conformance-contract/` (HOBO-30)
- `src/draft/technical-proofs/component-host-conformance-suite/` (HOBO-29)

Production target: `packages/conformance/src/suites/{runtime-port,component-host}/` (promoted in S1-10 / HOBO-599).

## What this proves

- Five frozen runtime-port checks (`hobo.runtime-port-conformance/v1`) including
  checkout `replay == live`.
- Component-host cross-host assertions with manifest host version pins.
- Seeded violations: broken-fence backend, drifting hosts.
- The production local queue and clock with in-memory event-store and actor-host fixtures.

## Verify

```bash
pnpm --prefix src/draft/epic-proofs/s1-10-conformance-trust-boundary test
```

## Executable evidence
Protobuf + CUE under `architecture/`; PACT contracts under `pacts/`.
Parse boundaries: `src/runtime-port/parse.ts`, `src/component-host/parse.ts`.
