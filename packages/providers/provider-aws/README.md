# @hobo/provider-aws

The AWS `CloudProvider` (HOBO-711): RDS PostgreSQL, S3, Fargate, SQS,
ElastiCache, and DynamoDB behind HoBo's agnostic ports — the AWS row of the
cross-cloud equivalence table shipped as this provider's default Resource
Definitions.

| Port | AWS service | Resource class |
|---|---|---|
| `compute` | Fargate | `aws:fargate-service` |
| `kv` | DynamoDB | `aws:dynamodb-table` |
| `objectStore` | S3 | `aws:s3-bucket` |
| `database` | RDS PostgreSQL | `aws:rds-postgres` |
| `queue` | SQS | `aws:sqs-queue` |
| `cache` | ElastiCache (Redis) | `aws:elasticache-redis` |

- **Factory** `createAwsProvider({ regions })` (HOBO-87 authoring contract).
- **`.with()` builders**: `aws.with.fargate / rds / s3 / dynamodb / sqs /
  elasticache` — typed, additive, inert for non-resolved providers.
- **`realize()`** emits a `hobo.iac-program/v1` program for the primary
  Pulumi lane (`stack: aws/<deploymentId>`), with `binding` outputs so bind
  edges resolve across resources.
- **Keyless creds**: the published auth document pins `svid-federation` via
  `sts:AssumeRoleWithWebIdentity` (HOBO-110) — `staticSecrets: false` is
  parse-enforced.
- **Cost facts**: declared real list-price magnitudes per SKU with monthly
  free-tier facts.
- Installable into the composed registry with `hobo add aws` (held/approve
  semantics per HOBO-710).

## Verification

```sh
pnpm --filter @hobo/provider-aws build
pnpm --filter @hobo/provider-aws test
```

## Default Yard catalog (what AWS *can* allocate)

`awsYardSpec()` and `AWS_DEFAULT_BINDINGS` (`src/default-yard.ts`) declare the
AWS Yard as an **allocatable catalog**: for each capability slot, the AWS
products that could satisfy it. It is not a mapping, not a pool, and not a
selection — each slot holds a *list*, and which entry an app gets is decided
later by capability selection (ADR-0151) against the requirements the app
states.

| Slot | Declared alternatives |
|---|---|
| `web` | App Runner, ECS service, EKS Deployment, Amplify Hosting (`web.hosted/v1`); S3 + CloudFront (`web.static/v1`) |
| `api` | API Gateway (`api.http/v1`) |
| `service` | Lambda (`service.worker/v1`); ECS task (`service.batch/v1`) |
| `data` | RDS for PostgreSQL, Aurora Serverless v2 (`data.postgres/v1`); RDS for MySQL (`data.mysql/v1`); DynamoDB (`data.document/v1`) |
| `kv` | DynamoDB (`kv.key-value/v1`); ElastiCache (`kv.redis-compatible/v1`) |
| `bucket` | S3 (`bucket.s3-compatible/v1`) |
| `queue` | SQS (`queue.at-least-once/v1`); SQS FIFO (`queue.fifo/v1`) |
| `topic` | SNS (`topic.pubsub/v1`) |
| `secretRef` | Secrets Manager, SSM Parameter Store (`secret-ref.locator/v1`) |

The catalog is built strictly from the typed factories in `src/slots.ts`. Most
slots hold several entries, because AWS genuinely hosts a web capability four
ways and satisfies `data` with three different engines. Which one a given
workload gets is decided at resolution time by ADR-0151 selection, against the
requirements the app states — never here. Adding a fifth `web` option is a
catalog edit, not a deployment change.

The catalog still does not enumerate all of AWS. Lightsail, Elastic Beanstalk,
Kinesis, MSK, Neptune, and others are not authored yet; a missing alternative is
a gap in the factory set, not a choice made by the Yard.

`awsYardSpec({ regions })` returns raw row-shaped data — `{ provider, regions,
bindings }` — because a provider package is a layer-2 adapter and may not
import `@hobo/yards`; that layer-3 package parses these rows into a canonical
set.

