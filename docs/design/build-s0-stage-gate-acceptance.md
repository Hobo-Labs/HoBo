---
type: Reference
title: "Build S0 Stage Gate Acceptance"
description: "Source issue: HOBO-589."
tags: [hobo, design, s0, stage-gate]
---

# Build S0 Stage Gate Acceptance

Source issue: [HOBO-589](https://linear.app/quickdeploy-ai/issue/HOBO-589/s0-12-stage-gate-s0-signed-hello-bindle-component-through-ci-all).

Executable proof for this acceptance record is **not** a `src/draft/` package. The runnable
signals are:

- `.github/workflows/stage-gate-s0.yml` (green on `main` means S0 is done)
- `packages/stage-gate/` unit and consumer-contract tests (`pnpm --filter @hobo/stage-gate test`)

CI builds `@hobo/stage-gate` and its workspace dependencies (notably `@hobo/componentize` for the
hello-bindle fixture scripts) via `turbo run build --filter @hobo/stage-gate...`, then invokes
`node packages/stage-gate/dist/cli.js run s0` (workspace bins are not linked at the repo root until
the package is a declared dependency). Failed runs still
upload `stage-gate-s0.record.json` as a workflow artifact (`if: always()`). The workflow installs
`cue` via `cue-lang/setup-cue@v1.0.0` (v0.14.0, matching `hobo-ci.yml`) because
`pnpm run test:schema` includes `@hobo/bindles` CUE vet gates, and normalizes LF line endings with
`git reset --hard` after checkout so Windows legs match checked-in generated artifacts. The gate
step runs under `bash` on all matrix OS legs and re-runs `git reset --hard` immediately before
`hobo-stage-gate`; schema-tools and wit-toolchain drift checks compare LF-normalized generated text
so Windows buf/jco output does not false-positive against Linux-checked-in files. WIT skeleton parsing
normalizes CRLF to LF before matching interface blocks so Windows checkouts do not skip
`scope_creep_filled_interfaces` guards.

## Scope In

- `@hobo/stage-gate` runner that executes and records the S0 toolchain check list fail-closed.
- `StageGateRecord` protobuf + CUE contract in `packages/stage-gate/data-models/`.
- Stage-gate CI workflow with Ubuntu/Windows matrix digest equality assertion.
- This acceptance record, design index row, and traceability row.

## Scope Out

- Implementing the underlying gates (boundary lint, architecture guard, schema drift, PACT harness,
  conformance harness, hello-bindle fixture, signing pipeline) — owned by S0-01..S0-11.
- `camp`-tag cloud E2E, registry lifecycle, Sigstore transparency-log lookup, key rotation.

## Gate Table

| Gate | Command | Local evidence | CI run |
| --- | --- | --- | --- |
| boundary-lint | `pnpm run lint:boundaries` | part of `node packages/stage-gate/dist/cli.js run s0`; package suite covers record/runner fail-closed wiring | pending runner restoration |
| architecture-guard | `pnpm run architecture:guard` | same `run s0` checklist entry; production packages under architecture guard | pending runner restoration |
| schema-drift | `pnpm run test:schema` | same `run s0` checklist entry (protobuf/CUE + generated drift) | pending runner restoration |
| contract-consumer | `pnpm run test:contract:consumer` | same `run s0` checklist entry; `@hobo/stage-gate` consumer Pact for `StageGateRecord` | pending runner restoration |
| contract-provider | `pnpm run test:contract:provider` | same `run s0` checklist entry | pending runner restoration |
| conformance-self-test | `pnpm --filter @hobo/conformance test` | same `run s0` checklist entry | pending runner restoration |
| hello-bindle-determinism | `node --import tsx packages/stage-gate/scripts/check-hello-bindle-determinism.mts` | deterministic digest of hello-bindle component bytes (see synthetic note below) | pending runner restoration |
| hello-bindle-health | `node --import tsx packages/stage-gate/scripts/check-hello-bindle-health.mts` | smoke expects `hello-bindle:ok` | pending runner restoration |
| sign-provenance-verify | `node --import tsx packages/stage-gate/scripts/check-sign-verify.mts` | signer identity + provenance tier + conformance report digest recorded in stage-gate record | pending runner restoration |
| tampered-artifact-refused | `node --import tsx packages/stage-gate/scripts/check-tamper-refuse.mts` | refusal reasons include `artifact.digest_mismatch` | pending runner restoration |

> CI-run cells read "pending runner restoration": account-level GitHub Actions runner
> assignment is currently out (jobs finish in ~3s with `runner: None` — an infrastructure /
> billing-assignment fault, not a code fault), so a green CI run cannot yet be produced. Fill each
> cell with its workflow run URL after the first green `stage-gate-s0` run once runners return.
> Earlier rows remain append-only evidence. Do not invent green run URLs.
>
> **Synthetic componentize:** hello-bindle digests and sign/verify gates currently pin
> **contract-byte digests** from `@hobo/componentize`'s synthetic wasm path — not production
> `jco` / `componentize-js` output. Cross-OS digest parity still requires Linux/Windows legs to
> agree; it does **not** claim a real portable-WASM pipeline.

## Proof Expectations

- Parser rejects malformed or internally inconsistent records (`parseStageGateRecord`).
- Runner fails closed on any non-zero check exit code.
- Tampered artifact verification is recorded as refused in the negative check.
- Cross-OS matrix legs report identical `sha256:` component digests (stable artifact labels
  `stage-gate-s0-record-linux` / `stage-gate-s0-record-windows`, independent of the Linux runner
  variable). Digests are synthetic contract-byte digests until real componentize lands.

## Maintenance

Promotion note: stage-gate check scripts use `@hobo/componentize` for hello-bindle build/smoke
checks and fall back to the draft hello-bindle fixture path only when
`examples/hello-bindle` is absent. Signing verification scripts still orchestrate the draft
`signed-artifact-publish-install-contract` until `packages/componentize` publishes
`artifact-trust` on main. Cross-OS digest parity downloads
`stage-gate-s0-record-linux` and `stage-gate-s0-record-windows` (stable labels; `runs-on` may be
`vars.HOBO_RUNNER_LINUX_SMALL` or `windows-latest` and must not be baked into artifact names).
