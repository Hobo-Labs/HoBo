# @hobo/provider-github

The GitHub Pages realizer for HoBo.CD ([plan 0024](../../../docs/plans/0024-hobo-cd-swarm-instruction.md)):
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

Paths are relative and `/`-separated; an empty, `.`, `..`, `.git` or
control-character segment, a duplicate and a path that is both a file and a
directory are refused. At most 20 000 files, 100 MB per file (the Git Data API
blob limit) and 1 GB in total (the Pages site limit). From the file bytes the
realizer computes the git blob ids and the git tree id **locally**, exactly as
`git write-tree` would — that tree id is the desired state, known before
anything is uploaded.

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
    digest matches) and `GET pages/deployments/{id}` for the deployment the
    last outcome recorded (`request.observed.pagesDeploymentId`).
- **Converge, branch mode (compare-and-swap).** If the published tree id
  differs from the Freight's: list the published tree recursively and upload
  only the blobs it lacks (`POST git/blobs`, base64; each returned id must be
  the locally computed one), create the site tree (`POST git/trees` from flat
  paths; its id must equal the local tree id), graft it under `docs/` with
  `base_tree` when publishing from `/docs`, create a commit whose only parent
  is the observed head (`POST git/commits`), and move the ref with
  `PATCH git/refs/heads/{branch}` `force: false` — or `POST git/refs` when the
  branch is absent. Because the parent is the observed head, the update is a
  fast-forward only if the head has not moved: a compare-and-swap on the
  expected old sha. A pass that pushed nothing and finds no build of the head
  asks for one (`POST pages/builds`).
- **Converge, pages-deployment mode.** The REST API has **no artifact
  upload** — that is the Actions runtime service, reachable only inside a
  workflow run, with binary bodies the string-bodied `HttpTransport` cannot
  carry. So the build workflow uploads the artifact
  (`actions/upload-pages-artifact`) and records its id and digest on the
  Freight; the realizer verifies it and calls `POST pages/deployments` with
  the local tree id as `pages_build_version` and the workflow's OIDC token.
  A deployment the last outcome recorded for the same tree and artifact is
  observed, not repeated; a retryable failure (`deployment_failed`,
  `_cancelled`, `_attempt_error`, `_lost`) is redeployed.
- **Converged only when observed (I5).** `ready` is true only when the
  published tree id equals the Freight's **and** the latest Pages build is
  `built` for that head commit (branch), or the deployment of that tree id is
  `succeed` (pages-deployment). Until then outcomes carry
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

Honest limits: deployment-mode idempotency across a lost
`POST pages/deployments` reply relies on the next pass redeploying the same
artifact (identical content), since GitHub offers no lookup of a Pages
deployment by build version; the realizer never reconfigures the Pages source
(a mismatch is a refusal, not a repair).

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
  responses; `data-models/provider_github.proto` and `provider_github.cue` are
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
| `github-permission-missing` | The repository is invisible to the token, `permissions.push` is false, or GitHub answered 403 (including branch protection). | Grant the token `contents: write` and `pages: write` on the repository; allow it past branch protection on the Pages branch. |
| `github-credential-rejected` (`RESOLVER_CREDENTIAL_MISSING`) | GitHub answered 401. | Re-issue the token behind the credentialRef. |
| `github-rate-limited` | 403 with an exhausted rate limit, or 429. | Wait for the reset and reconcile; nothing was changed by the refused call. Large first publishes upload one blob per file. |
| `github-ref-not-fast-forward` | Another writer moved the Pages branch between observe and update; the update was not forced. | Find and stop the other writer, then reconcile: the next pass publishes on top of the new head. |
| `github-pages-build-errored` | The Pages build of the published head errored. | Read the error under Settings → Pages (or the Actions tab), fix the site and record new Freight. |
| `github-pages-deployment-failed` | The deployment failed on its content (`deployment_content_failed`). | Fix the site and record new Freight; transient failures are redeployed automatically. |
| `github-pages-artifact-unavailable` | Pages-deployment mode has no artifact id, the artifact expired or its digest differs, or no OIDC token is bound. | Upload with `actions/upload-pages-artifact` and record the id and digest; run the reconcile inside the workflow with `id-token: write`; or use `branch` mode. |
| "is not observable on GitHub (the reply was lost)" | A write had an ambiguous outcome and GitHub does not show it. | Reconcile again: blobs and trees are content-addressed, an unreferenced commit is harmless, and the next pass adopts or republishes. |
| "GitHub built tree … not the locally computed Freight tree" | GitHub and the local git object computation disagree. | Do not retry blindly; capture the tree index and file a bug — the realizer refuses rather than publish a tree it cannot predict. |
| Outcome stays `lifecycleStatus: "building"` | Content is published; the Pages build has not finished. | Reconcile again later; a pass with no build of the head requests one. |
| Rollout refused for traffic routing on a Pages Camp | The profile declares no TrafficRouting offering. | Express staged release as separate Pages sites (repositories) per stage instead. |
