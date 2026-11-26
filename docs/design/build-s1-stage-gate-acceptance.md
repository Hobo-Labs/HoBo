---
type: Reference
title: "Build S1 Stage Gate Acceptance"
description: "Production S1 stage gate: runtime-port/component-host/sdk-parity conformance, offline hobo dev on hello-bindle, and replay==live, re-pointed from the draft proof onto @hobo/conformance, @hobo/cli, and @hobo/runtime-local. Source issue: HOBO-615."
tags: [hobo, design, s1, stage-gate]
---

# Build S1 Stage Gate Acceptance

Source issue: [HOBO-615](https://linear.app/quickdeploy-ai/issue/HOBO-615) (S1-24 — re-point the
S1 stage gate at production).

This record supersedes the draft-proof gate captured in
[`proofs/s1-stage-gate/index.md`](./proofs/s1-stage-gate/index.md): the standing lane
`.github/workflows/s1-stage-gate.yml` no longer runs `src/draft/technical-proofs/s1-stage-gate`.
It now exercises the built production packages — `@hobo/conformance` against `@hobo/runtime-local`,
and the `@hobo/cli` offline `hobo dev` loop — exactly as the S0 record
([`build-s0-stage-gate-acceptance.md`](./build-s0-stage-gate-acceptance.md)) points at
`@hobo/stage-gate` rather than a draft package.

Executable proof for this acceptance record is **not** a `src/draft/` package. The runnable signals
are:

- `.github/workflows/s1-stage-gate.yml` (green on `main` means S1 is done)
- the production package suites the workflow jobs invoke (`@hobo/conformance`, `@hobo/cli`)

The workflow keeps the four-job shape of the draft gate — `conformance`, `offline`, `replay`,
`record`. The `conformance` and `replay` jobs build their dependency graph first (the
`@hobo/conformance` `pretest` builds `@hobo/core` + `@hobo/runtime` + `@hobo/runtime-local`; the
`offline` job runs `turbo run build --filter @hobo/cli...` before the network is cut). The `offline`
job runs the production `hobo dev` test inside `docker run --network=none` with the cloud-credential
environment variables cleared, so the offline serve is proven with the network physically removed.
The `record` job assembles the machine record via `scripts/ci/s1-stage-gate-record.mts` and uploads
it as a workflow artifact (`if: always()`).

## Scope In

- Re-point `.github/workflows/s1-stage-gate.yml` from the draft proof onto the production packages,
  keeping the multi-job shape and the `--network=none` offline guard.
- Re-point `scripts/ci/s1-stage-gate-record.mts` to assemble a production `StageGateS1Record`
  (no dependency on the draft proof) and fail closed if this acceptance record is missing/malformed.
- This acceptance record, its design-index row, and its traceability row.

## Scope Out

- Building the S1 packages themselves (`@hobo/conformance`, `@hobo/cli`, `@hobo/runtime-local`,
  `@hobo/runtime`, `@hobo/data`, `@hobo/events`, `@hobo/bindles`) — already built and merged; this
  gate only wires and records their rehearsal lanes.
- The live-cloud lanes (owned by the S2/S3 stage gates).
- A standalone `hobo` binary served offline: the offline job asserts the injected runtime-local
  `hobo dev` serve (the same in-process wiring the package tests use), not a packaged CLI binary.

## Gate Table

| Gate | Command | Local evidence (2026-07-17) | CI run |
| --- | --- | --- | --- |
| conformance | `pnpm --filter @hobo/conformance test` | 11 files / 57 tests pass — runtime-port, component-host, capability-enforcement, eventstore, queue/clock, golden-replay, sdk-parity vs `@hobo/runtime-local` | pending runner restoration |
| offline-hello-bindle | `docker run --network=none … node ./node_modules/vitest/vitest.mjs run packages/cli/test/dev-verb.test.ts --no-isolate` | 3 tests pass — `hobo dev` serves `hello world` in-process with `offline: true`, boot within the 60000 ms cold budget, live-tailed component-host frames; deterministic across two cold boots | pending runner restoration |
| replay-equals-live | `pnpm --filter @hobo/conformance exec vitest run test/replay-corpus.test.ts` | 4 tests pass — S1-16 corpus (>= 2 cases incl. an upcaster round-trip) rebuilds from zero and byte-equals live | pending runner restoration |
| record | `node --import tsx scripts/ci/s1-stage-gate-record.mts` | writes `s1-stage-gate-record.json`; fails closed if this record is missing a Gate Table or a check id | pending runner restoration |

> CI-run cells read "pending runner restoration": CI runners are down account-wide (an infrastructure
> fault, not a code fault), so a green CI run cannot yet be produced. The commands above were run
> locally against the production packages and are green; each cell is filled with its workflow run
> URL after the first green `s1-stage-gate` run once runners return. Earlier rows remain append-only
> evidence.

## Proof Expectations

- The `conformance` job proves the local Camp (`@hobo/runtime-local`) passes runtime-port +
  component-host conformance and SDK parity — the portability boundary.
- The `offline` job proves `hobo dev` boots the injected runtime-local Camp and serves hello-bindle
  with zero network and zero cloud credentials, within the 60 s cold budget (NFR-002); it emits the
  component-host lifecycle over the Streamer and records `link.Established` / `resource.Provisioned`
  parity through the linked KV import.
- The `replay` job proves replay == live: the committed corpus rebuilds from zero and byte-compares
  green, including an upcaster case (NFR-011).
- The offline serve is deterministic across two cold boots (identical served body and event stream).

The component-host lifecycle the offline serve live-tails through the Streamer is:

```text
component.Loaded -> link.Established -> link.Called -> component.Invoked
```

## Maintenance

Promotion note: this gate replaces the draft proof
`src/draft/technical-proofs/s1-stage-gate` referenced by
[`proofs/s1-stage-gate/index.md`](./proofs/s1-stage-gate/index.md). The draft proof's index is kept
as the originating record; its "Promotion Notes" table named these production targets. The offline
lane runs the `@hobo/cli` `dev-verb` test rather than a packaged binary because the production
`hobo dev` command boots an injected `DevRuntime` (runtime-local component host + Streamer) — the
same in-process wiring the CLI's own suite exercises. When a packaged offline `hobo` binary exists,
the offline job's inner command is the only line that changes; the `--network=none` guard and cleared
cloud-credential environment stay identical.
