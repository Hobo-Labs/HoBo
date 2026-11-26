# `@hobo/provider-ttl-sh`

`ttl-sh.ephemeral-oci-artifact/v1` — an **artifact transport**, not a host.
[ttl.sh](https://ttl.sh) is an anonymous, ephemeral OCI registry: you push an
image to `ttl.sh/<name>:<ttl>` with no account and no credential, and the
registry deletes it when the TTL runs out. HoBo uses it for the anonymous
deployment path in ADR-0151: when a container image has to reach a host that
pulls from a registry and the human has no registry account yet, HoBo pushes the
image here and hands the host a pull reference that expires on its own.

Nothing is stored, nothing is owned, and nothing is ever claimed. The lease
*is* the TTL, and the cleanup policy *is* expiry.

Everything in `src/` is data, pure functions, and injected ports. There is no
`fetch`, no `Date.now()`, no `process.env`, no filesystem access, and no
`child_process` import: the network arrives as a `TtlShTransport`, the push
arrives as an `OciPushExecutor`, the subprocess arrives as a `ProcessRunner`,
and the clock is a number you pass in.

## What the provider actually gives you

| Aspect | Value | Source | Checked |
|---|---|---|---|
| Push | `ttl.sh/<name>:<ttl>`, OCI distribution API over HTTPS | [ttl.sh](https://ttl.sh) | 2026-08-08 |
| Signup required | No — anonymous in both directions | [ttl.sh](https://ttl.sh) | 2026-08-08 |
| Credential | None issued, none accepted | [ttl.sh](https://ttl.sh) | 2026-08-08 |
| Read access | Anyone holding the reference can pull | [ttl.sh](https://ttl.sh) | 2026-08-08 |
| Lifetime | The TTL in the tag, `1m`–`24h` | [replicatedhq/ttl.sh](https://github.com/replicatedhq/ttl.sh) | 2026-08-08 |
| Delete | No endpoint; the registry's reaper is the only teardown | same | 2026-08-08 |
| Claim | Does not exist | same | 2026-08-08 |
| Cost | Free, on the service's own allowance | same | 2026-08-08 |

The rows citing [ttl.sh](https://ttl.sh) were read off the live landing page on
2026-08-08, which is where the wording "set your TTL from minutes to 24 hours"
and the `:5m | :1h | :24h` examples come from, and `TTL_SH_SOURCE_REFS` marks that
source `verified: true`. The `replicatedhq/ttl.sh` repository responds but its
contents were not re-read, so it stays `verified: false` — the "no delete
endpoint" fact rests on documentation, and a catalog owner can see that before
signing the evidence.

### Facts that could not be verified

Encoded as *absences* rather than guesses. An unset structured capability fails
a `required` feature gate, which is the correct outcome for something nobody
measured.

| Not verified | How it is handled |
|---|---|
| Maximum artifact size | Not declared. Inventing a ceiling would put a fabricated limit into a plan. |
| Rate limits | Not declared. A 429 is mapped to `PROVIDER_RATE_LIMITED` at runtime instead. |
| Region / residency | `regions: []`. The service publishes none and reports none back. |
| Availability, SLA, support | None promised, so `providerClass` is `experimental`, which keeps this out of automatic selection unless an operator lowers `minimumProviderClass` deliberately. |
| Whether an artifact still exists | Unobservable without a read. `expiresAtMs` is local arithmetic over the requested TTL, and every receipt says `expirySource: "computed-from-ttl"` rather than pretending the registry stated it. |

## The four refusals that carry the security of this package

An anonymous registry moves the risk somewhere unusual, so the interesting code
is all refusal:

1. **A guessable name is refused.** The registry authenticates nobody, so the
   artifact name is the *only* thing between the image and the public. A name a
   human would pick — `my-app`, a branch name, a ticket id — is a published
   artifact whose author cannot tell the difference until someone else pulls it.
   `parseArtifactName` accepts a lowercase UUID or a content-addressed
   `sha256-<digest>` and nothing else (`GUESSABLE_ARTIFACT_NAME`).
2. **A credential is refused, not stripped.** ttl.sh accepts none, so an
   `Authorization`, `x-registry-auth`, `cookie`, or `proxy-authorization` header
   is a credential meant for somewhere *else* being handed to an anonymous
   endpoint. `assertNoCredentialHeaders` and `assertArgvSafe` reject it, and
   `assertNoCredentialMaterial` re-checks every value that leaves the package.
   Stripping would hide the bug that produced it.
3. **A TTL over the ceiling is refused, not clamped.** 24 hours is the
   documented maximum; a caller that asked for 48 is planning around a lease
   that will not exist, and clamping turns that into a surprise in the middle of
   the night (`TTL_OUT_OF_RANGE`).
4. **Durable state is refused by the type, not by the README.** See below.

The push path is an injected `OciPushExecutor` rather than a shell-out for the
same reason. The default implementation runs `crane push` through a
`ProcessRunner`: every command is an argv array with no shell and no string
interpolation, the binary and every flag come from an allowlist
(`PUSH_TOOL_ALLOWLIST`, `PUSH_FLAG_ALLOWLIST`), and `assertArgvSafe` is the last
check before a spawn — the same shape `@hobo/provider-neon` uses for `pg_dump`.
The child gets an explicit environment, never the ambient one, because an
inherited `DOCKER_CONFIG` is exactly how a credential reaches a registry that
should never see one.

## Refusing to become durable storage

"Please don't put your database backup on a registry that deletes it within a
day" is advice, and advice loses to a deadline. So the refusal is a type.

Every push takes an `ArtifactPayload`, and `ArtifactPayload` has no variant for
application state, no variant for a database backup, no variant for an
event-store journal, and no variant for secret material. There is nothing to
construct, so there is no argument a typed call site can pass. `parseArtifactPayload`
is the only way to obtain one, and the runtime check against
`REFUSED_PAYLOAD_KINDS` exists for input that arrived as `unknown` from a config
file or an HTTP body, where the type system was never consulted — it reports
`ARTIFACT_DURABLE_USE_REFUSED` and names the rule that was broken. An *unknown*
kind is refused too, rather than being treated as reproducible by default.

What is representable is a reproducible artifact — a CI build image, a test
fixture, a cross-machine handoff, a pack candidate image — and each one must say
in `reproducedBy` how it is regenerated. That field is required because the
recovery procedure has to be written down before the artifact exists, not
recalled after it is gone; a placeholder like `n/a` is too short to pass.

The mission allows one narrow exception, and it is deliberately awkward to say.
An `accepted-temporary-handoff` must carry an acknowledgement naming who accepted
the risk, why an ephemeral registry is the right place, **where the durable copy
lives right now**, which owner-controlled registry the artifact will be promoted
into, and a promotion deadline that falls inside the artifact's own TTL. A
deadline past the TTL is refused: that is not a plan, it is a hope, and the
artifact is gone before the promotion is due. The result reads, in review, as a
decision somebody made rather than a boolean somebody flipped.

There is also no API here that suggests ownership. No `claim`, no `adopt`, no
`delete`, no `retain`. `TTL_SH_CLAIM_ACTION_COUNT` is zero because there is no
ceremony to perform, and the absence of those functions is the same statement the
definition makes in data.

## Promotion: the only exit from `none-expire`

`promoteArtifact` copies the artifact into a registry somebody is responsible
for, before expiry. It is a `crane copy` addressed **by digest on the source
side** — promoting the tag would copy whatever currently answers to that name,
which on a registry anyone can push to is not necessarily what was reviewed — and
the copy is verified against the expected digest afterwards.

It is not called `claim` or `adopt`, and it changes nothing about the artifact's
status here: the ephemeral copy keeps expiring on schedule. What changes is that
a second, owned copy exists. Three refusals make that honest:

- the destination cannot be another anonymous expiring registry
  (`parseOwnerControlledRegistry` rejects `ttl.sh` itself), because that is a
  lifetime extension wearing ownership's clothes;
- the source lease must still be live at the caller's clock reading, checked
  before a process is spawned — a copy that starts after expiry moves no bytes
  and reports a tool error rather than the truth (`LEASE_EXPIRED`);
- an artifact pushed under an acknowledgement must be promoted into the registry
  that acknowledgement named, or the acknowledgement was decorative
  (`PROMOTION_TARGET_INVALID`).

`promotionUrgency` answers "how long until this becomes impossible" without
moving bytes, and reports an acknowledged handoff's own deadline — tighter than
the TTL by construction — rather than the raw expiry, because the committed
deadline is what a scheduler should be chasing.

## Parse, don't validate

The repo rule is parse, don't validate, and nothing here re-checks a value it
already accepted. Untrusted input crosses one parser and comes out as a
**parsed domain type** that cannot hold the bad case:

- `parseTtlShImageReference` turns a string into a branded
  `TtlShImageReference` — host equal to `ttl.sh`, an unguessable name, a TTL
  inside the documented range, and a canonical `pullReference` derived from
  those three. It cannot be constructed by hand, so "did anyone check this
  string" stops being a question the rest of the package has to ask, and the
  host allowlist still holds at the process boundary in `buildCranePushArgv`.
- `parseTtlWindow` yields a `TtlShTtlWindow` carrying normalized `minutes`,
  which is the only field expiry arithmetic is allowed to read; the written
  token is kept alongside it purely so a receipt can quote what was asked for.
- `parseArtifactDigest` yields a branded `TtlShDigest`, so a digest and an
  arbitrary string are different types at every call site that pins content.
- `assertAllowedEndpoint` returns the parsed `URL` rather than a boolean, so a
  caller cannot keep using the unchecked string it passed in.
- `parseArtifactPayload` turns an untrusted description into an `ArtifactPayload`
  whose variants are the only things this transport carries. The refused cases are
  absent from the union rather than checked in it, which is the strongest form the
  rule can take: a durable-state push is not a runtime error downstream, it is a
  value nobody can build.
- `parseOwnerControlledRegistry` yields a branded `OwnerControlledRegistry`, so
  "a registry somebody is responsible for" is a type rather than a convention, and
  `parsePromotionTarget` composes it into a `PromotionTarget` whose `ref` is
  derived rather than accepted — component by component, so a `..` cannot enter a
  reference through the one field that allows slashes.

`data-models/provider_ttl_sh.proto` is the design-time wire view of these
shapes, and `data-models/provider_ttl_sh.cue` carries the invariants the parsers
enforce (the `ttl.sh` host allowlist, the UUID / `sha256-<digest>` name forms,
the 1–1440 minute TTL bounds, the `^sha256:[0-9a-f]{64}$` digest pattern,
RFC3339 instants, zero claim actions, and `retain-until-provider-expiry`
cleanup). `#TtlShPayloadDescriptor` carries the reproducible-or-acknowledged
split as a CUE disjunction, `#TtlShOwnerRegistry` excludes `ttl.sh` from any
promotion target, and `#TtlShPromotionRecord` requires a strictly positive
remaining lease — a promotion recorded with none left raced the reaper, and the
copy it claims to have made may not exist. The parsed types above are the
executable view of that pair.
`contracts/provider-ttl-sh-registry.pact.json` pins the registry read boundary:
a manifest read, the 404 that an expired artifact returns, a 429, an
authentication challenge, and a redirect — the last two as contract *changes*
rather than things to work around.

## Event architecture

This package is a strategy leaf: it holds no reducer, no stream, and no store.
It turns one registry interaction into facts the claim plane can make durable,
and the durable machinery lives in `@hobo/claims` and
`packages/hobo/src/claim-plane.ts`.

The flow for one pushed artifact:

1. A **command** from the claim family — `ReserveGuestLease`,
   `RecordProvisionedSubject`, and eventually `ExpireGuestLease` — is what a
   caller issues. `pushArtifact()` is the effectful half those commands invoke
   here. There is deliberately no `ObserveClaimItem` or `VerifyOwnership` in
   that list: with zero claim actions there is nothing to observe or verify.
2. `toProviderFacts(record)` returns this package's observations
   (`provider.ttl-sh.artifact.pushed` / `.adopted`, and
   `provider.ttl-sh.lease.expired` once the computed expiry has passed);
   `toPromotionFacts(receipt, record)` adds
   `provider.ttl-sh.artifact.promoted` when an owned copy is made. That last one
   is one fact and not two: nothing about the ephemeral lease changed, so emitting
   a lease event would tell the read model an artifact stopped expiring when it
   did not — the fact says `sourceStillExpires: true` for exactly that reason.
   They are locator-only facts, not durable events: the claim coordinator **actor**
   (`reduce` in `@hobo/claims`) is what turns them into the **events**
   `GuestLeaseReserved`, `ProviderSubjectProvisioned`, and `GuestLeaseExpired`.
3. `applyClaimCommand` appends the command and those events to the durable
   **event store** on the `claim:<deploymentRef>` stream under an optimistic
   `expectedSeq`, after `assertNoSecrets` has rejected any payload carrying
   credential-shaped material. A ttl.sh payload passes trivially, because the
   only identifiers it carries are a public pull reference and a digest.
4. `rebuildClaimState` folds the stored journal back into a **snapshot**
   (`ClaimPlaneSnapshot`, carrying the store sequence it was folded at), which
   is what the next append fences against.
5. `claimStatusView` is the **projection** over that snapshot — the
   **materialized view** of leases and their deadlines — and it is the **read
   store** `hobo claim status` renders. A ttl.sh lease appears there with an
   expiry, no claim deadline, and no outstanding obligations, which is the
   whole point: the read model shows a thing that ends by itself. An acknowledged
   temporary handoff is the one case that *does* leave an obligation in that view —
   a promotion deadline — and `dischargedAcknowledgement` on the promotion fact is
   what closes it.

`toGuestLease()` is the projection into the durable lease record: `renewable:
false`, no `claimBy`, and `cleanupPolicy: "retain-until-provider-expiry"`,
because there is nothing HoBo can delete. A cleanup "failure" here is the
documented behaviour of the service, not a HoBo bug, and the definition says so
rather than letting the claim plane retry a delete that does not exist.

## Error codes

`TtlShProviderError.code` is one of `PROVIDER_CONTRACT_CHANGED`,
`PROVIDER_RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_OPERATION_AMBIGUOUS`,
`TRANSPORT_NOT_ALLOWED`, `CREDENTIAL_REFUSED`, `INVALID_IMAGE_REFERENCE`,
`GUESSABLE_ARTIFACT_NAME`, `TTL_OUT_OF_RANGE`, `ARTIFACT_PUSH_FAILED`,
`UNSAFE_TOOL_INVOCATION`, `REFERENCE_REUSED`, `LEASE_EXPIRED`,
`ARTIFACT_DURABLE_USE_REFUSED`, `PROMOTION_TARGET_INVALID`. Messages and
detail values are redacted at construction; digests survive redaction, because
`sha256:<64 hex>` is the artifact's identity and is exactly the shape a generic
"long opaque blob" rule would otherwise eat.

`PROVIDER_OPERATION_AMBIGUOUS` is the one worth reading twice. A push that died
on a 5xx or a reset socket may or may not have landed, and calling that
"failed" would let a caller mint a second lease for content that is already
there. It is reported as ambiguous and resolved by re-pushing the same digest —
which, because the ledger is keyed on the digest, adopts rather than duplicates.

## Usage

```ts
import {
  createCranePushExecutor,
  createInMemoryPushLedger,
  parseArtifactDigest,
  parseArtifactPayload,
  parsePromotionTarget,
  promoteArtifact,
  pushArtifact,
  referenceForDigest,
  toProvisionReceipt,
} from "@hobo/provider-ttl-sh";

const digest = parseArtifactDigest(builtImageDigest);
const reference = referenceForDigest(digest, "1h");

// What is being pushed, and how it comes back if the registry eats it.
const payload = parseArtifactPayload(
  {
    kind: "ci-build-image",
    artifactType: "application/vnd.oci.image.config.v1+json",
    reproducedBy: "rebuild from the commit this pipeline recorded",
  },
  reference.ttl,
);

const record = await pushArtifact({
  executor: createCranePushExecutor({ runner }),
  ledger: createInMemoryPushLedger(),
  reference,
  artifact: { path: "/tmp/app.tar", digest, sizeBytes },
  nowMs: clock(),
  definitionId: "ttl-sh.ephemeral-oci-artifact/v1",
  providerId: "ttl-sh",
  resourceRef: "bindle:app/image",
});

const receipt = toProvisionReceipt(record);
// receipt.pullReference → "ttl.sh/sha256-<digest>:1h", public and expiring.

// Later, if the artifact turned out to be worth keeping:
const promotion = await promoteArtifact({
  runner,
  record,
  payload,
  target: parsePromotionTarget({
    registry: "registry.example.com",
    repository: "acme/payments-api",
    tag: "build-42",
  }),
  nowMs: clock(),
});
// promotion.digest is the same digest, now in a registry with an owner.
// The ttl.sh copy still disappears at its TTL.
```

`runner` is yours to supply, and it must spawn without a shell and without
inheriting the ambient environment.

## Tests

`pnpm --filter @hobo/provider-ttl-sh test`. Eight vitest files cover reference
parsing (host, name shape, TTL grammar and ceiling), the transport guard
(scheme, host, port, userinfo, path prefix, forbidden headers, redirects,
challenges, size cap), argv safety, push idempotency and failure mapping, the
definition facts that must stay true (zero claim actions, `none-expire`,
expiry-only cleanup, `public-anonymous` bootstrap, no durability), a
no-credential-leak sweep over receipts, facts, leases, and errors, the payload
gate (every refused kind, unknown kinds, a missing recovery procedure, an
acknowledgement whose deadline outlives its artifact), promotion (digest-addressed
copy, the expiry boundary to the millisecond, a mismatched digest, an
acknowledgement promoted to the wrong registry), and a consumer-driven replay of
every interaction in the pact. No test touches the network, spawns a process, or
reads a clock: the runner is recorded, and the clock is an argument.

`test/payload.test.ts` also carries the type-level half of the durable-use
refusal. The assignments that must never compile are written out in comments
there, so widening `ArtifactPayload` means deleting an explanation rather than
quietly succeeding.