## HONEST SCOPE — catalog only, nothing here deploys

This change ships the **catalog only**. There is no HTTP deployment resolver
for AWS in this package (Cloudflare and Vercel are the two providers with
resolvers today), and the `aws.*` product ids the factories emit are **not
registered** in the definition catalog. A Yard built from this spec declares
what AWS *can* allocate; attempting to deploy against it **fails closed at
resolution** — `YARD_BINDING_PRODUCT_UNKNOWN`, or no registered resolver —
until Resource Definitions and resolvers land. Nothing in this section should
be read as evidence that an AWS deployment works.

## Deployment resolvers

`aws.lambda/v1` provides the service/worker compute path. Its desired record names
an ECR image by sha256 digest, an existing `executionRoleArn`, `memoryMb`,
`timeoutSeconds` and `architecture`; budget execution additionally requires
`reservedConcurrency`, `ownershipRef` and `artifactDigest`. No IAM role, artifact,
capacity or account is guessed. This is an IAM-invocable function; a public Function
URL and its access policy are separate resources and are not invented.

The resolver creates a deterministically named function, applies its reserved
concurrency, then reads `Configuration`, `Code.ResolvedImageUri`, `Tags` and
`Concurrency`. `outputs.ready` requires active initialization, successful last
update, matching image/role/memory/timeout/architecture/concurrency and both native
`hobo:owner` / `hobo:artifact` tags. `outputs.artifactDigest` is the immutable OCI
digest from the independently read image; the deployment tag is exposed separately
as `artifactMarker` and does not verify content. Creation acknowledgement and an initialized
resource are different observations.

Owned functions belonging to another artifact are refused. A combined code/capacity
change needs a fresh immutable target, while a single supported delta carries the
observed Lambda `RevisionId`. Missing, foreign or reused physical IDs and ownership
are refused. Retirement verifies ownership and the source artifact before deletion,
then independently reads confirmed absence. Target names must include a unique
lifetime identity and must not be reused after retirement; `DeleteFunction` has no
conditional revision fence.

`test/lambda-hosting.test.ts` covers lost create acknowledgements, convergence,
initialization, capacity bounds, artifact/ownership confusion, revision-fenced updates
and unconfirmed retirement against a modeled API. The endpoint and input model are
the official AWS SDK `lambda-2015-03-31` model. Live account and billing conformance
requires an isolated AWS account and federated credentials; no anonymous Lambda
provisioning API exists. Static `estimateCost()` rates are marked `estimate`; a
placeholder zero is `unknown`. Financial admission requires current bounded quotes.

`awsResolvers(options)` / `awsResolverRegistry(options)` (`src/resolvers.ts`)
call AWS service APIs directly over an injected, guarded transport. There is no
IaC engine, no state file, and no plan/apply round trip. What the catalog above
declares as allocatable, these resolvers allocate.

```ts
const registry = awsResolverRegistry({
	region: "us-east-1",
	nowMs: Date.now, // SigV4 signs a timestamp; the clock is injected, never read here
	resolveCredential: async (ref) => host.awsCredentialsFor(ref),
});
const transport = guardedAwsTransport(hostFetchTransport, "us-east-1");
await registry.get("aws.s3/v1")?.reconcile(request, transport);
```

### Endpoints covered

Coverage is a slice of each service — enough to allocate, observe, converge,
and remove the resource — not the whole surface.

