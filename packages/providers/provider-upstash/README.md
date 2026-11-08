# `@hobo/provider-upstash`

`upstash.temporary-redis/v1` — a Redis database created with **no account and no
API key**, handed back with a live credential in a markdown document, and
deleted a few days later unless a human claims it.

Everything here is data, pure functions, and injected ports. There is no
`fetch`, no `Date.now()`, no `process.env`, and no filesystem access anywhere in
`src/`: the network arrives as an `UpstashTransport`, credentials leave through a
`SecretCustodyPort`, and the clock is a `() => number` you supply.

## What the provider actually gives you

| Aspect | Value | Source | Checked |
|---|---|---|---|
| Creation | `POST https://upstash.com/start-redis` | [start-redis](https://upstash.com/start-redis) | 2026-08-08 |
| Signup required | No | [getstarted](https://upstash.com/docs/redis/sdks/ts/getstarted) | 2026-08-08 |
| Cost | Free, on the provider's own allowance | same | 2026-08-08 |
| Response | `text/markdown` — credentials embedded in a quickstart | [start-redis](https://upstash.com/start-redis) | 2026-08-08 |
| Idempotency | `Idempotency-Key: <uuidv4>`, and the key **becomes** the database id | same | 2026-08-08 |
| Lifetime unclaimed | ~72 hours; the response states a calendar date | [announcement](https://upstash.com/blog/redis-database-for-agents) | 2026-08-08 |
| Claim | Open the console URL and attach it to your Upstash account | same | 2026-08-08 |
| Data plane | Upstash Redis REST: `https://<host>.upstash.io`, bearer token, JSON command array | [getstarted](https://upstash.com/docs/redis/sdks/ts/getstarted) | 2026-08-08 |

### Facts that could not be verified

These are encoded as *absences*, not as guesses. Each one is a capability this
package declines to advertise, which means a requirement that needs it fails
closed rather than landing here.

| Not verified | How it is handled |
|---|---|
| Maximum value size, request quota, storage ceiling | Not declared. Upstash publishes free-tier numbers for **accounts**; nothing documents them for this surface, and borrowing them would be an invented limit a planner would then enforce. `maxValueBytes` is absent from `UPSTASH_STRUCTURED_CAPABILITIES`. |
| Region / residency | `regions: []`. The surface neither accepts a region nor reports one back. |
| A delete or teardown endpoint | Assumed not to exist. `destroy` refuses on a live database and returns manual guidance. |
| A token-rotation API | Assumed not to exist. Rotation is modelled as a **blocking human action** in the owner's console, never as something this driver can perform. |
| RESP/TLS protocol access | Not declared. Upstash databases do speak RESP, but the no-signup response documents only the REST endpoint, and there is no conformance evidence for a protocol connection built from it. `binding.redis-protocol/v1` is **not** produced. |
| Whether a given database has been claimed | Unobservable. The response carries nothing that distinguishes claimed from unclaimed, so claim state comes from an explicit `ClaimAttestation` rather than a heuristic. |

## Parsing a credential out of prose

The response is a human-readable markdown document with a bearer token in it, no
version header, and no JSON alternative. The tempting approach — find something
URL-shaped, find something token-shaped — keeps "working" after Upstash
restyles the page and hands the caller the wrong string instead of an error.

So `parseStartRedisResponse` (contract `upstash.start-redis.markdown/v1`) does no
scraping:

- the document must open with the exact expected heading, so an error page or a
  captive portal fails on line one instead of being mined for fields;
- exactly five labels are understood — `Database ID`, `Endpoint`, `Token`,
  `Metrics`, `Expires` — each required, each permitted once. **An unreviewed
  sixth field is a rejection.** The field Upstash is most likely to add is
  another credential, and skipping it would mean a token this driver neither
  deposits nor redacts;
- a repeated label is a rejection, because its value is ambiguous;
- every value has its own shape: UUIDv4 id, an `https://<host>.upstash.io`
  endpoint, a 20–1024 character token charset, a metrics URL addressing the
  returned id, and `<YYYY-MM-DD> (N days from creation)`;
- the console URL must name the same database as the `Database ID` field, and
  only one database's console URL may appear — a console link pointing elsewhere
  is a claim hijack with no benign reading;
- bounds come first: 16 KiB, 200 lines, 1024 characters per line.

Prose between the fields is ignored on purpose, but still counted against the
bounds. Anything unparseable fails closed with `PROVIDER_CONTRACT_CHANGED`.
There is no partial success: a response missing the endpoint is not a database
with an unknown endpoint, it is a document this driver does not understand.

Widening the parser for a new shape means **bumping the contract id**, not
loosening the regexes in place.

## Credentials never reach a receipt

The plaintext token exists in exactly one function scope. `captureCredentials`
deposits it into the injected `SecretCustodyPort` and keeps only the `SecretRef`;
nothing downstream ever sees the value.

- `StartRedisDatabase.token` holds the REST token. The native database UUID,
  console URL and metrics URL are also privileged: anonymous credential
  retrieval is keyed by that UUID. Keep parser and driver working records
  private, and use the custody-required public serializers for public output.
- A custody port that fails deposits nothing and raises
  `SECRET_CUSTODY_UNAVAILABLE`; one that hands back something that is not a
  valid reference raises `SECRET_REFERENCE_INVALID`. Neither degrades to a
  plaintext field.
- `redactProviderText` runs on every error message and every string-valued error
  detail **at construction time**, not when someone remembers to call it. The
  structural rule is the load-bearing one: an Upstash token is a long base64url
  string with no prefix to match, so any unbroken run of 40+ token characters is
  treated as credential material. Native database UUIDs are also bearer
  capabilities: knowing one permits anonymous credential retrieval. The public
  serializers separately compare against the known native identity and claim URL.
- `await toProvisionReceipt(record, exposure)` and
  `await toProviderFacts(record, exposure)` require secret custody, tenant/account/
  incarnation scope and a host-secret-backed operation-key deriver. Version 2
  output carries opaque physical IDs, native identity locators and claim locators;
  raw native IDs, claim URLs and their occurrences inside input resource refs
  never enter public receipts or facts. Both projections re-scan their output
  and reject a custody locator that republishes a native capability.

Tests assert the token appears in no receipt, no fact, no binding, no error
message, and no fixture.

## Idempotency, and why adoption is a re-POST

An orphaned anonymous Redis is invisible: no account lists it, and no endpoint
deletes it. A duplicate created while resolving an ambiguous timeout is not an
untidy leftover — it is a live, credentialed database nobody will ever find
again.

The provider derives the database id from the `Idempotency-Key`, so a repeat POST
with the same key returns the same database. This client is built entirely around
that: **adoption is a re-POST of the original key, never a fresh create.** The
returned id must equal the key supplied, or the call is refused with
`PROVIDER_CONTRACT_CHANGED` — if that stopped being true, adoption would silently
become duplication.

A 5xx on a create is reported as `PROVIDER_OPERATION_AMBIGUOUS` and the
idempotency record is deliberately left `in-flight`. `createDatabase` does not
retry it; `adoptDatabase` does, because only a same-key POST is safe to repeat.

## The lease is the provider's figure

There is no 72-hour timer in this package. `expiresAtMs` comes from the response,
and `expirySource` is `"provider-reported"` to say so. The documented number
lives separately in `UPSTASH_UNCLAIMED_LIMITS.documentedExpiryHours`, named as
documentation so a plan can *say* what to expect before the call without the two
ever being confused.

The provider states a calendar day rather than an instant, so `expiresAtMs` is
the **start** of that day: the two ends of it disagree by 24 hours, and treating
a lease as over slightly early beats handing out one the provider has already
reaped.

## Claiming, and the part everyone forgets

Claiming attaches the database to a human's Upstash account and lifts the expiry.
It does **not** invalidate the token the creating party already holds. So the
claim plan has two blocking actions, not one:

1. `upstash.claim.transfer-to-account` — the human ceremony at the console URL.
2. `upstash.claim.rotate-rest-token` — the owner resets the REST token by hand.

State is `unclaimed` → `claimed-pending-rotation` → `complete`, and `complete`
requires both. A claim without a rotation has not ended anyone's access, so
reporting it as finished would be a lie with a live credential behind it.

Both transitions are recorded through `attestClaim` / `attestRotation` — explicit
attestations naming who did it and against what evidence. That is deliberately
not `rotateBinding()`: a method by that name would imply this driver can rotate,
and it cannot.

## Teardown

There is none, and `destroy` says so out loud rather than pretending:

| Situation | Outcome |
|---|---|
| Expiry has already passed | `{ destroyed: false }` — retirement remains unverified until independent provider evidence confirms absence and final usage |
| Unclaimed and still live | throws `CLEANUP_FAILED` — no delete endpoint exists |
| Claimed | throws `CLEANUP_FAILED` — it belongs to the owning account now, and only that console can delete it |

A `destroy` that quietly returned success would leave a live, credentialed,
anonymous database behind while the caller's state said it was gone. Callers that
catch `CLEANUP_FAILED` should render `manualTeardownGuidance(record)`, which
returns the operator-facing `DestroyOutcome` — exported so the advice does not
drift across call sites.

## Redis-compatible is not a queue and not a topic

This product implements `kv.redis-compatible/v1` and `kv.key-value/v1`,
natively, and produces `binding.redis-rest/v1`. It claims nothing else.

Redis has lists, streams, and pub/sub, so "Redis-compatible" reads like a queue
and a topic if you squint. `queue.at-least-once/v1`, `queue.fifo/v1`,
`topic.pubsub/v1`, and `topic.durable-log/v1` promise delivery guarantees a
command surface does not, and each needs its own evidence.
`assertNoQueueTopicImplication` runs on this package's own declaration **at
module load**, so adding one on the strength of "Redis has lists" is a build
failure. `test/definition.test.ts` drives `selectCapabilityImplementation` and
asserts a `PROFILE_INCOMPATIBLE` rejection for all four.

## Conformance: what is and is not claimed

`conformance: "pass"` against
`…/kv.redis-compatible/v1#upstash.temporary-redis@offline-reference-store@2026-08-08`.

Read the ref: **the adapter was measured, Upstash was not.** `test/conformance.test.ts`
runs the full `kv.redis-compatible/v1` suite through the real
`createUpstashRestExecutor` — real JSON command array, real bearer header, real
`{result}`/`{error}` envelope — against the reference store from
`@hobo/kv-redis-compatible` standing in for the server. That proves the command
mapping, the envelope, and the error mapping. It proves nothing about the live
service.

A catalog owner who needs the stronger claim should re-run the suite against a
real database and re-sign the ref.

The adapter exposes no `advanceTime`: a real endpoint has a real clock, and
offering one would let the suite "prove" TTL behaviour it never observed. The
offline harness borrows the *reference server's* clock instead, and a test pins
the degradation — with no clock the run reports `incomplete`, which projects to
`unknown` conformance, which selection rejects.

Substantiated: `ttl`, `atomicIncrement`, `sortedSets`, `restTransport`,
`redisCommandSemantics`. Not substantiated and not advertised: `maxValueBytes`.

## Maturity

**Experimental surface, verified-emerging provider class.** Suitable for agents,
demos, scratch state, and CI fixtures. Not suitable for anything whose loss
matters: the database is deleted at expiry unless a human intervenes, there is no
export path (`migrationProfiles: []`), no revocation (`supportsRevocation: false`),
and until it is claimed, anyone holding its id and token can read and write it.

The candidate does clear `DEFAULT_TRUST_POLICY` — its authority is rotatable and
the claim takes two actions — so a policy that should not land here needs to say
so, via `creatorAuthorityAfterClaim: "must-be-absent"` or
`requireExportProfile: true`. Both are asserted in `test/definition.test.ts`.

## Parse, don't validate

Nothing here re-checks a value it already accepted. Untrusted input crosses one
parser and comes out as a **derived domain type** that cannot hold the rejected
case:

- `parseStartRedisResponse` turns the whole markdown document into a
  `StartRedisDatabase`: a UUIDv4 id, a `<host>.upstash.io` endpoint, a metrics
  URL addressing that same id, a console URL naming that same database, and a
  calendar date plus the instant derived from it. Downstream code never
  re-inspects those fields, because a document that does not satisfy them never
  becomes a `StartRedisDatabase` — it is `PROVIDER_CONTRACT_CHANGED`.
- The token is the one credential-shaped value and it lives for one hop:
  `depositSecret` hands it to custody and returns a **parsed** `SecretRef`
  (`parseSecretRef` rejects a custody port that echoes the plaintext back), so
  every record, receipt, fact, and binding downstream holds a locator it cannot
  dereference.
- `assertAllowedEndpoint` parses a URL against a `TransportPolicy` rather than
  prefix-testing it, so the host allowlist, the scheme, the port, and the
  redirect refusal are properties of the parsed request, not of a call site
  that has to remember them.
- Claim state is derived from attestations (`ClaimAttestation`,
  `RotationAttestation`) rather than from a boolean, so "claimed, but the
  pre-claim token still works" is a nameable state instead of a gap.

`data-models/temporary_redis.proto` is the wire view of these shapes, and it is
compiled: `pnpm run codegen` generates `src/_generated/temporary_redis_pb.ts`,
and every record type above is a `DomainView` (`src/wire.ts`) of its generated
message rather than a hand-written parallel interface. The view names only what
it refines — the claim-state vocabulary, the literal claim boundary, branded
`SecretRef` locators, epoch milliseconds as a JSON-safe `number`, and the
plaintext `token` the wire form must never carry — and inherits everything else,
so renaming a proto field is a compile error here rather than silent drift.
`data-models/temporary_redis.cue` carries the invariants the parse boundary
enforces — UUIDv4 ids, the `.upstash.io` host rule, metrics and console
URLs that address the record's own database id, locator-shaped secret refs, two
blocking claim actions, an empty migration-profile list, and `teardown:
"expiry-only"` because there is no delete API to call. Neither file has a field
that could hold the token.

## Event architecture

This package is a strategy leaf: it owns no reducer, no stream, and no store.
The durable machinery is `@hobo/claims` plus `packages/hobo/src/claim-plane.ts`,
and what this package contributes is one honest observation per interaction.

1. A **command** from the claim family — `ReserveGuestLease`,
   `RecordProvisionedSubject`, `ObserveClaimItem`, `VerifyOwnership`,
   `RotateCapabilityBinding`, `ExpireGuestLease` — is what a caller issues.
   `provision()`, `observe()`, `verifyOwnership()`, `attestClaim()`, and
   `attestRotation()` are the effectful halves those commands drive here.
2. `await toProviderFacts(record, exposure)` returns this package's observations
   (`provider.upstash.database.provisioned` / `.adopted`,
   `provider.upstash.claim.pending-rotation` / `.completed`,
   `provider.upstash.lease.expired`). They are locator-only facts, not durable
   events: the claim coordinator **actor** (`reduce` in `@hobo/claims`) is what
   turns them into the **events** `ProviderSubjectProvisioned`,
   `ClaimStatusObserved`, `OwnershipVerified`, `CapabilityBindingRotated`, and
   `GuestLeaseExpired`.
3. `applyClaimCommand` appends the command and those events to the durable
   **event store** on the `claim:<deploymentRef>` stream under an optimistic
   `expectedSeq`, after `assertNoSecrets` has refused any payload carrying a
   console URL or a token.
4. `rebuildClaimState` folds the stored command journal back into a
   **snapshot** (`ClaimPlaneSnapshot`, carrying the store sequence it was folded
   at), which the next append fences against.
5. `claimStatusView` is the **projection** over that snapshot — the claim-bundle
   **materialized view**, per-item deadlines and outstanding obligations intact
   — and it is the **read store** `hobo claim status` renders.

Two local details keep that chain honest. The anonymous surface has no
authenticated read-back, so nothing here emits a fact claiming the provider
confirmed a claim: a `ClaimStatusObserved` sourced from this package is an
attestation or a lease clock, and the projection shows which. And because
`complete` requires the rotation attestation as well, a bundle cannot report
itself finished while `upstash.claim.rotate-rest-token` is outstanding.

## Error codes

Every failure is an `UpstashProviderError` carrying a stable code:

`PROVIDER_AUTH_FAILED` · `PROVIDER_RATE_LIMITED` · `PROVIDER_CONTRACT_CHANGED` ·
`PROVIDER_OPERATION_AMBIGUOUS` · `LEASE_EXPIRED` · `CLAIM_EXPIRED` ·
`CLAIM_NOT_VERIFIED` · `SECRET_REFERENCE_INVALID` ·
`SECRET_CUSTODY_UNAVAILABLE` · `CLEANUP_FAILED`

Two are **additions to the platform baseline** and need a coordinator decision to
promote or rename:

- `CLAIM_NOT_VERIFIED` — ownership could not be *proved*, which is not the same
  as a claim window having expired. Folding it into `CLAIM_EXPIRED` would tell an
  operator to re-run a ceremony that may already have worked.
- `SECRET_CUSTODY_UNAVAILABLE` — the deposit side failed. Reporting that as
  `SECRET_REFERENCE_INVALID` would blame a reference that was never issued.

## Transport

`createGuardedTransport` wraps whatever you inject and enforces the policy before
the request leaves: HTTPS only, an explicit host allowlist
(`upstash.com` for the control plane, `.upstash.io` for the data plane), a path
prefix, no redirect following, a bounded body, and a timeout. A redirect is
refused rather than followed — a 302 off the allowlist is exactly how a bearer
token ends up somewhere else.

### Where the URL check lives, and where it does not

`assertAllowedEndpoint` is now `@hobo/core`'s, translated back into an
`UpstashProviderError` at the boundary the way `provider-vercel` does it. The
data plane is what needed core to grow anything: per-database origins are
`<name>-<id>.upstash.io`, a host nobody can write down in advance, so core's
policy gained `allowedHostSuffixes` — a union with `allowedHosts`, never a
replacement.

That move closed a hole the local copy carried. The copy applied its suffix with
a bare `endsWith` and never checked the suffix's *shape*, so a policy written
`upstash.io` instead of `.upstash.io` admitted `evilupstash.io`, and `.io`
admitted the registry. Both were measured, not theorised. Core validates each
entry before it judges any URL and refuses an unusable one outright, so the hole
is no longer one character away.

The response half of the guard deliberately stays here, because two behaviours
differ from `guardTransport` and swapping it in would change what this driver
does rather than share an implementation:

| | this package | `guardTransport` |
|---|---|---|
| caller asks for more time or bytes than the policy allows | clamped to the policy | refused, by stated doctrine |
| a 3xx carrying no `Location` (a 304) | refused | passed through as a cache answer |

Reconciling either is a behaviour change to argue on its own merits. The clamp
in particular is pinned by `test/transport.test.ts`.

`createFetchTransport` is a minimal WHATWG-`fetch` adapter for production use.
Nothing in `src/` reaches for a global.

## API surface

```ts
// Product declaration (data only)
UPSTASH_DEFINITION_ID · UPSTASH_ALIAS_DEFINITION_ID · UPSTASH_DEFINITION_IDS
UPSTASH_TEMPORARY_REDIS_CANDIDATE · createUpstashTemporaryRedisCandidate()
UPSTASH_RESOURCE_SEMANTICS · createUpstashResourceSemantics()
UPSTASH_RESOURCE_DEFINITION · createUpstashResourceDefinition()
UPSTASH_PROFILE_IMPLEMENTATIONS · UPSTASH_STRUCTURED_CAPABILITIES
UPSTASH_BINDING_PROFILE_REFS · UPSTASH_UNCLAIMED_LIMITS · UPSTASH_SOURCE_REFS
UPSTASH_CONFORMANCE_REF · UPSTASH_CLAIM_ACTION_COUNT

// Pure compiler
compileUpstashTemporaryRedis(spec): UpstashCompiledPlan

// Control plane
createUpstashClient(options): UpstashClient        // createDatabase · adoptDatabase · getMetrics
createInMemoryIdempotencyStore(seed?)

// Driver
createUpstashTemporaryRedisDriver(options): UpstashTemporaryRedisDriver
//   provision · observe · verifyOwnership · verifyClaim
//   attestClaim · attestRotation · destroy · assertLeaseLive · assertClaimable
manualTeardownGuidance()

// Data plane
createUpstashRestExecutor(options)   // a KvRedisExecutor over the REST API
parseRestReply(body)

// Parsing, custody, bindings, receipts
parseStartRedisResponse(body) · describeStartRedisDatabase(db) · parseStartRedisMetrics()
depositSecret() · resolveSecret()
buildUpstashCapabilityBinding() · restEndpointRef()
toProvisionReceipt() · toProviderFacts() · assertNoCredentialMaterial() · scanForCredentialMaterial()

// Transport
createGuardedTransport() · createFetchTransport() · assertAllowedEndpoint()
UPSTASH_CONTROL_PLANE_POLICY · UPSTASH_DATA_PLANE_POLICY

// Errors
UpstashProviderError · isProviderError() · providerErrorForStatus() · redactProviderText()
PROVIDER_ERROR_CODES
```

## Testing

```bash
pnpm --filter @hobo/provider-upstash run build
pnpm --filter @hobo/provider-upstash run test
```

Fully offline; there is no live lane. Fixtures live in `test/fixtures/` and every
credential in them is obviously fake
(`FAKE-upstash-rest-token-DO-NOT-USE-0000`, `fake-mallard-000000.upstash.io`).
The fake token is deliberately short and hyphenated so that a fixture leaking
into a receipt is still caught by the credential scanner, rather than passing
because the value happened to be small.

| Suite | Covers |
|---|---|
| `test/start-redis.test.ts` | strict parser success; every malformed, ambiguous, oversized, and unknown-field rejection; token absent from every diagnostic |
| `test/transport.test.ts` | host allowlist, HTTPS, redirect refusal, size cap, redaction, status mapping |
| `test/idempotency.test.ts` | key validation, adoption, ambiguity left in-flight, metrics 404 → `LEASE_EXPIRED` |
| `test/driver.test.ts` | provisioning, custody failure modes, the 72-hour lease fixture, claim observe/verify/attest, rotation, expiry, teardown refusal |
| `test/contract.test.ts` | replays `contracts/*.pact.json` through the real client |
| `test/conformance.test.ts` | the full `kv.redis-compatible/v1` suite over the real REST adapter |
| `test/definition.test.ts` | declaration honesty, selection outcomes, `PROFILE_INCOMPATIBLE` for queue and topic |

## Layout

| Path | Contents |
|---|---|
| `src/definition.ts` | the data-only product declaration and selection candidate |
| `src/start-redis.ts` | the narrow versioned markdown parser |
| `src/client.ts` | idempotency, adoption, metrics |
| `src/driver.ts` | lifecycle, claim state, ownership, teardown |
| `src/custody.ts` · `src/binding.ts` | secret deposit and the portable binding |
| `src/rest-executor.ts` | the `KvRedisExecutor` over Upstash REST |
| `src/compile.ts` | the pure compiler |
| `src/receipt.ts` | receipts, facts, and the credential scanner |
| `src/transport.ts` | the injected transport port and its guard |
| `src/wire.ts` | `DomainView`, how a domain type refines a generated message |
| `src/_generated/` | `pnpm run codegen` output; never hand-edited |
| `contracts/` | the `start-redis` pact and what it does and does not verify |
| `data-models/` | the protobuf wire view plus the CUE invariants for the parsed response, record, and receipt |

## Hosting budget execution

The reviewed live response now includes `Redis URL`. The parser preserves the five-field
v1 contract and recognizes the additional credential as `upstash.start-redis.markdown/v2`.
The native URI must use TLS, the exact REST endpoint hostname and port 6379, with no
query, fragment or path. It is deposited under custody purpose `redis-protocol-url`;
records and receipts contain only `redisProtocolUrlRef`. Unknown or duplicate fields
still fail closed. Tests cover independent native credentials, custody, secret-free
summaries/receipts/facts and malicious endpoint substitution.

`destroy(record, context)` can consume an injected independent `retirement` observation.
Only fresh, exact-scope terminal absence and final usage return `destroyed: true`, with
retirement and usage evidence references. A passed expiry alone retains financial
exposure. The anonymous surface still supplies no deletion endpoint. Native Redis and
REST connection material remain outside event payloads.

The real fetch transport delegates to core's streaming body limit and total deadline;
retries wait according to policy and `Retry-After` rather than busy-looping.

`createUpstashTemporaryRedisResolver` composes the actual temporary Redis driver
with the shared resolver protocol, a durable CAS repository and mutation journal.
Keys derive from tenant/account/deployment-incarnation/product/logical-resource
scope, so reused author keys cannot adopt another deployment's database. Reads
use `observeMetrics` and the native GET metrics endpoint; they never re-POST a
create. Claim URLs and capability bindings enter custody and outcomes contain
locators only. The current response's optional native `rediss://` connection URL
is deposited with purpose `redis-protocol-url` and never appears in a receipt.
A native expiry or a missing metrics record alone does not prove terminal
retirement or final billing, and the anonymous API publishes no delete endpoint.

Public serialization uses `PublicSerializationOptions`: `{ custody, scope,
deriveOperationKey }`. Obtain the deriver from
`createClaimableOperationKeyDeriver(privateHostKeyBytes)` in `@hobo/core`; capture
at least 256 private bits from the host vault and pin their version. Public run
IDs or author seeds are not suitable key material. Calls without custody refuse
before producing output, and custody failures are masked without exposing their
causes. Raw `StartRedisDatabase` and driver working records are privileged host
data; they must stay in private custody rather than ordinary event streams.
