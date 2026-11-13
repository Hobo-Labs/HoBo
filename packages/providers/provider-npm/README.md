# @hobo/provider-npm

The npm realizer for HoBo.CD (plan 0024):
it realizes one **published package version** on an npm-compatible registry —
`registry.npmjs.org`, GitHub Packages (`npm.pkg.github.com`) or a Verdaccio
origin — from a Freight tarball, through the existing `ResourceResolver` port
of `@hobo/core`. No provider port methods are added, no SDK is used and no
shell resolver runs (decision R2): every call is an HTTPS request through the
host's `HttpTransport`, wrapped in `guardTransport` pinned to the bound
registry.

| Export | What it does |
|---|---|
| `npmResolverRegistry(options)` / `createNpmResolvers(options)` | The resolver registry with the one product `npm.package-version/v1`. |
| `NPM_TRAFFIC_ROUTING_PROFILE`, `NPM_TRAFFIC_ROUTING_ABSENT` | Kind `other`, no offering, no fallback; every TrafficRouting offering declared absent with its reason. |
| `NpmVersionConflictError`, `NPM_CONFLICT_REASONS` | The typed immutable-version conflict (`RESOLVER_PROVIDER_REJECTED` plus a closed `reason`). |
| `NpmOtpRequiredError`, `NPM_OTP_REMEDIATION` | The typed 2FA refusal (`RESOLVER_CREDENTIAL_MISSING`) for a `401` with `www-authenticate: OTP`. |
| `npmProductRefusal(productId)` | The typed `RESOLVER_PRODUCT_UNSUPPORTED` refusal for any other product, including `npm.package-unpublish/v1` (refused by policy). |
| `parseNpmRegistryBinding`, `parseNpmTarball`, `parseProvenanceBundle`, `compareIntegrity` | The parse boundaries, exported for hosts and tests. |

## Binding

The host binds everything a plan must not choose:

```ts
npmResolverRegistry({
	registry: { kind: "npmjs" }, // | { kind: "github-packages" } | { kind: "verdaccio", origin: "https://npm.internal:4873" }
	auth: "token",               // | "oidc-trusted-publishing" (npmjs only)
	resolveCredential,           // the CredentialResolver: credentialRef -> token or CI OIDC ID token
	artifacts,                   // the artifact store (structurally ArtifactStore.get from @hobo/cd)
});
```

Desired state (`ResolveRequest.desired`, `NpmPackageVersionDesired` in
`data-models/`):

| Key | Meaning |
|---|---|
| `registry` | Must equal the bound registry origin, else refused. |
| `packageName`, `version` | Must equal the `package.json` inside the tarball. SemVer without build metadata. |
| `distTag` | Required, explicit. Moving it is the promotion lever. |
| `artifactDigest` | `sha256:` digest of the Freight tarball in the artifact store. |
| `artifactCoordinate` | Optional `store://<backend>/<digest>`; must name the same digest. |
| `provenanceDigest` | Optional digest of the Sigstore bundle blob (npmjs only). |
| `access` | Directive: `public` / `restricted` at first publish. |
| `deprecationMessage` | Directive: the message `delete` deprecates with. |

## Behavior

- **Converge (`reconcile`).** Read the tarball from the artifact store by
  digest and re-hash it; read `package.json` out of the tarball; observe the
  packument (`GET /<name>`). Then:
  - version absent → `PUT /<name>` with the npm publish document: the tarball
    as a base64 attachment, `dist.integrity` (sha512) and `dist.shasum`, the
    dist-tag set explicitly, and the provenance bundle as
    `<name>-<version>.sigstore` when the Freight carries one;
  - version present and `dist.integrity` matches the Freight bytes →
    converged on the bytes (`adopt`, or `noop` when the ref is pinned); a
    dist-tag that points elsewhere is moved with
    `PUT /-/package/<name>/dist-tags/<tag>` (`update`);
  - version present with other bytes, or published and later unpublished
    (a `time.<version>` entry, or listed in `time.unpublished.versions` when
    the whole package was unpublished) → `NpmVersionConflictError`. Versions
    are immutable; nothing is ever overwritten.
