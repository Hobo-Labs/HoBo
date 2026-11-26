# wRPC + WIT baseline POC

This draft implements HOBO-12's spike proof: an exact toolchain baseline,
one vendored `wasi:*` interface pin, and a smoke WIT package that `jco types`
and `wit-bindgen-cli` can resolve.

## Decision Snapshot

- Wasmtime / Component Model host floor: `v46.0.1`.
- `@bytecodealliance/jco`: `1.24.3`.
- `@bytecodealliance/componentize-js`: `0.21.0`.
- `wit-bindgen-cli`: `0.58.0`.
- `wrpc`: `0.17.0`.
- wasmCloud lattice integration floor: `v2.4.0`.
- First vendored interface fixture: `wasi:clocks/wall-clock@0.2.0@stable`.

The full rationale is recorded in `ADR-0085`.

## Verification

```sh
pnpm install
pnpm test
```

`pnpm test` regenerates bindings with the pinned `jco`, runs an exact-version
`wit-bindgen-cli` smoke generation, validates the lock and vendored interface
digest, and checks the generated smoke binding surface (Vitest). The jco pin
is verified against the installed `@bytecodealliance/jco` manifest — the
workspace uses a single root `pnpm-lock.yaml`, so there is no per-package
lockfile to inspect.

The `wit-bindgen-cli` smoke step **downloads the pinned release** on first run
and caches it under `.tools/`, so that run needs network access. Behind a
TLS-intercepting proxy the download fails with `SELF_SIGNED_CERT_IN_CHAIN`,
because the certificate chain terminates in the proxy's own root; point
`NODE_EXTRA_CA_CERTS` at that root's bundle and re-run. Do not reach for
`NODE_TLS_REJECT_UNAUTHORIZED` — this step downloads and then executes a
toolchain, so an unverified chain hands that binary to whoever is on the path.
Under `turbo`, `envMode: "strict"` means the variable also has to be listed in
`globalPassThroughEnv` (it is; see AGENTS.md).


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Wrpc Wit Baseline Poc.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
