# @hobo/provider-oci-registry

A generic OCI distribution-spec registry realizer for HoBo.CD. One
resolver, `oci-registry.image/v1`, on the core `ResourceResolver` port, for any
registry that speaks the distribution API: GHCR, Docker Hub, ECR, Artifact
Registry, Harbor and Zot.

The resource is an image (or index) at a repository, identified by digest, plus
the tags HoBo declares for it. HTTP goes only through the host's
`HttpTransport`, guarded per host by `guardTransport`. The package has no SDK
and no external dependency, and runs no shell (decision R2).

## What it provides

| Export | What it is |
|---|---|
| `ociRegistryResolverRegistry(options)` | Resolver registry holding `oci-registry.image/v1`, instrumented with `hobo.cd.resolver.*` metrics when a sink and clock are bound. |
| `createOciRegistryResolvers(options)` | The bare resolver list. |
| `OCI_REGISTRY_TRAFFIC_ROUTING_PROFILE` | Kind `other`, no offerings, no fallbacks. A registry routes no workload traffic. |
| `OCI_REGISTRY_TRAFFIC_ROUTING_ABSENT` | All 17 portable offerings, each declared absent with a reason (ADR-0144). |
| `OCI_REGISTRY_HOSTING_COVERAGE`, `ociRegistryProductRefusal` | The I14 coverage document, and a typed `RESOLVER_PRODUCT_UNSUPPORTED` for the repository and retention products it refuses. |
| `parseManifest`, `parseReferrers`, `parseChallenge` | Parse boundaries for manifests, referrers indexes and `WWW-Authenticate`. |
| `createLatin1FetchTransport`, `ociLatin1Transport`, `declareLatin1Transport`, `isLatin1Transport` | Byte transports for binary layers (see "Transport body encoding"). |

## Desired state

Wire form: `OciImageDesired` in [`data-models/oci_image.proto`](data-models/oci_image.proto),
constrained by [`oci_image.cue`](data-models/oci_image.cue).

| Key | Meaning |
|---|---|
| `registry` | Must equal the host the Camp bound (`options.registry.host`). Desired state cannot redirect the credential. |
| `repository` | Distribution repository name. |
| `digest` | `sha256:<hex>`. The identity. A tag is never accepted in its place. |
| `tags` | Tags HoBo owns for this digest (at most 64). Only these are ever written or deleted. |
| `sourceRegistry`, `sourceRepository` | Where to copy content from. The host must have bound `sourceRegistry` in `options.sourceRegistries`, or it must be the target host itself. |
| `copyReferrers` | Directive, default `true`. |

Anything else is refused by name rather than ignored.

## Convergence

1. HEAD the manifest by digest at the target.
2. If it is absent, copy it. An index's child manifests are copied first. For
   each config and layer blob, in this order:
   - skip it when the target already has it;
   - **cross-repository mount** when the source is on the same host; a mount
     the registry declines (202), or one whose source the credential may not
     read, falls back to an upload;
   - otherwise **upload** the bytes from the host `artifactStore` or the source
     registry, monolithically or in `Content-Range` chunks.

   Bytes are hashed before upload and must match the descriptor, and the
   registry verifies the digest again on the closing PUT. The manifest is then
   PUT by digest with its **exact bytes**.
3. PUT each declared tag with the same bytes. A tag the desired state does not
   name is never written.
4. Copy referrers (attestations, signatures, SBOMs) of the subject from the
   source. It uses the OCI 1.1 referrers API, or the `sha256-<hex>` tag-schema
   index as a fallback. The output reports whether the target's referrers API
   lists them (`referrersDiscoverable`).
5. Observe: HEAD by digest and by every declared tag. `ready` and
   `operationConfirmed` come only from this observation (I5). A write that is
   not observed afterwards is a refusal, not a success.

Mirrors keep digests (D22). Manifests are never re-serialized, converted or
platform-filtered. A source that cannot serve the digest fails convergence,
and nothing is substituted.

Writes are idempotent by digest, because every write is content-addressed or a
tag PUT of the same bytes. When a write's reply is lost, the realizer observes
instead of retrying. If the effect is visible it continues; if not, it refuses,
and the next reconcile is safe to run.

`delete` removes only the declared tags, and only while they still point at
this digest. A tag another writer has re-pointed is no longer HoBo's. The
manifest is deleted by digest only under the host policy
`allowManifestDelete`, because that removes the content for every tag and
referrer that shares it.

## Authentication and credentials (I9)

`resolveCredential(credentialRef)` returns
`{ kind: "basic", username, password }`, `{ kind: "bearer", token }` or
`{ kind: "anonymous" }` at call time. The material lives only in the
`authorization` header of a guarded request. It is never in an outcome, a
diagnostic or an error. Source registries name their own pull credential by
locator (`sourceRegistries[].credentialRef`); without one they are pulled
anonymously.

- **`WWW-Authenticate: Bearer`**: the credential is exchanged at the realm for
  a scoped token, and the request is retried once. Both `token` and
  `access_token` response shapes are accepted. The realm is chosen by the peer,
  so it must match one of the endpoint's `authRealms` exactly; any other realm
  is refused before the credential leaves the process.
- **`Basic`** (ECR, some Harbor and Zot): the request is retried once with the
  basic credential.
- **Pre-minted bearer**: sent directly. A 401 is a refusal.

## Transport body encoding

`HttpTransport` bodies are strings. The stock `createBoundedFetchTransport`
decodes UTF-8 fatally, so binary layers cannot pass through it. The realizer
is explicit about that limit and never assumes past it:

