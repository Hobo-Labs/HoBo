# Subscription drivers

One `SubscriptionDriver` per `SubscriptionKind`, built by
`createSubscriptionDrivers({ http, credentials, readCiEvents?, readCiArtifact?, readRailEvents? })`.
Every driver reads over the composed `HttpTransport` (or the frozen event
readers), returns at most `discoveryLimit` artifacts strictly above its
cursor's high-water mark, oldest first, and maps every upstream failure to a
typed reason (`source-rate-limited` carries `retry-after-ms:<n>`). No SDK, no
CLI, no host API.

| Kind | Module | Reads | Digest |
| --- | --- | --- | --- |
| `OCI_REPOSITORY` | `oci.ts` | Distribution API: `tags/list` (Link pagination), `HEAD manifests/<tag>`, `GET manifests/<digest>` (revision/created annotations), `referrers/<digest>` with the `sha256-<hex>` tag fallback, blobs; `WWW-Authenticate` bearer flow | Manifest digest (`Docker-Content-Digest`, verified against the body) |
| `GIT_REPOSITORY` | `git.ts`, `git-pack.ts` | Smart HTTP protocol v2: capability advert, `ls-refs` (branch or `refs/tags/`, peeled), `fetch` with `deepen 1` and `filter tree:0` / `blob:none`; packfile parsed here (OFS/REF deltas, sha1/sha256) | `hobo.cd.git-tree/v1` (root tree) or `hobo.cd.git-paths/v1` (files kept by include/exclude paths) |
| `PACKAGE_REGISTRY` | `packages.ts` | npm packument, PyPI JSON, Maven `maven-metadata.xml`, NuGet flat container, crates.io sparse index, RubyGems versions | Registry sha256 where published, else sha256 of the package bytes (npm after its sha512 integrity) |
| `HTTP_INDEX` | `http-index.ts` | JSON list or `{items}` of `{version, url, digest}` | The entry's sha256 digest (https URLs without credentials only) |
| `HOBO_CI` | `hobo-ci.ts` | `ci.PipelineResultObserved` via `CiEventReader`, structural (no `@hobo/ci` import) | sha256 of the output read back through `CiArtifactReader`, which must equal the CI's recorded sha256 |
| `HOBO_RAIL` | `hobo-rail.ts` | `RailEventReader` approvals | The Rail digest (D24) |

The OCI driver also implements `attestations` (`AttestingDriver` in
`../types.ts`): the only kind that can satisfy `requireProvenance`.

Binary bodies (packfiles, blobs, packages) are read as latin1 from the
transport (one char per byte); a transport that returns wider characters is
refused with `source-transport-not-binary-safe`.

The Git fixtures in `test/sources/fixtures/git.json` are recorded from a real
`git upload-pack` by `test/sources/fixtures/generate-git.ts`.

## Runbook

- **Adding a registry host**: nothing to configure in CD; allow the host in the
  transport guard the composition uses, and set `credentialRef` for private
  registries.
- **A driver keeps refusing with `source-upstream-invalid`**: the upstream
  answered a document the driver does not recognize (wrong locator, a proxy
  login page, a tampered blob). Fix the locator; investigate tampering when the
  message says a blob or CI output does not hash to its digest.
- **NEWEST_BUILD on OCI is slow**: it reads up to 100 manifests per poll for
  their `created` annotation. Prefer SemVer tags.
