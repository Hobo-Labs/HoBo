# S0-04 Protobuf+CUE Codegen Pipeline (HOBO-581 draft POC)

Draft proof for the production `@hobo/schema-tools` package. Implements deterministic
protobuf→TypeScript codegen via `buf` + `protoc-gen-es`, CUE constraint vetting, and a
`--check` drift gate that never mutates the working tree.

Production code lives in `packages/schema-tools/`. This proof retains its own
Buf template and checks the same output-normalization policy as production.
The proof tests use temporary copies, so generation and drift checks do not
modify checked-in files. The intentionally refreshed frozen-file digests live
in `scripts/promotions.json`.

CLI arguments become parsed types under the parse, don't validate rule. The
command produces JSON reports and generated snapshots; this build-time tool
runs without an actor, event store, projection, or read store.

## Layout

- `packages/schema-tools/` — codegen CLI (`hobo-codegen`), engine, CUE lane, own contract
- `packages/core/` — seed event-envelope proto+CUE + fixtures (stand-in for S0-03 core)
- `buf.gen.yaml` — shared buf v2 template (`protoc-gen-es`, `target=ts`)

## Commands

```bash
pnpm --prefix src/draft/technical-proofs/s0-04-protobuf-cue-codegen run codegen
pnpm --prefix src/draft/technical-proofs/s0-04-protobuf-cue-codegen run codegen:check
pnpm --prefix src/draft/technical-proofs/s0-04-protobuf-cue-codegen test
```

Root shortcuts: `pnpm run codegen`, `pnpm run codegen:check` (extended `test:schema`).

`resolveBufCommand` resolves Buf from root installs, the S0-04 POC package install, and
`PATH`; on Windows it invokes the package entrypoint through the current Node executable so
root `test:schema` does not depend on Unix-style shims.

## Proven surface

- `runCodegen` writes normalized `src/_generated/` output per package; byte-identical on repeat
- `checkCodegen` regenerates to temp, reports path-level drift, never mutates disk
- `--json` emits one `CodegenReport` object; exit 0 only when `status` is CLEAN
- CUE vet: valid fixtures pass, invalid fixtures fail closed
- Hand-edited `_generated/` files fail `generated:guard` and drift check
- Windows pathing is covered: schema-tools resolves package-local Buf/CUE binaries, uses the
  platform PATH delimiter, and downloads the CUE `.zip` release asset before drift checks run
