# @hobo/provider-cloudflare Contract Proof

HOBO-165 adds an independent draft proof for the Cloudflare provider shape.

The package proves:

- A factory for `@hobo/provider-cloudflare` with scoped `.with` builders for Workers, R2, D1, Hyperdrive-backed Postgres, KV, Queues, and DNS.
- Default definitions and a capability manifest for Workers/R2/D1/KV/Queues/DNS.
- `realize()` emission into a driver-agnostic IaC program with `wrangler` for Workers and `terraform:cloudflare` for account resources.
- Provider conformance over the shared seed ports plus explicit KV evidence while the shared conformance catalog has no first-class `kv` suite.
- Negative gates for D1/Hyperdrive strong consistency, R2 strict S3 semantics, Worker CPU/bundle limits, DNS ADR-0035 safe rollout, and account quota.

This is a branch-local POC only. It does not execute Terraform, Wrangler, Workers runtime hosting, Workers AI, Vectorize, or any other provider.

Run:

```sh
npm --prefix src/draft/technical-proofs/provider-cloudflare-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Provider Cloudflare Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.

## Testing

Run `pnpm --filter @hobo-draft/provider-cloudflare-contract test` (Vitest,
followed by `tsc --noEmit -p tsconfig.types.json`). The provider is now fully
typed (capability-port union, plan/emission/option shapes), and its type-test
imports the source relatively, so the check also validates the shared
`hobo-realize-emission-contract` types it consumes.
