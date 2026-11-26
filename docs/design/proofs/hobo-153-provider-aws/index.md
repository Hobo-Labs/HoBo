# HOBO-153 AWS Provider Proof

This proof backs [PLAN-04](../../control-plane.md#plan-04), the
provider package slot in [architecture.md](../../architecture.md#monorepo--package-architecture), and
[ADR-0024](../../adr/07-portability-extensibility.md#adr-0024) portability
conformance.

The executable POC in
[`src/draft/technical-proofs/provider-aws-contract`](../../../../src/draft/technical-proofs/provider-aws-contract)
proves the AWS seed provider contract:

- `@hobo/provider-aws` exposes a factory, Capability Manifest, default Resource
  Definitions, and per-port clients for database, object store, compute, queue,
  and cache;
- `aws.with.rds/fargate/appRunner/s3/sqs/elasticache` are typed provider
  options and only survive when the resolved provider is AWS;
- the multi-cloud-shop fixture realizes RDS/Aurora, S3, Fargate, SQS, and
  ElastiCache into a HoBo realization graph with `@hobo/iac-pulumi` driver
  intent and no provider-dialect leakage;
- compute default definitions cover both Fargate and App Runner, and App Runner
  region availability fails closed with the same `deployment.PlanRejected`
  contract as other AWS classes;
- local and camp conformance are both represented, with camp-only IAM/mTLS/quota
  evidence failing the camp lane while local conformance still passes;
- unavailable AWS regions, unsatisfied `require` facts, and quota exhaustion
  return precise `deployment.PlanRejected` reasons.

Scope kept out: live AWS/Pulumi apply, Azure/GCP providers, cross-cloud
Junction connectivity, secretless token brokering, and the full AWS service
surface beyond the seed ports.