- **Observation decides (I5).** Every mutation is followed by an uncached
  `GET /<name>?write=true`, and `create`/`update` are reported only from it.
  npmjs serves plain packument GETs from its CDN (`cache-control: public,
  max-age=300`, `cf-cache-status: HIT`), so a plain read can miss a publish
  for up to five minutes; `?write=true` reaches the origin
  (`cf-cache-status: DYNAMIC`). The first observation of a pass is still a
  plain GET, so a pass that starts inside the CDN window may republish; the
  registry answers `403` "cannot publish over" and the uncached read adopts. A lost reply, a timeout, a
  5xx or a 403/409 is an ambiguous outcome resolved by that observation: if
  the registry shows our bytes, it converged; if not, the reconcile is refused
  as "not observable" and the next pass republishes or adopts.
- **Observe (`read`).** `GET /<name>`; compare `dist.integrity` (sha256/384/512
  SRI) and `dist.shasum` with the Freight bytes and the dist-tag with the
  version. `undefined` when the version was never published.
- **Delete = deprecate.** `GET /<name>?write=true`, then `PUT /<name>` with the
  packument whose version carries `deprecated`, then observe it. Absent is
  already retired. A version with other bytes is never deprecated. Unpublish
  is refused by policy: it breaks every lockfile that pinned the version and
  the version can never be reused.
- **Promotion.** Promoting Freight from `candidate` to `stable` is a reconcile
  with `distTag: "stable"`: one dist-tag move, never a rebuild or republish (I1).
- **Provenance.** The bundle is bound to the tarball before upload: its DSSE
  in-toto statement must name `pkg:npm/<name>@<version>` with this tarball's
  sha512, else the reconcile is refused locally instead of by the registry.
  Signatures are verified at ingest (`@hobo/cd/provenance`) and by the
  registry. Only npmjs accepts provenance; elsewhere it is
  `RESOLVER_PRODUCT_UNSUPPORTED`.
- **Credentials (I9).** `credentialRef` resolves through the host. In
  `oidc-trusted-publishing` mode it yields the CI's OIDC ID token, exchanged at
  `POST /-/npm/v1/oidc/token/exchange/package/<name>` for a short-lived
  publish token (unscoped names only; see below). No token reaches an
  outcome, an error, a record or a log; registry error bodies are never
  quoted.
- **Auth failures.** `www-authenticate` is parsed as npm-registry-fetch does.
  `401` with `Basic, Bearer` (npmjs's challenge for a bad or under-privileged
  token) is `RESOLVER_CREDENTIAL_MISSING` "re-issue the credential". `401`
  with `OTP` (or a body asking for a "one-time pass") is
  `NpmOtpRequiredError`: the account enforces 2FA on writes, so re-issuing
  the same kind of token cannot help; bind an automation token, a granular
  token with bypass-2FA, or use OIDC trusted publishing.

### Scoped names (impedance limit)

HoBo sends scoped names unescaped (`/@scope/name`) because the core transport
guard refuses `%2f` in paths; npm's own client (`npm-registry-fetch`,
`libnpmpublish`) sends `@scope%2fname`. Evidence, probed against
`registry.npmjs.org` on 2026-11-12 with unauthenticated or invalid-token
requests (recorded in the pact metadata):

| Route | Unescaped | Escaped | Verdict |
|---|---|---|---|
| `GET /<name>` (packument, also `?write=true`) | 200 | 200, same document | routes |
| `GET /-/package/<name>/dist-tags` | 200 | 200, same body | routes |
| `PUT /-/package/<name>/dist-tags/<tag>` | 401 `Basic, Bearer` | 401 `Basic, Bearer` | same auth check; success not captured |
| `PUT /<name>` (publish, deprecate) | 401 `Basic, Bearer` | 404 for a new package | reaches an authenticated handler; success not captured |
| `POST /-/npm/v1/oidc/token/exchange/package/<name>` | 404 `ResourceNotFound` | handler answers | **does not route** |

So OIDC trusted publishing of a scoped name is refused up front
(`RESOLVER_PRODUCT_UNSUPPORTED`): use token auth for scoped packages until the
guard can carry an escaped scope separator. A successful unescaped publish or
dist-tag move has not been captured; the opt-in live write lane
(`HOBO_NPM_LIVE_PROMOTE_TAG`) moves one real dist-tag on a scoped package to
close that gap. Verdaccio rewrites `/@scope/name` to the escaped form itself;
GitHub Packages is unprobed.

## Architecture notes

- **Parse, don't validate.** The registry binding, the request, the tarball
  and the provenance bundle each cross one parse boundary and come out as a
  derived type (`NpmRegistryTarget`, the internal target, `NpmTarball`,
  `NpmProvenanceAttachment`); nothing downstream re-checks a raw value.
