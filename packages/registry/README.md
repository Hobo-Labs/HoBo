# @hobo/registry

The Registry catalog service. The catalog engine —
provider registration/approval facts, the event-backed planner registry fold,
and the `registry-catalog` projection — already lives in `@hobo/cloud`
(`packages/cloud/src/registry/catalog.ts`); this package re-exposes that
surface unduplicated and adds the missing thirds:

- **Manifest ingest** — `ingestBundleManifest(raw)` parses an untrusted,
  schema-versioned bundle manifest into a typed record and produces the
  `registry.BundleImported` fact body; malformed documents reject with typed
  errors, never a partial import.
- **Signature/provenance verification** — `verifyBundleProvenance` reuses the
  `@hobo/identity` issuer/verify surface (`JwtSvidIssuer` mints the
  attestation, `verifyJwtWithJwks` checks it) plus SLSA-shaped in-toto
  provenance statements (subject digest + predicate). Verification is
  credential/key-gated and fail-closed: an unverifiable signature or
  provenance NEVER passes, and a missing verifier is an explicit
  `"unverified"` status — never a silent pass.
- **Search/index** — `toIndexEntry` + `searchBundles`: a small pure in-memory
  index over ingested bundles (by name, capability, provider) with
  deterministic ranking and codepoint tie-breaks.

**Honest scope note:** the mutating admin surface of `hobo registry add`
lives in the CLI (`packages/hobo/src/registry-add.ts`), where it registers a
provider described by a `@hobo/provider-manifest` data file; bundle import
through this package's engine is not wired to it yet. It appends nothing itself — callers own
the event-store write.

Wire forms of the bundle manifest, `BundleImported` fact, provenance
statement, and index entry are pinned in
[`data-models/registry.proto`](./data-models/registry.proto) (+ CUE bounds);
the manifest/provenance fetch boundary is fixtured in
[`contracts/pacts/registry-boundary.pact.json`](./contracts/pacts/registry-boundary.pact.json).

## Architecture evidence

Untrusted manifests and provenance documents become parsed derived types at
the boundary — `ingestBundleManifest` and `parseProvenanceStatement` follow
parse, don't validate — unknown schemas, malformed capabilities, and
builder-less predicates fail closed with typed errors. The command → event
pipeline is shared with `@hobo/cloud`: the `hobo registry` commands produce
`provider.Registered` / `provider.Approved` / `registry.BundleImported`
facts, the caller's actors append them to the event store, and the
re-exported `registryCatalogProjection` materialized view / projection (with
snapshots feeding read stores, rebuildable from zero) exposes catalog
history; the search index here is a pure in-memory read model over parsed
manifests, not a second source of truth.
