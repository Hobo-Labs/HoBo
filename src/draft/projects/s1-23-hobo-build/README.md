# S1-23 hobo build draft POC (HOBO-613)

Independent draft rollup for `hobo build` wiring CLI orchestration to
`@hobo/componentize`. Production implementation lives in `packages/cli/` (S1-23 / HOBO-613).

## Scope

- `runBuild` orchestration with codegen drift gate, sorted service discovery,
  wasm componentize or OCI fallback, manifest projection last
- Parse-don't-validate boundary (`parseBuildRequest`, `parseServiceDeclaration`,
  `parseBuildManifest`) producing parsed derived types
- Event-sourced build record (`build.Started`, `build.ArtifactProduced`,
  `build.Completed`)
- CLI seam (`createBuildCli`, `registerBuildCommand`) with `--json` envelopes
- Protobuf + CUE `data-models/build_manifest.*`
- CLI→componentize PACT (`contracts/cli-componentize-boundary.pact.json`)
- Digest parity against golden `hello-bindle` fixture (S0-07 CI path)

## Integrated proofs

| Proof | Role |
|---|---|
| `hobo-build-cli-contract` | Orchestration order, error taxonomy, acceptance tests |
| `hobo-componentize-contract` | Deterministic componentize + validate adapter |
| `hobo-codegen-cli-contract` | `_generated/` drift gate |

## Out of scope

- Production `packages/cli` / `packages/componentize` promotion (blocked on merge)
- Signing, registry push, non-TS language lanes, `hobo codegen` command itself

## Validation

```bash
pnpm --prefix src/draft/projects/s1-23-hobo-build test
pnpm run test:file src/draft/projects/s1-23-hobo-build/test/build-digest-parity.test.ts
```

## Promotion path

Reimplement under `packages/cli/src/commands/build.ts` and
`packages/cli/src/build/parse.ts` when S1-20/S0-07 land on `main`. Golden digest
fixture: `test/fixtures/hello-bindle.digest.json`.