- **Command/event placement.** This package is a pure resolver: it issues no
  commands, appends no events and owns no actor, event store, projection,
  materialized view, snapshot or read store. The CD reconciler (the per-Camp
  actor in `@hobo/cd`) owns the command (converge Set), appends the resulting
  events to its durable event store and folds them into its status read store;
  the registry itself is the only state this package reads, so recovery needs
  no snapshot.
- **Contracts and data models.** `contracts/provider-npm-registry.pact.json`
  (consumer `HoBoCdReconciler`, provider `NpmCompatibleRegistry`) is verified
  by `test/contract.test.ts` in both directions; `data-models/provider_npm.proto`
  and `provider_npm.cue` are vetted against real reconcile records by
  `test/surface.test.ts`.

## Tests

`pnpm --filter @hobo/provider-npm test` runs offline against a recorded npm
registry world (`test/support/world.ts`) and real `npm pack` fixtures
(`test/fixtures/*.tgz`). The CUE lane needs the pinned `cue` binary
(`.tools/cue/v0.14.0` or `HOBO_CUE_BIN`) and skips visibly without it. The
live lane is read-only and skips visibly unless `HOBO_NPM_LIVE_REGISTRY`,
`HOBO_NPM_LIVE_TOKEN`, `HOBO_NPM_LIVE_PACKAGE`, `HOBO_NPM_LIVE_VERSION`,
`HOBO_NPM_LIVE_DIST_TAG` and `HOBO_NPM_LIVE_TARBALL` are set. Adding
`HOBO_NPM_LIVE_PROMOTE_TAG=<scratch tag>` (scoped package) opts into one real
dist-tag move through the unescaped route.

## Runbook

| Symptom | Meaning | Action |
|---|---|---|
| `NpmVersionConflictError` `npm-version-integrity-mismatch` | The registry already holds different bytes under this version. | Do not retry. Bump the version, build new Freight and promote it. Investigate how the other bytes got published. |
| `NpmVersionConflictError` `npm-version-previously-unpublished` | The version was unpublished; npm never accepts it again. | Publish under a new version. |
| `RESOLVER_PROVIDER_REJECTED` "is not observable on the registry (the reply was lost)" | A publish or dist-tag move had an ambiguous outcome and the registry does not show it yet. | Reconcile again: the next pass adopts the version if it landed, or publishes it if it did not. npmjs reads can lag a publish by seconds. |
| `RESOLVER_PROVIDER_REJECTED` "is not observable … HTTP 403" | The registry refused the publish and does not hold our bytes. | Check the credential's publish rights and the package's scope/owner; for GitHub Packages the scope must be the owning org or user. |
| `RESOLVER_CREDENTIAL_MISSING` | The credentialRef resolved to nothing usable, or the registry answered 401/403 to a read. | Re-issue the token behind the credentialRef in the credential resolver. |
| `NpmOtpRequiredError` "demands a one-time password (2FA)" | The token's account enforces 2FA on writes (`www-authenticate: OTP`). | Bind an npm automation token or a granular access token with bypass-2FA; on npmjs prefer OIDC trusted publishing. Re-issuing the same token kind does not help. |
| `RESOLVER_PRODUCT_UNSUPPORTED` "trusted publishing of the scoped package" | npmjs routes the OIDC exchange only for the `%2f`-escaped name, which the transport guard refuses. | Use token auth for scoped packages. |
| "npm OIDC token exchange returned HTTP 4xx" | npm has no trusted publisher matching this CI identity, or the package does not exist yet. | Configure a trusted publisher for the package on npmjs.com (repository, workflow, environment). Publish the first version with a token. |
| "is not in the artifact store" / "do not hash to the Freight digest" | The tarball or bundle blob is missing or corrupt. | Re-put the build output into the artifact store and re-record the Freight; nothing was published. |
| "does not attest … with this tarball's sha512" | The provenance bundle belongs to other bytes. | Attach the bundle generated for this exact tarball. |
| `RESOLVER_PRODUCT_UNSUPPORTED` for provenance, OIDC or an unscoped name | The bound registry lacks that capability. | Drop `provenanceDigest`, use token auth, or scope the package, per the registry table in `src/registry.ts`. |
| Rollout refused for traffic routing on an npm Camp | The npm profile declares no TrafficRouting offering. | Express staged release as dist-tag channels (`candidate` → `stable`) in the pipeline instead. |
