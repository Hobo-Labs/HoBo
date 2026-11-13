# @hobo/provider-github

The GitHub Pages realizer for HoBo.CD (plan 0024):
it realizes the **Pages site of one repository** from a static-site tree
Freight, through the existing `ResourceResolver` port of `@hobo/core`. No
provider port methods are added, no SDK is used, no git binary runs and no
shell resolver runs (decision R2): every call is an HTTPS request to the
GitHub REST API through the host's `HttpTransport`, wrapped in
`guardTransport` pinned to the bound API host and its `/repos/` subtree.

| Export | What it does |
|---|---|
| `githubResolverRegistry(options)` / `createGithubPagesResolvers(options)` | The resolver registry with the one product `github.pages-site/v1`. |
| `GITHUB_PAGES_TRAFFIC_ROUTING_PROFILE`, `GITHUB_PAGES_TRAFFIC_ROUTING_ABSENT` | Kind `other`, no offering, no fallback; every TrafficRouting offering declared absent with its reason. |
| `GithubPagesRefusal`, `GITHUB_PAGES_REFUSAL_REASONS` | The typed refusal: a core `ResolverError` plus a closed `reason`. |
| `githubProductRefusal(productId)` | The typed `RESOLVER_PRODUCT_UNSUPPORTED` refusal for any other product. |
| `parseStaticSiteTree`, `loadSiteContent`, `gitBlobSha`, `gitTreeSha`, `parseGithubApiBinding` | The parse boundaries and the local git object-id computation, exported for hosts and tests. |

## Binding

The host binds everything a plan must not choose:

```ts
githubResolverRegistry({
	api: { kind: "github.com" },        // | { kind: "ghes", origin: "https://ghe.example.com" }
	resolveCredential,                  // the CredentialResolver: credentialRef -> GitHub token
	artifacts,                          // the artifact store (structurally ArtifactStore.get from @hobo/cd)
	resolveDeploymentOidcToken,         // optional; pages-deployment mode only (the workflow's OIDC token)
});
```

## The Freight

