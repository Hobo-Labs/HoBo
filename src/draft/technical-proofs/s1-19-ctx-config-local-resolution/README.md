# S1-19 ctx.config local resolution (draft POC)

Independent draft POC for **HOBO-609** (S1-19). Implements the declarative config/secrets
authoring surface (`config()` / `secretRef()` / `env()` → typed `ctx.config`) with **local-Camp
resolution only**, plus `config.Resolved` audit events and **redaction at capture**.

Promotes:

- `src/draft/technical-proofs/hobo-config-secret-schema-contract/` (authoring schema)
- `src/draft/technical-proofs/secretless-config-resolution-contract/` (resolver + redaction)

Production target: `packages/bindles/`, `packages/core/`, `packages/runtime/`,
`packages/runtimes/runtime-local/`, and `examples/hello-bindle/` when blockers merge.

## Run

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/s1-19-ctx-config-local-resolution
```

## Architecture Evidence

See [`ADR.md`](./ADR.md), [`architecture/`](./architecture), and [`architecture/pacts/`](./architecture/pacts).
`pnpm run architecture:guard` passes for this package (protobuf + CUE + PACT + parse-don't-validate + event vocabulary).

## Event families (fixed)

`config.Resolved` · `secret.Accessed` · `secret.Unavailable`

## Maintenance

- `camp-env` resolutions always append `config.Resolved`, including optional keys that fall back to
  typed defaults when the Camp config record omits the ref.
- Dev secrets ladder tests cover `.env.local` → keychain → prompt order; prompt is skipped when
  `CI` is set.
