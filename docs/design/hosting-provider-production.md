---
type: Design
title: "Hosting provider execution and production evidence"
description: "Native provider execution, durable custody, enforceable liabilities, and anonymous acceptance evidence for budgeted hosting."
tags: [hobo, hosting, providers, finops, resilience]
---

# Hosting provider execution and production evidence

This extends [budgeted hosting transitions](./hosting-budget-transitions.md) into the
application and provider adapters. An executable driver, financial admission,
application health, and final billing are separate claims. A registry entry alone
establishes none of the other three.

## Critical walkthrough and design goals

Suppose the cheapest candidate has an unknown price represented by zero. Choosing it
would reward missing information. Catalog costs preserve `unknown`, `estimate`, and
`verified-zero`. Units, regions, product identity and price provenance participate in
catalog identity. Strict admission requires dated, account-scoped quotes; unpriced
legacy discovery cannot claim a cost optimum. The planner remains deterministic and
greedy, so it can refuse a combination that a global optimizer might fund.

Suppose a migration settles successfully, then its destination runs for another month.
A migration-only hold misses the dominant liability. Production admission requires
independently supported native operating bounds for both source and destination,
binding resource, provider/account, content artifact, maximum amount, expiration and
evidence locator. Both global and payer-account sums must fit the commitment.
Provider-funded zero and native finite terms qualify; soft quotas, local timers and
expected teardown dates do not. Native expiration also needs interruption approval.
An already unbounded source cannot acquire a retrospective hard ceiling from a move.

Suppose a timed-out create is followed by a 404, then finishes late. Recreating or
releasing its hold would admit a second obligation. Durable mutation claims grant one
sender; an existing unacknowledged claim is uncertain. Missing GETs remain unknown
without terminal native-operation evidence. Explicit resume is bounded and requires
durable custody plus documented provider idempotency. It is not an automatic write retry.

Suppose a credential rotates after account verification. The verified account could
differ from the charged account. A credential lease resolves material once, hashes and
freezes it, and obtains challenged Ed25519 proofs from a pinned issuer enrolled for
the exact tenant, provider and native account. Every phase gets a new scoped proof;
IO keeps the captured version. Actual SQLite CAS prevents proof replay. A response's
public key cannot establish its own trust. Auxiliary credentials require separate leases.
Durable version pins prohibit re-enrolling different material under the same locator
and version. Locators also pin native scope; reusing an Azure token in a different
resource group requires a distinct scoped locator. The stock catalog has one configured
account scope per native provider, with explicit native/package aliases.

Suppose two DigitalOcean children update one App simultaneously. Per-child idempotency
does not prevent replacement of the shared parent specification from losing one update.
A durable provider/account/parent mutation scope serializes the whole read-modify-write.
Uncertain writes keep the scope occupied; clock expiry cannot prove they have finished.

Suppose two deployments use identical artifacts. Artifact hash alone cannot establish
resource ownership. Native identities and journal keys include deployment and approved
incarnation. Target names are not recycled across transitions. Decommission names the
approved source incarnation, preventing a delayed delete from retiring its replacement.

Suppose an anonymous provider lets a caller recover credentials using only its database
ID or allocation UUID. That identifier is a bearer capability, even when it looks like
ordinary inventory. Native operation keys use a private, version-pinned HMAC key;
public hashes cannot predict them. Native IDs, claim URLs and capability-bearing
bindings enter private custody before publication. Receipts, facts and durable resource
records expose opaque identities and custody locators. Rotation cannot retry an
uncertain allocation under a different key: its durable binding fingerprint refuses
that change. Public serialization requires custody and fails without it.
Public status and error projections redact native capabilities as well. Raw native
client responses remain privileged input to custody, rather than publishable evidence.

Suppose the provider reports READY while the old image serves requests. Readback must
establish the current generation and actual image/code digest. Graph ownership metadata
is an artifact marker, not content proof. Application health remains independent.
Retirement requires terminal operation evidence and exact physical identity. Final usage
needs an explicit safe integer amount and currency; an omitted scalar cannot default
to zero. Source retirement alone cannot finalize surviving destination liability.
Native serving endpoints also bind the health probe and actual Station backend. A
successful probe against another deployment, or a desired URL copied into evidence,
cannot establish readiness. Providers without an observed HTTP ingress need a native
ingress integration; an IAM invocation ARN or a control-plane URL cannot supply it.

## Concrete composition

`createProductionYardRuntime` composes one persistent SQLite store with the gateway,
authority and `createProductionHostingExecution` supervisor. Deploy, resume, cancel
and decommission use the same reservation. Live selection cannot fall through to
legacy unbudgeted apply when evidence is missing or a manifest removes its budget.