| Product | Service / host | Calls |
|---|---|---|
| `aws.s3/v1` | REST-XML on `s3.{region}.amazonaws.com` | `GET /{bucket}?location` (existence probe), `GET/PUT /{bucket}?versioning`, `GET/PUT /{bucket}?publicAccessBlock`, `PUT /{bucket}`, `DELETE /{bucket}` |
| `aws.dynamodb/v1` | REST-JSON `x-amz-target` on `dynamodb.{region}.amazonaws.com` | `DescribeTable`, `CreateTable`, `UpdateTable`, `DeleteTable` |
| `aws.lambda/v1` | REST-JSON on `lambda.{region}.amazonaws.com` | `GetFunction`, `CreateFunction` with an immutable ECR image, revision-bound `UpdateFunctionCode` / `UpdateFunctionConfiguration`, `PutFunctionConcurrency`, `DeleteFunction` plus absence readback |
| `aws.sqs/v1`, `aws.sqs-fifo/v1` | query protocol on `sqs.{region}.amazonaws.com` | `GetQueueUrl`, `CreateQueue`, `GetQueueAttributes`, `SetQueueAttributes`, `DeleteQueue` |
| `aws.sns/v1` | query protocol on `sns.{region}.amazonaws.com` | `ListTopics` (paged), `CreateTopic`, `GetTopicAttributes`, `SetTopicAttributes`, `DeleteTopic` |
| `aws.secrets-manager/v1` | REST-JSON `x-amz-target` on `secretsmanager.{region}.amazonaws.com` | `DescribeSecret`, `CreateSecret`, `UpdateSecret`, `RestoreSecret`, `DeleteSecret` |
| `aws.ssm-parameter-store/v1` | REST-JSON `x-amz-target` on `ssm.{region}.amazonaws.com` | `GetParameter`, `PutParameter`, `DeleteParameter` |

IAM actions for `aws.secrets-manager/v1`, per verb:

| Verb | Actions |
|---|---|
| `read` | `secretsmanager:DescribeSecret` |
| `reconcile` | `secretsmanager:DescribeSecret`, `secretsmanager:CreateSecret`, `secretsmanager:UpdateSecret`, and `secretsmanager:RestoreSecret` when `restoreScheduled: true` is declared |
| `delete` | `secretsmanager:DescribeSecret` (it describes the secret first), `secretsmanager:DeleteSecret` |

Path-style S3 addressing (`/{bucket}`) is deliberate: it keeps the transport
allowlist to one reviewable host per region instead of one host per bucket name
a caller happens to pass.

### Convergence, and why `replace` never appears

Every `reconcile()` is read-or-create: it asks AWS whether the
deterministically-named resource exists *before* it creates anything, then
applies only the mutable deltas. Running it twice yields one resource, the same
`physicalId`, and exactly one create call — asserted per product in
`test/resolvers.test.ts`. `delete()` treats "already gone" as success.

`"replace"` is never emitted. Replacing a bucket or a table destroys data, so
drift on an immutable field — an S3 bucket's region, a DynamoDB key schema, an
SSM parameter's type — is reported as a **diagnostic** and left for a human.
Declared options this resolver cannot honestly apply are diagnostics too, not
silent no-ops: S3 `storageClass` (no such bucket-level property), SQS
`maxReceiveCount` (needs a dead-letter queue ARN this resolver does not
create), Secrets Manager `rotationDays` (needs a rotation Lambda), SSM
`kmsKeyRef` (only meaningful for `SecureString`, which is refused).

### Products deliberately left unresolved

`AWS_UNRESOLVED_PRODUCT_IDS` names them, and a test asserts the uncovered set is
exactly that list — so a new catalog entry cannot quietly become an unresolved
one. A resolver that duplicates a resource on every retry is worse than an
absent one.

| Product | Why there is no resolver |
|---|---|
| `aws.rds-postgres/v1`, `aws.rds-mysql/v1`, `aws.aurora-serverless-postgres/v1` | `CreateDBInstance`/`CreateDBCluster` take a `MasterUserPassword`, which would travel in `ResolveRequest.desired` — the record that reaches the event log and the plan digest. The managed-master-password path needs KMS + Secrets Manager wiring, and both paths need a DB subnet group and security group no binding names. |
| `aws.elasticache-redis/v1` | Placement needs a cache subnet group and security group no binding names; omitting them silently lands the cluster in the default VPC. |
| `aws.ecs-service/v1`, `aws.ecs-task/v1`, `aws.eks-deployment/v1` | Cluster, task-execution role, and network configuration live outside the binding; an EKS Deployment is a Kubernetes API object and is not reachable over this transport at all. |
| `aws.app-runner/v1`, `aws.amplify-hosting/v1` | Creation is source-connection-scoped and returns a new ARN per call, with no documented list-by-name filter to converge against. |
| `aws.api-gateway/v1` | `CreateRestApi`/`CreateApi` assign a fresh random id per call with no name-uniqueness, so a retry after a lost response creates a second API. |
| `aws.cloudfront-site/v1` | `CreateDistribution` returns a new id per call; the caller reference is a deduplication window, not an identity. |

