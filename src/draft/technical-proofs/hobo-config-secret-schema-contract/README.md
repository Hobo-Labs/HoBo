# HoBo config and secret schema contract

Independent POC for HOBO-40. It pins the varlock-style authoring surface:

- `config({...})` declares refs, not values.
- `fromBinding(name)` records a secretless bound-resource source.
- `secretRef(ref)` records a use-time secret-store ref and stays distinct from catalog `secret(name)`.
- `env(default)` records non-secret Camp config type without serializing the default value into the manifest.
- `createConfigContext()` exposes `ctx.config.<KEY>()` only for declared keys.

The tests prove refs-only manifest emission, plaintext leak detection, dev-only source marking, and the TypeScript key surface.

> **Promotion note (S1-19 / HOBO-609):** integrated local-resolution draft POC at
> `src/draft/technical-proofs/s1-19-ctx-config-local-resolution/`. Production target:
> `packages/bindles/src/config/`.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Config Secret Schema Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