`createProductionHostingProviderCatalog` constructs shipped native registries using
explicit native/package aliases and verified credential leases. Data-only claimable
resolvers call actual Neon, Prisma and Upstash drivers, with deployment-incarnation
ownership and secret custody. `createDurableHostingResourceRepository` persists
generated, scoped, content-addressed envelopes: identities are immutable, observations
are monotonic, and connection strings, passwords and claim URLs are rejected.
Native desired-state metadata is compiled against each provider's actual accepted
fields. New resources use unique incarnation names and ownership hashes; imported
sources retain approved native parameters and require exact physical inventory.
Financial provider aliases are translated only through the explicit catalog mapping;
native lifecycle and billing scopes keep the native provider identity.

`createResolverHostingTransitionProvider` drives native resolvers and Station routing.
It pins approved graphs, independent resource content identities, account/native
inventory and routing plans. Explicit provider product IDs survive catalog projection
and planning; a control resource such as a Vercel project is not a deployment.
This stock adapter supports stateless moves with unchanged data resources pinned to
their source incarnation. Stateful transfer needs a workload-owned adapter that
actually implements the existing fencing, checkpoint, checksum and write-ownership
protocol. The stock adapter refuses that movement before provisioning; native database
creation cannot stand in for data migration. Explicitly approved decommission is separate.

`createHostingFinancialEvidenceReader` supplies concrete HTTPS ingestion for an installed
billing/prepaid/native-expiry integration. It verifies pinned Ed25519 keys, account and
resource scope, plan/operation identity, currency, freshness and monotonic durable
evidence. An integration signature authenticates that operator's evidence; it cannot
manufacture a cloud provider's spending guarantee. Missing integrations refuse new
effects or retain exposure. The [wire contract](./hosting-financial-evidence.md) defines
that installation boundary.

The shared HTTP implementation bounds bytes while streaming and enforces a total
deadline even when fetch ignores cancellation. Redirects remain manual. Native guards
restrict credential-bearing origins and scopes. Anonymous CLI paths pin versions,
exclude ambient login state through private child HOME directories, bound process
trees/output, and snapshot regular artifact files without configuration or symlinks.

## Every provider's role and validation boundary

Exported resolved-product lists define execution support. Unresolved catalog profiles
are refused. No registry claims to implement a provider's entire marketing catalog.

| Provider | Execution boundary | Live evidence in this review |
| --- | --- | --- |
| AWS | Supported native products; Lambda requires pinned OCI image and execution role. Its ARN is IAM-invocable; public HTTP needs separate ingress. | Credentials required; modeled API tests. |
| Azure | Scoped ARM products and Container Apps, terminal operations/current generation. | Credentials required; modeled API tests. |
| GCP | Scoped products and Cloud Run, exact project/service account/operation/generation. | Credentials required; modeled API tests. |
| Cloudflare | Native account-scoped products and Workers. | Anonymous worker HTTP 200; native delete and independent absence confirmed. |
| Vercel | Project/edge-config control resources and immutable static deployment. Unsafe authenticated CLI fallback removed; no anonymous default claimed. | Credentials required; modeled API tests. |
| Netlify | Account-scoped site and immutable static deployment; anonymous Drop is separate. | Temporary site passed real form/cookie authentication and HTTP 200 marker check. |
| DigitalOcean | Supported native products; shared-App writes use durable parent serialization. | Credentials required; modeled API tests. |
| Hetzner | Supported compute, storage and load-balancing products with pinned identities. | Credentials required; modeled API tests. |
| Hostinger | Supported native products; VPS delete cannot cancel its fixed-term purchase liability. | Credentials required; modeled API tests. |
| Kubernetes | Actual API-server resolvers with generation/updated replicas and ownership checks; secrets use custody. | No cluster supplied; modeled API tests. |
| Railway | Existing project/environment/service; journalled pinned-commit deployment and native stopped evidence. | Credentials required; modeled GraphQL tests. |
| Neon | Claimable data-only driver/resolver, durable ownership and custody. | Native UNCLAIMED read and actual SQL-over-HTTP SELECT 1. |
| Prisma Postgres | Claimable data-only CLI driver/resolver, atomic allocation and bounded isolated process. | Anonymous creation succeeded; later SQL ECONNREFUSED. Health/retirement unconfirmed. |
| Upstash | Claimable Redis driver/resolver; REST/native credentials stay in custody. | Original allocation adopted; actual Redis REST PING returned PONG. |
| Lakebed | Anonymous capsule adapter; native claim identity/expiration. | Native deployment GET and /health HTTP 200 with expected marker. |
| Convex | Authenticated HTTPS management adapter. | Anonymous management creation unsupported; offline tests. |
| Browser WASM | Requires actual injected browser guest/runtime and same-origin transport. | Browser runtime unavailable; explicit refusal. |
| Webernetes | Requires actual local temporary transport, no invented public endpoint. | Real local HTTP tests; no public deployment claimed. |
| ttl.sh | Expiring OCI artifact registry; artifact lifetime differs from compute lifetime. | Offline registry tests; no compute deployment claimed. |
| Kafka | Broker/message adapter. | Offline broker tests; not HTTP compute. |
| Flux | GitOps reconciliation. | Not independent metered compute capacity. |
| OPA | Policy evaluation. | Outside direct hosting creation. |
| Cedar | Policy evaluation. | Outside direct hosting creation. |
| Config | Configuration. | Outside direct hosting creation. |
| AX | Agent execution integration. | Outside cloud hosting capacity. |
| AgentV | Agent evaluation integration. | Outside cloud hosting capacity. |
| GitHub runner | CI execution. | Outside this hosting task. |
| Depot runner | CI execution. | Outside this hosting task. |
| Blacksmith runner | CI execution. | Outside this hosting task. |

