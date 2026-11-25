# HOBO-638 Provider AWS Full Catalog Proof

This proof records acceptance evidence for the independent draft POC at
`src/draft/technical-proofs/provider-aws-full-capability-catalog-contract`.

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| Full capability port catalog (`web/service`, `kv`, `bucket`, `queue`, `topic`, `sql`, `secret`) with equivalence mappings and typed `.with(...)` builders. | `factory publishes full catalog ports, equivalence mappings, typed builders, and OIDC auth.json` |
| Published Capability Manifest includes OIDC-federation `auth.json` for the S3 broker. | Factory test asserts `oidc-federation` flow and `brokerTargets.bucket`; registry ingest tests pin signed bundle acceptance. |
| Registry ingest accepts brokered OIDC manifests and rejects static secrets or missing federation. | `registry ingest accepts signed manifest bundle with brokered OIDC-federation auth only` plus three rejection cases. |
| `@hobo/conformance` provider-capability suite green for claimed ports. | `AWS full catalog provider passes provider-capability conformance for every claimed port` |
| Multi-cloud-shop topology realizes through `@hobo/iac-pulumi`. | `multi-cloud-shop fixture realizes all seven catalog ports through Pulumi-shaped AWS nodes` |
| Brokered (keyless) apply succeeds without static secrets. | `brokered keyless apply succeeds with OIDC-federation S3 broker and no static secrets` |

## Adversarial Mapping

| Adversarial case | Executable proof |
|---|---|
| API-key-only manifests must not pass brokered apply. | `adversarial cases reject api-key-only auth, unsupported regions, and unsatisfied require facts` |
| Unsupported regions reject with precise reasons. | Same test rejects `ap-south-2` with `aws-region-service-unavailable`. |
| Unsatisfied `require` facts reject precisely. | Same test rejects missing `global-writes` with `aws-capability-require-unsatisfied`. |
| Quota exhaustion is explicit. | Same test rejects zero `web/service` quota with `aws-quota-exhausted`. |

## Scope Boundary

Draft POC only. Production promotion to `packages/providers/provider-aws/` follows
the S4-01 (HOBO-637) package map now that the M0 record is Done.

## Local Gate

```bash
pnpm --prefix src/draft/technical-proofs/provider-aws-full-capability-catalog-contract test
```
