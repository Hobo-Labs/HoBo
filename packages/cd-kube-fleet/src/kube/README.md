# `src/kube/` — Kubernetes API client, rendering, observation

| File | Holds |
|---|---|
| `api.ts` | `createKubeApi`: get/list/create/replace/remove and bounded `watch` (newline-delimited events, 410 Gone → re-list) over `HttpTransport`. Credentials resolve per call (`kube-api:<hub>` or `kube-exec:<hub>` scope); expired exec tokens are refused before sending. Status codes map to typed failures. |
| `objects.ts` | `renderObjects`: plan resource → `KubeObject` (manifest or known product + spec), the built-in `KNOWN_KINDS` table, REST paths, `campSlug`, `digest8`, the labels/annotations HoBo writes (`HOBO_KEYS`), `fenceOf`. |
| `observation.ts` | `preflight` (I1 content check, cluster mapping, rendering — no hub call on failure), the `ReconcileObservationRecord` builder, the reconciler's `keep` directive. |

The client never follows redirects itself (the transport must not either),
never logs headers, and never puts a token anywhere but the `Authorization`
header.

## Runbook

| Symptom | Action |
|---|---|
| `kube-response-invalid` | The API base URL is not a Kubernetes API root (a proxy login page, a wrong port) or a CRD is missing. Check `api_base_url` and the installed CRD versions. |
| `kube-kind-unknown` | Declare `realizationParameters.resource` (REST plural) and `realizationParameters.namespaced` for the custom kind. |
| `kube-credential-expired` | The host's exec plugin returned a stale token; make it mint per resolve. |