### Signing, credentials, and the transport guard

AWS does not accept a bearer token, so every request is signed with SigV4 by
`@hobo/core/aws-sigv4`. That signer is pinned in `@hobo/core`'s tests against
the official `aws-sig-v4-test-suite` vectors (`get-vanilla`,
`get-vanilla-query-order-key-case`, `get-header-key-duplicate`,
`get-header-value-order`, `get-header-value-trim`, `get-unreserved`,
`get-utf8`, `post-header-key-sort`, `post-x-www-form-urlencoded`), asserting the
canonical request, the string-to-sign, and the `Authorization` header for each
— the only real proof of a signer available to a repo that cannot reach the
live API.

Credentials are **locators**. `credentialRef` must match core's `scheme://path`
grammar; a value-shaped ref is refused with `RESOLVER_CREDENTIAL_NOT_A_REF`
before a call is spent. The host's injected `resolveCredential(ref)` returns
the access key id, secret access key, and optional session token, and material
appears in exactly one place — the `authorization` request header. The secret
access key is never transmitted at all (SigV4 sends a signature derived from
it), and provider error text is redacted before it reaches any message,
diagnostic, or output.

`guardedAwsTransport(inner, region)` applies the policy in `src/transport.ts`:
HTTPS only, exact-match allowlisted regional hosts for the six services above,
bounded body (512 KiB) and time (15 s), no redirect chasing. A region that does
not parse — or a China-partition region, whose endpoints terminate at a
different suffix — is refused rather than interpolated into a hostname.

### HONEST SCOPE — what the resolvers prove and what they do not

- The resolvers are exercised against an **injected fake transport** modelling
  an AWS account. That proves request formation, convergence, refusal codes,
  and redaction. It proves **nothing** about a live AWS account: no live call
  is made anywhere in this package's tests, no real credential is used, and no
  network egress happens.
- The SigV4 vectors prove the signature is computed as the published test suite
  says it should be. They do not prove any request was accepted or authorized.
- The transport guard constrains the request this package composes and the
  response it accepts. It cannot prove the injected transport honours
  `timeoutMs`, refuses to follow a 302 itself, or terminates TLS against the
  real AWS certificate — those remain the host's obligations.
- Resolvers do not create Resource Definitions. Whether a matching definition is
  registered in the catalog is still checked at resolution time
  (`YARD_BINDING_PRODUCT_UNKNOWN`).
- Every `desired` setting a resolver reads has a type: `versioning`,
  `publicAccessBlocked` and `fifo` are booleans, `readCapacity` and
  `visibilityTimeoutSeconds` are integers, `storageClass` and `billingMode`
  are strings, and so on through each product's options. A setting that is
  absent stays absent. One of another type, `null` included, is refused
  before any call with `RESOLVER_PRODUCT_UNSUPPORTED`
  (`aws.s3/v1: desired.versioning must be a boolean (true or false), received
  "true"`), never read as "not declared". A member of AWS's JSON answer with
  the wrong type (a `TableStatus` of `5`, say) is the provider's fault. It is
  refused as `RESOLVER_OUTPUT_UNPARSEABLE`, like any answer that cannot be
  read; an absent or `null` member is absent.