## Anonymous acceptance, 2026-10-29/30 UTC

External creation used anonymous temporary APIs. No connected permanent Cloudflare
account or paid provider account was used. Native responses and credentials stay outside
the checkout with private filesystem permissions. The manual harness is an explicit
external-service lane, separate from ordinary package/PR checks.

Actual checks exposed Upstash's new credential-bearing Redis URL, Lakebed's multiline
JSON/changed native claim host, and Netlify's form/cookie password flow. Existing
allocations were recovered after parsing/probe failures without blind recreation.
Lakebed's first scaffold failed before allocation; after its corrected allocation's
parser failed, recovery used its saved native deployment identity.

An additional Cloudflare check exercised the shipped generic registry and durable
mutation journal. It exposed missing multipart source readback and native Workers
subdomain activation. The corrected resolver verified the deployed source digest,
observed an enabled native endpoint and served HTTP 200 with the expected marker.
Public activation is explicit; private Workers do not acquire an endpoint by default.
Generic deletion, independent resolver absence and native HTTP 404 confirmed cleanup
at 2026-10-30T01:04:30Z. The earlier temporary Worker was also confirmed absent at
2026-10-29T23:47:14Z. Temporary-account retirement remains unconfirmed.

Other anonymous services
do not offer a uniform delete/final-billing API. Native expirations are deadlines,
not observed retirement: Neon reported 2026-11-01T23:34:21Z, Upstash 2026-11-01T00:00:00Z,
and Lakebed 2026-11-06T00:02:21Z. Prisma requested a 30-minute term; its later failed
connection proves neither health nor deletion. Netlify's claim deadline likewise
does not prove absence. Those resources remain explicitly unconfirmed for retirement.

These observations establish only the listed native and data-plane behavior. They do
not certify paid-provider billing, cross-provider state transfer or every region.
An ordinary metered service without an enforceable financial bound remains ineligible
for a strict absolute ceiling even when its deployment API works.

## Executable evidence

The [scenario ledger](../plans/0022-budgeted-cloud-hosting-transitions.md#executable-scenario-ledger)
maps the original core regressions. Production suites additionally cover:

- Core lifecycle parsing and actual CUE: stale/foreign/nonterminal evidence and explicit monetary amounts.
- Hobo resource-store and mutation tests: independent SQLite connections, reopen, immutable identities, secret refusal and parent-write races.
- Credential-scope tests: pinned signatures, replay, phase scope and actual material rotation.
- Financial-evidence tests: real local HTTP plus SQLite, signed scope/currency/freshness/finality.
- Provider-catalog tests: shipped registries and explicit aliases, with actual driver HTTP and captured credentials.
- Alias integration tests: the shipped GCP resolver, real SQLite, signed credential/financial HTTP evidence and Station routing; foreign-account evidence refuses before creation.
- Claimable-provider tests: secret-derived operation keys, opaque public serialization, private custody, lost responses and changed-key refusal.
- Cloud transition tests: source/destination liabilities, retained reservations, explicit decommission and bounded resume.
- Provider lifecycle/boundary/contract suites: native scope, current content, lost replies, bounded discovery and unsafe CLI refusal.

Hand-authored API expectations are consumer contracts, not provider-verified traffic.
They remain separate from the live observations above.

The final workspace lane bounds per-package Vitest workers with `VITEST_MAX_WORKERS`,
passed through Turbo's strict environment. Build outputs must settle before compiled
CLI subprocess tests start; otherwise concurrent compilation can expose partial files.

The [provider validation record](../plans/0022-budgeted-cloud-hosting-transitions.md#provider-validation-record--2026-10-30)
records 9,990 passing tests across 29 affected workspaces, the complete schema and
behavior checks, and the final standards annotation repair. These results establish
the tested adapter contracts and refusal behavior; the live evidence above defines
the narrower external acceptance boundary.