- `transportBodyEncoding: "utf-8"` (default): JSON configs, manifests and most
  attestations move. A binary layer is refused with a remediation: mount it
  from the same registry, supply the `artifactStore`, or run a byte transport.
- `transportBodyEncoding: "latin1"`: a host transport that maps each byte to
  one code unit (0–255). Any blob moves, including chunked uploads.

Either way, a blob is hashed before upload, so a lossy transport cannot push
altered bytes. Manifests move as bytes too: under `latin1` the manifest is
sent and read as its exact UTF-8 bytes (a non-ASCII annotation keeps its
digest), never as decoded text.

A host whose transport is the stock UTF-8 one gets a byte transport from
`ociLatin1Transport(host)`: a transport already declared latin1
(`declareLatin1Transport`, a `Symbol.for` marker that survives package
copies) is used as is; otherwise ASCII requests (manifests, JSON, empty
bodies) still go through the host, with its response re-expressed as latin1,
and only a request whose body the host would re-encode (a binary layer)
goes through `createLatin1FetchTransport` over `fetch`, bounded like the
stock transport (no redirect following, a total deadline, a streamed response
cap). The resolver's per-host guard wraps both. The `@hobo/hobo` catalog
binds its OCI Camps this way, so HoBo's release pushes its images from the
CD artifact store with no `docker push`.

Blob GETs that a registry redirects to object storage are followed once, only
to a host in the endpoint's `blobRedirectHosts`, and never with the registry
credential.

## Tests

`pnpm --filter @hobo/provider-oci-registry test` runs fully offline. The
fixture world is [`test/support/fake-registry.ts`](test/support/fake-registry.ts),
and every request the realizer emits is declared by the distribution pact
[`contracts/provider-oci-registry-distribution.pact.json`](contracts/provider-oci-registry-distribution.pact.json).

The suites cover:

- the shared resolver conformance kit;
- CUE vetting with the pinned `cue` v0.14.0;
- the I14 coverage document and the traffic profile.

The live lane observes a real registry image by digest. It runs only when
`HOBO_OCI_LIVE_HOST`, `_REPOSITORY`, `_DIGEST`, `_REALM`, `_USERNAME` and
`_PASSWORD` are set. Otherwise it is reported as skipped, with the variables
named in the test title.

## Architecture evidence

The package follows parse, don't validate. Every untrusted input becomes a
parsed derived type, or a typed `ResolverError`, at its boundary:

- desired state, through `parseResolveRequest` and then the realizer's own
  `parseTarget`;
- manifests and referrers indexes, through `parseManifest` and `parseReferrers`;
- `WWW-Authenticate`, through `parseChallenge`;
- resolved credential material, through `checkCredential`.

Nothing downstream re-checks a raw string.

The realizer keeps no state and emits no events itself. It is called inside
the `@hobo/cd` reconciler's command → event pipeline. There, the per-Camp
reconciler actor appends realization facts to the event store, and projections
and materialized views (with snapshots feeding read stores) expose the
observed tag→digest state that this resolver's `read` reports.

## Runbook

| Symptom | Meaning | Action |
|---|---|---|
| `RESOLVER_PROVIDER_REJECTED` "token realm … is not allowlisted" | The registry's challenge named a realm the endpoint does not list. | Confirm the realm belongs to the registry operator (for example `https://auth.docker.io/token` for Docker Hub, `https://ghcr.io/token` for GHCR), then add it to `authRealms`. |
| "binary layers do not survive a UTF-8 text transport" / "is binary and the host transport carries UTF-8 text" | A layer had to be byte-copied through the stock text transport. | Mount from the same registry (`sourceRegistry` = target host), bind an `artifactStore`, or run with a latin1 byte transport and `transportBodyEncoding: "latin1"`. |
| "not an allowlisted blob host" | The source redirected a blob to storage the endpoint does not list. | Add the storage host (for example `pkg-containers.githubusercontent.com`, or the S3 or Cloud Storage host) to `blobRedirectHosts`. |
| "a mirror never substitutes content" | The source does not hold the digest. | Publish the digest to the source, or correct `sourceRepository`. Never retag a different digest. |
| "… is not observed at … after the write" | A tag write was overtaken by another writer, or a lost write did not land. | Re-run reconcile. If it recurs, find the other writer of the declared tag. HoBo owns only declared tags. |
| `referrersDiscoverable: false` | The target lacks the OCI 1.1 referrers API. The referrers are stored by digest but not listed. | Upgrade the registry, or have verifiers fetch referrers by digest. HoBo does not maintain the `sha256-<hex>` fallback tag at the target. |
| "does not delete tags through the distribution API" | The registry (for example Docker Hub) refuses `DELETE /manifests/<tag>`. | Remove the tag with the registry's own retention tooling, or keep it and drop it from the declared state. |
| `RESOLVER_CREDENTIAL_MISSING` | The locator resolved to no usable basic, bearer or anonymous credential. | Re-issue the robot account or token in the Yard broker. |
| `RESOLVER_PRODUCT_UNSUPPORTED` for `oci-registry.repository/v1` | Repository creation is not part of the distribution spec. | Create the repository with the registry's provider package (ECR, Artifact Registry), or let first push create it (GHCR, Harbor, Zot). |

## Limits (honest scope)

- Only `sha256` digests. Schema-1 images and the deprecated OCI artifact
  manifest are refused.
- Referrers are copied one level deep (the subject's referrers). Referrers of
  referrers are not.
- A tag check-then-delete is not atomic. The distribution API has no
  conditional delete.
- Blobs above `maxBlobBytes` (default 64 MiB) are moved only by mount.