- A Secrets Manager secret **scheduled for deletion** (DescribeSecret answers
  `DeletedDate`) still holds its name for its recovery window, and AWS refuses
  CreateSecret, UpdateSecret and a second unforced DeleteSecret for it
  ([ADR-0175](../../../docs/design/adr/07-portability-extensibility.md#adr-0175)).
  - `read` reports it with action `delete`, `outputs.deletedDate`, and a
    diagnostic: "scheduled for deletion (DeletedDate <date>)", then what apply
    will do. The date is DescribeSecret's `DeletedDate` as AWS reports it, not
    a promise of when the secret is gone: the API calls it "the date the secret
    is scheduled for deletion", and does not equate it with DeleteSecret's
    `DeletionDate`, the end of the recovery window. It must be epoch seconds
    (fractional allowed, rounded half up toward +∞ to the millisecond from the
    number's decimal text, never its binary double, so `-1.0005` is
    `-1.000`) or an RFC 3339 date-time
    (either case, any fraction digits; a leap second, second 60, is refused),
    in the years 0000 to 9999. Both are reported as one canonical UTC instant,
    `YYYY-MM-DDTHH:MM:SS.fffZ`, with the fraction kept to the nanosecond. A
    `null` is the field's absence: not scheduled. Anything else is refused as
    `RESOLVER_OUTPUT_UNPARSEABLE`, because the secret's state cannot be read.
    Preview and drift say so; neither reports it absent.
  - `reconcile` **fails closed** by default (`RESOLVER_PROVIDER_REJECTED`): someone
    deleted it on purpose. Declare `restoreScheduled: true` to restore it with its
    previous versions (`RestoreSecret`, reported as `update`), or destroy it with
    `forceDelete: true` to delete it now. Both are `SecretsManagerOptions`
    fields: `secretsManager({ restoreScheduled: true })`,
    `secretsManager({ forceDelete: true })`. A forced delete cannot be undone.
    A restore counts only when the DescribeSecret after it shows the secret
    live. If it still shows `DeletedDate`, or no secret at all, `reconcile`
    refuses and says the restore did not take effect, and sends no
    `UpdateSecret`.
  - `delete` issues nothing more for it, and a `forceDelete: true` delete still
    deletes it at once, even when `DeletedDate` is unreadable (both calls name
    the secret by `SecretId`, and force ends the window whatever the date is).
    An unforced delete refuses an unreadable `DeletedDate`. An
    `InvalidRequestException` because someone scheduled it between the describe
    and the delete counts as done.
  - `restoreScheduled` and `forceDelete` are directives: they say how apply and
    delete act, not what the secret is, and `read` never reports them. The
    resolver lists them in its `directives`, so preview and drift leave them out
    of the comparison and say so. A plan that keeps either one previews and
    refreshes a live secret as clean as it would without it. Each is a boolean:
    any other value (`"true"`, `1`, `null`) is refused with
    `RESOLVER_PRODUCT_UNSUPPORTED` (like any wrong-type `desired` setting:
    `desired.forceDelete must be a boolean`), before `read`, `reconcile` or
    `delete` makes a call.
- Secrets Manager secrets are created **without a version**, and SSM
  `SecureString` parameters are **refused**: in both cases the value is
  credential material, and this resolver never carries it.

## Host forms for self-hosted data stores

`AWS_HOST_FORMS` (`src/host-forms.ts`) states, for compute products this
package already declares, whether each could host a self-managed, stateful,
TCP-served data store such as PostgreSQL: a long-running VM or container, a
persistent volume, inbound TCP, and enough control to run backups. Every facet
is cited to the vendor's documentation with the date it was read. It adds no
product and does not change the published Capability Manifest; it is read by
`assessSelfHostedDataStore` in `@hobo/core`. Cited documentation only — nothing
has been deployed onto these products from this repository. See
[`docs/design/postgres-backend-catalog.md`](../../../docs/design/postgres-backend-catalog.md).

### Virtual machine and block storage (catalog only)

`ec2Instance()` (`aws.ec2-instance/v1`, slot `service`, `service.worker/v1`) and `ebsVolume()`
(`aws.ebs-volume/v1`, slot `bucket`, `bucket.filesystem/v1`) are in the default Yard so
the VM-plus-block-storage form can be declared and assessed. They are catalog
only: both ids are in `AWS_UNRESOLVED_PRODUCT_IDS`, no resolver ships, and
nothing here provisions either. `AWS_HOST_FORMS` cites the vendor's
documentation for the VM and for the attached volume.
