# Provider Aws Full Capability Catalog Contract

Independent draft POC for **HOBO-638** (`@hobo/provider-aws` full capability port
catalog + Capability Manifest).

Promotes the AWS provider fixtures from
[`providers-iac-build-adapters`](../../epic-proofs/providers-iac-build-adapters/README.md)
and extends the seed
[`provider-aws-contract`](../provider-aws-contract/README.md) proof to the full
catalog ports from
[`authoring-resources-wiring.md`](../../../../docs/design/authoring-resources-wiring.md):

- `web/service`, `kv`, `bucket`, `queue`, `topic`, `sql`, `secret`
- equivalence-class mappings and provider-owned default Resource Definitions
- typed `awsFull.with.*` builders scoped to AWS-resolved resources
- published Capability Manifest with OIDC-federation `auth.json` for the S3 broker
- signed manifest bundle publish + registry ingest with brokered OIDC-federation guards
- `realize()` emission through `@hobo/iac-pulumi`
- `@hobo/conformance` provider-capability coverage via seed-suite adapter plus
  topic/secret extension checks
- brokered (keyless) apply simulation without static secrets

Out of scope: live AWS SDK/Pulumi execution, production `packages/providers/provider-aws/`,
Azure/GCP providers, Junction connectivity, and real OIDC/STS exchange.

Run:

```bash
pnpm --prefix src/draft/technical-proofs/provider-aws-full-capability-catalog-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
