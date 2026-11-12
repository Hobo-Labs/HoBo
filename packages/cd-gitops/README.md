# `@hobo/cd-gitops`

A `PublisherPort` (frozen in `@hobo/cd`) for Camps in **publisher** reconciler
mode (plan 0024, WP16, D14). It renders a Set as an **Argo CD `Application`**
or a **Flux `Kustomization`**, commits it through a Git host's HTTP API
(**GitHub, GitLab, Gitea/Forgejo, Bitbucket Cloud**), and reports convergence
only from the engine's own status API.

Vendor vocabulary lives here, outside the neutral `@hobo/cd` core (I11). The
broker's deprecated `engine: argo` maps to the `argo-cd` publisher target,
which a `PublisherRegistry` resolves to this package's Argo CD publisher.

## Layout written to Git

```
<path_prefix>/camp-<camp>/argo-cd.application.json     (or flux.kustomization.json)
<path_prefix>/camp-<camp>/manifests/hobo-set.configmap.json
```

- The engine document points the engine at `manifests/`.
- `hobo-set.configmap.json` carries the Set record and its canonical,
  secret-free resolved set (`set.json`, `resolved.json`), ≤ 900 KiB.
- Bytes are stable: sorted keys, two-space indent, trailing newline, names
  derived from the Camp id only (DNS-1123, hashed when unsafe). Golden files:
  `test/golden/*.golden`.
- Operators bootstrap **one** root app (Argo CD app-of-apps) or root Flux
  `Kustomization` over `<path_prefix>`; HoBo never calls the engine's write
  API (pull, not push).

## Publish and observe

| Step | Behaviour |
|---|---|
| publish | Render → read branch head → read each document at the head → if all bytes equal, return the head (idempotent, no commit) → else one commit with every changed file on top of the head. If the branch moved (`gitops-host-conflict`), re-read and retry once. |
| observe | Argo CD: `GET /api/v1/applications/<name>?appNamespace=<ns>`. Flux: `GET /apis/kustomize.toolkit.fluxcd.io/v1/namespaces/<ns>/kustomizations/<name>`. |
| CONVERGED | Argo CD `sync.status=Synced`, `sync.revision` = the published commit, `health=Healthy`. Flux `lastAppliedRevision` ends with the published commit, `Ready=True`, `observedGeneration ≥ generation`. |
| BLOCKED | The engine applied or attempted the published revision and reports it `Degraded`/`Failed` (`gitops-engine-degraded`), or a credential is missing. |
| CONVERGING | Anything else, including a 404 (`gitops-engine-not-found`) or an unreadable status (`gitops-engine-unobservable`). A commit alone never counts (I5). |

Git host calls:

| Host | head | read | commit |
|---|---|---|---|
| GitHub | `GET /repos/{o}/{r}/git/ref/heads/{b}` | `GET …/contents/{path}?ref=` | Git Data API: commit → tree (inline) → commit → `PATCH refs` (`force: false`) |
| GitLab | `GET /projects/{id}/repository/branches/{b}` | `GET …/files/{path}?ref=` | `POST …/commits` with `start_sha` |
| Gitea / Forgejo | `GET /repos/{o}/{r}/branches/{b}` | `GET …/contents/{path}?ref=` | `POST …/contents` (ChangeFiles, blob `sha` on update) |
| Bitbucket Cloud | `GET /repositories/{w}/{r}/refs/branches/{b}` | `GET …/src/{sha}/{path}` | `POST …/src` (form, `parents` guard), hash from `Location` |

Credentials: `CredentialResolver.resolve(ref, "cd.gitops.git" | "cd.gitops.engine")`
must return `{ token }`. They are resolved per call, sent only as an
`Authorization` header, and never recorded.

## Configuration (`hobo.cd-gitops.publisher/v1`)

Protobuf `data-models/gitops.proto`, constraints `data-models/gitops.cue`,
parsed by `parsePublisherConfig` into the branded `PublisherConfig`. Defaults:
Argo CD namespace `argocd`, project `default`, destination
`https://kubernetes.default.svc` / `hobo-system`; Flux namespace
`flux-system`, source `GitRepository/hobo`, interval `1m`.

## Metrics (through `TelemetrySink`)

| Metric | Attributes |
|---|---|
| `hobo.cd.gitops.publishes` (counter) | `hobo.gitops.engine`, `hobo.gitops.host`, `outcome` (`committed`, `unchanged`, or a failure code) |
| `hobo.cd.gitops.observations` (counter) | `hobo.gitops.engine`, `hobo.gitops.host`, `status` |

## Proof

- Unit: `test/render.test.ts` (byte-stable goldens), `test/publisher.test.ts`
  (idempotency, conflict retry, typed refusals, convergence only on
  observation, legacy `argo` → `argo-cd` registry, config parsing).
- PACT (`contracts/pacts/cd_gitops_*.pact.json`, consumer
  `HoboCdGitopsPublisher`): GitHub, GitLab, Gitea/Forgejo, Bitbucket first
  publish; Argo CD and Flux converged / converging / blocked / missing.
  These are hand-authored consumer pacts, not provider-verified traffic.

## Runbook

| Symptom | Code | Action |
|---|---|---|
| Publisher refuses to load | `gitops-config-invalid` | Fix the named field (https URLs, `owner/name`, branch, relative prefix, DNS-1123 namespaces). |
| Every publish refused before any call | `gitops-credential-missing` | Store `{ token }` under `repository.credential_ref` (and `endpoint.credential_ref` for observation). |
| `outcome=gitops-host-auth-failed` | `gitops-host-auth-failed` | Token lacks contents write, or branch protection blocks the publisher. Grant it or use a dedicated branch. |
| `outcome=gitops-host-not-found` | `gitops-host-not-found` | Create the branch or fix `repository`/`branch`/`api_base_url`. |
| `outcome=gitops-host-conflict` repeatedly | `gitops-host-conflict` | Another writer shares the branch/prefix. Give HoBo its own branch or `path_prefix`. |
| `outcome=gitops-host-unavailable` | `gitops-host-unavailable` | Host outage or rate limit; nothing was committed. The reconciler retries next pass. |
| Camp stuck CONVERGING with `gitops-engine-not-found` | — | Bootstrap the root app / root Kustomization over `path_prefix`. |
| Camp stuck CONVERGING with `gitops-engine-unobservable` | — | Check `endpoint.api_base_url`, the engine token (`get` on applications or kustomizations) and network reach. |
| Camp BLOCKED with `gitops-engine-degraded` | — | Read the engine's conditions; roll back through HoBo (`hobo deploy rollback`), never by editing Git by hand. |
| `gitops-set-too-large` | — | Resolved set > 900 KiB: split the Bindle or use an agent reconciler for that Camp. |
| Broker policy still says `engine: argo` | — | Works through the `argo-cd` publisher; configure a publisher named `argo-cd`. |
