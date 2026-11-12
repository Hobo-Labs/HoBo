# Engine observation

`observeEngine` reads the engine's status API and returns an `EngineVerdict`;
`argoVerdict` and `fluxVerdict` are the pure decision functions.

| Engine | Status read | Converged when |
|---|---|---|
| Argo CD | `GET /api/v1/applications/{name}?appNamespace={ns}` | `sync.status=Synced`, `sync.revision` = published commit, `health.status=Healthy` |
| Flux | `GET /apis/kustomize.toolkit.fluxcd.io/v1/namespaces/{ns}/kustomizations/{name}` | `lastAppliedRevision` ends with the published commit, `Ready=True`, `observedGeneration ≥ generation` |

Blocked: Argo CD operation `Failed`/`Error` for the published revision, or
`Synced` + `Degraded`; Flux `Ready=False` with `lastAttemptedRevision` = the
published commit. Everything else is converging, and I/O never throws (a
missing credential is the one exception, surfaced as BLOCKED by the
publisher).

## Runbook

- `gitops-engine-not-found`: the root app has not created the document yet.
- `gitops-engine-unobservable`: wrong `endpoint.api_base_url`, a token
  without `get` on applications / kustomizations, or no network path.
- `gitops-engine-degraded`: read the engine's conditions; roll back through
  HoBo.