A Pages Freight is a **tree index** blob (the Freight's `artifactDigest`) plus
one blob per file, all in the artifact store and addressed by sha256:

```json
{ "contract": "hobo.static-site-tree/v1",
  "files": [ { "path": "index.html", "digest": "sha256:…", "size": 512, "executable": false } ] }
```

A pages-deployment Freight's index also carries `"pagesArtifactDigest":
"sha256:…"`, the digest of the Actions Pages artifact the build workflow
uploaded from the same tree. That binds the artifact GitHub would serve to the
Freight digest: the realizer cannot download the artifact through the REST API
(its zip redirects off the API host the transport guard pins), so the build
records the binding and the realizer checks it.

Paths are relative and `/`-separated; an empty, `.`, `..`, `.git` or
control-character segment, a duplicate and a path that is both a file and a
directory are refused. At most 20 000 files, 100 MB per file (the Git Data API
blob limit) and 1 GB in total (the Pages site limit). From the file bytes the
realizer computes the git blob ids and the git tree id **locally**, exactly as
`git write-tree` would — that tree id is the desired state, known before
anything is uploaded. Files are read one at a time and no bytes are kept: the
computed ids are cached per Freight digest (32 digests per resolver), so
steady-state passes and `read()` read nothing from the artifact store, and a
publish re-reads (and re-checks) only the blobs it uploads.

Desired state (`ResolveRequest.desired`, `GithubPagesSiteDesired` in
`data-models/`):

| Key | Meaning |
|---|---|
| `owner`, `repo` | The repository; the physical id is `owner/repo`. |
| `publishMode` | `branch` or `pages-deployment` — declared, never inferred. |
| `artifactDigest` | `sha256:` digest of the tree index. |
| `artifactCoordinate` | Optional `store://<backend>/<digest>`; must name the same digest. |
| `branch`, `path` | Branch mode: the publishing branch and `/` or `/docs`. |
| `actionsArtifactId`, `actionsArtifactDigest` | Pages-deployment mode: the Pages artifact the workflow uploaded. |
| `commitMessage` | Directive: the branch-publish commit message. |
| `onDelete` | Directive: `unpublish` (default) or `retain`. |

## Behavior

- **Observe.** `GET /repos/{o}/{r}` (visibility and `permissions.push`),
  `GET /pages` (enabled, `build_type`, `source`), and per mode:
  - branch: `GET git/ref/heads/{branch}` → `GET git/commits/{sha}` (and
    `GET git/trees/{root}` for `/docs`) for the **published tree id**, and
    `GET pages/builds/latest` for the build of the head commit;
  - pages-deployment: `GET actions/artifacts/{id}` (exists, not expired,
    digest matches and is the one the tree index binds),
    `GET pages/deployments/{tree}` — GitHub accepts the build version as the
    deployment id — for the deployment of the Freight's tree, and
    `GET deployments?environment=github-pages` with
    `GET deployments/{id}/statuses?per_page=1` for what is **live**: the
    newest environment deployment whose latest status is `success`. Nothing
    is read from the caller's recorded outputs.
- **Converge, branch mode (compare-and-swap).** If the published tree id
  differs from the Freight's: list the published tree recursively and upload
  only the blobs it lacks (`POST git/blobs`, base64; each returned id must be
  the locally computed one), create the site tree (`POST git/trees` from flat
  paths; its id must equal the local tree id), graft it under `docs/` with
  `base_tree` when publishing from `/docs`, create a commit whose only parent
  is the observed head (`POST git/commits`), and move the ref with
  `PATCH git/refs/heads/{branch}` `force: false` — or `POST git/refs` when the
  branch is absent. GitHub has no update-if-old-sha: `force: false` refuses
  only non-fast-forwards, and a writer that **rewinds** the branch to an
  ancestor of the observed head would let the new commit fast-forward and
  silently restore what the rewind dropped. So the head is re-read
  immediately before the `PATCH` and the pass refuses if it moved; a `422`
  "not a fast forward" is refused the same way. The residual window is that
  re-read to the `PATCH`, which GitHub offers no way to close. A pass that
  pushed nothing and finds no build of the head asks for one
  (`POST pages/builds`).
- **Converge, pages-deployment mode.** The REST API has **no artifact
  upload** — that is the Actions runtime service, reachable only inside a
  workflow run, with binary bodies the string-bodied `HttpTransport` cannot
  carry. So the build workflow uploads the artifact
  (`actions/upload-pages-artifact`) and records its id and digest on the
  Freight; the realizer verifies it and calls `POST pages/deployments` with
  the local tree id as `pages_build_version` and the workflow's OIDC token —
  only when GitHub shows no deployment of that tree, a retryable failure
  (`deployment_failed`, `_cancelled`, `_attempt_error`, `_lost`), or a
  `succeed` deployment that another deployment has since replaced as live. A
  deployment of the tree still in flight is observed, not repeated, whether or
  not the caller kept the last outcome. A status GitHub does not show is
  reported `null`, never assumed.
- **Converged only when observed (I5).** `ready` is true only when the
  published tree id equals the Freight's **and** the latest Pages build is
  `built` for that head commit (branch), or the live github-pages deployment
  carries the Freight's tree id as its build version and the Pages deployment
  of that tree is `succeed` (pages-deployment; `pagesLiveBuildVersion` reports
  what is live, so a later foreign deployment reads as not converged and the
  next reconcile redeploys). Until then outcomes carry
  `lifecycleStatus: "building"` (content confirmed) or `"pending"`.
- **Ambiguous outcomes.** A lost reply, a timeout or a 5xx is resolved by
  observing: a lost blob reply by `GET git/blobs/{sha}`; a lost ref update by
  re-reading the branch — if it shows the Freight tree it converged, if the
  head moved it is a non-fast-forward, otherwise the pass is refused as
  "not observable" and the next pass republishes or adopts.
- **Idempotent by digest.** A branch that already holds the Freight tree is
  adopted (`adopt`, or `noop` when the ref is pinned) with zero writes; an
  update uploads only new blobs.
- **Delete.** `unpublish`: `DELETE /pages`, confirmed by `GET /pages` → 404;
  the branch and its history are kept. `retain`: no call, the site stays up.
- **Credentials (I9).** `credentialRef` resolves through the host. No token
  reaches an outcome, an error, a record or a log; GitHub error bodies are
  never quoted. The token needs `contents: write` (branch mode) and
  `pages: write` (builds, deployments, unpublish).
- **Traffic.** Kind `other`, no offering, no fallback: a Pages site serves one
  tree per repository and publishing replaces it atomically.

Honest limits: the branch compare-and-swap has the re-read-to-`PATCH` window
above; the live deployment is found among the newest 30 github-pages
environment deployments, and its `sha` is assumed to be the
`pages_build_version` it was created with (as GitHub documents for Pages
deployment ids) — neither is provider-verified, since the pact is recorded
from the offline world; the realizer never reconfigures the Pages source (a
mismatch is a refusal, not a repair).

## Architecture notes

- **Parse, don't validate.** The API binding, the request, the tree index and
  the file blobs each cross one parse boundary and come out as a derived type
  (`GithubApiTarget`, the internal target, `StaticSiteTree`, `SiteContent`);
  nothing downstream re-checks a raw value.
- **Command/event placement.** This package is a pure resolver: it issues no
  commands, appends no events and owns no actor, event store, projection,
  materialized view, snapshot or read store. The CD reconciler (the per-Camp
  actor in `@hobo/cd`) owns the command (converge Set), appends the resulting
  events to its durable event store and folds them into its status read
  store; GitHub is the only state this package reads, so recovery needs no
  snapshot.
- **Contracts and data models.** `contracts/provider-github-pages.pact.json`
  (consumer `HoBoCdReconciler`, provider `GitHubRestApi`) is verified by
  `test/contract.test.ts` in both directions and against the offline world's
  responses — status, GitHub's response headers and error bodies. It records
  every refusal the realizer types (401 bad credentials, 404 invisible
  repository, primary and secondary rate-limit 403s, a 403 without
  `contents: write`, 404 Pages disabled, 422 non-fast-forward), and each is
  replayed from the pact into the resolver to prove its typed reason; `data-models/provider_github.proto` and `provider_github.cue` are
  vetted against real reconcile records by `test/surface.test.ts`.

## Tests

`pnpm --filter @hobo/provider-github test` runs offline against a recorded
GitHub world (`test/support/world.ts`) that builds real git object ids
independently of `src/`; the git ids are also pinned to known answers recorded
from `git hash-object`/`git write-tree`. The CUE lane needs the pinned `cue`
binary (`.tools/cue/v0.14.0` or `HOBO_CUE_BIN`) and skips visibly without it.
The live lane is read-only and skips visibly unless
`HOBO_GITHUB_PAGES_LIVE_OWNER`, `HOBO_GITHUB_PAGES_LIVE_REPO`,
`HOBO_GITHUB_PAGES_LIVE_BRANCH` and `HOBO_GITHUB_PAGES_LIVE_TOKEN` are set.
`HOBO_PACT_RECORD=1` rewrites the pact from the recorded lifecycle.

## Runbook

| Symptom | Meaning | Action |
|---|---|---|
| `github-pages-disabled` | `GET /pages` is 404: Pages is off for the repository. | Enable Pages in the repository settings with the source the resource declares, then reconcile. |
| `github-pages-source-mismatch` | Pages publishes from another branch/path, or from Actions while the mode is `branch` (or the reverse). | Change the Pages source to match, or change `publishMode`/`branch`/`path`. The realizer never repoints Pages. |
| `github-permission-missing` | The repository is invisible to the token (404), `permissions.push` is false, or GitHub answered 403 (including branch protection; `x-accepted-github-permissions` names what it wanted). | Grant the token `contents: write` and `pages: write` on the repository; allow it past branch protection on the Pages branch. |
| `github-credential-rejected` (`RESOLVER_CREDENTIAL_MISSING`) | GitHub answered 401. | Re-issue the token behind the credentialRef. |
| `github-rate-limited` | 403 with `x-ratelimit-remaining: 0` (primary) or `retry-after` (secondary), or 429. | Wait for the reset and reconcile; nothing was changed by the refused call. Large first publishes upload one blob per file. |
| `github-ref-not-fast-forward` | Another writer moved (or rewound) the Pages branch between observe and update, or GitHub answered 422 "not a fast forward"; the update was not forced. | Find and stop the other writer, then reconcile: the next pass publishes on top of the new head. |
| `github-pages-build-errored` | The Pages build of the published head errored. | Read the error under Settings → Pages (or the Actions tab), fix the site and record new Freight. |
| `github-pages-deployment-failed` | The deployment failed on its content (`deployment_content_failed`). | Fix the site and record new Freight; transient failures are redeployed automatically. |
| `github-pages-artifact-unavailable` | Pages-deployment mode has no artifact id, the artifact expired or its digest differs, the Freight's tree index does not bind it (`pagesArtifactDigest`), or no OIDC token is bound. | Upload with `actions/upload-pages-artifact` and record the id and digest; run the reconcile inside the workflow with `id-token: write`; or use `branch` mode. |
| "is not observable on GitHub (the reply was lost)" | A write had an ambiguous outcome and GitHub does not show it. | Reconcile again: blobs and trees are content-addressed, an unreferenced commit is harmless, and the next pass adopts or republishes. |
| "GitHub built tree … not the locally computed Freight tree" | GitHub and the local git object computation disagree. | Do not retry blindly; capture the tree index and file a bug — the realizer refuses rather than publish a tree it cannot predict. |
| Outcome stays `lifecycleStatus: "building"` | Content is published; the Pages build has not finished. | Reconcile again later; a pass with no build of the head requests one. |
| Rollout refused for traffic routing on a Pages Camp | The profile declares no TrafficRouting offering. | Express staged release as separate Pages sites (repositories) per stage instead. |
