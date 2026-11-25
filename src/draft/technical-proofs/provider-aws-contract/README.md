# HOBO-153 AWS Provider Contract POC

This draft package proves the `@hobo/provider-aws` contract slice for
[PLAN-04](../../../../docs/design/control-plane.md#plan-04) and
[ADR-0024](../../../../docs/design/adr/07-portability-extensibility.md#adr-0024).

It covers the seed AWS provider surface:

- `createAwsProvider()` factory with `capabilityManifest()`, conformance hooks,
  default Resource Definitions, and per-port runtime `client()` methods;
- typed provider-specific `.with(...)` builders under `aws.with`;
- `database`, `objectStore`, `compute`, `queue`, and `cache` equivalence defaults;
- `realizeAwsPlan()` emitting a driver-agnostic HoBo realization graph marked for
  `@hobo/iac-pulumi`;
- a multi-cloud-shop fixture that wires RDS/Aurora, S3, Fargate, SQS, and
  ElastiCache through HoBo links and build references;
- Fargate and App Runner default definitions for the compute seed port, with
  App Runner availability rejected precisely when a region lacks it;
- negative cases for camp-only IAM evidence, unavailable regions, unsatisfied
  `require` facts, and quota exhaustion.

Out of scope: real AWS SDK/Pulumi execution, Azure/GCP providers, Junction
connectivity, token brokering, and services beyond the seed ports.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\provider-aws-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Provider Aws Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
