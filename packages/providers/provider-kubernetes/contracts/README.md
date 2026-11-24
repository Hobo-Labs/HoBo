# Contracts

One boundary crosses out of this package: the Kubernetes apiserver. Two pact
files describe the two surfaces this package calls on it.

## `provider-kubernetes-apiserver.pact.json`

The consumer-driven contract for the core/v1 and apps/v1 surfaces this package
calls. `@hobo/provider-kubernetes` is the consumer; the apiserver is the
provider.

`test/contract.test.ts` replays every interaction in that file through the real
`createKubernetesApiClient`, asserting that the request the client emits still
matches the one the pact declares — method, path, headers and the **whole
rendered manifest** — and that the client behaves as documented when handed the
pact's recorded response. The fake sits at the HTTP seam; the parsers, the
manifest renderers, the guarded transport and the driver are all real.

**Only the consumer half is verified.** Nobody can verify a cluster's half
offline, and this package's default test lane starts no cluster. The pact
therefore does two jobs: it pins what this client sends, and it records — with a
`metadata.source.checkedAt` date — what a human last observed the apiserver
sending back. When someone re-checks the surface, the diff against this file is
the review.

### Interactions

| Interaction | What it pins |
|---|---|
| create the placement namespace | `POST /api/v1/namespaces` and the exact Namespace manifest, including the `app.kubernetes.io/managed-by` label cleanup keys off |
| AlreadyExists on that create | A 409 is not a failure — it is the second run of the same deploy |
| read the existing namespace | Adoption is a re-read, and the adopted record is marked as *not* created here |
| create the workload deployment | The whole Deployment manifest: `maxSurge: 1`, no service-account token, no privilege escalation, all capabilities dropped, resources in normalized units |
| create the ClusterIP service | ClusterIP only, one named port, selector matching the deployment |
| rollout half converged | `readyReplicas < desiredReplicas` reads as `progressing` |
| rollout complete | `available`, with the controller's observed generation current |
| rollout past its progress deadline | `failed` **while every replica counter looks healthy** — the case that justifies deriving a phase instead of reading one |
| 403 Forbidden | Maps to `PROVIDER_AUTH_FAILED`, carrying the `Status.reason` |
| namespace DELETE | Answers `Terminating`, so the outcome is `deleting`, not `deleted` |
| namespace NotFound | The only evidence that turns `deleting` into `deleted` |

## `provider-kubernetes-arc-runner-sets.pact.json`

The contract for the Actions Runner Controller and batch surfaces
`createArcRunnerSetClient` calls on behalf of `hobo ci fleet caches`.
`test/arc-runner-sets.contract.test.ts` replays every interaction through the
real client and guarded transport, asserting the emitted method, path, query,
headers and whole body; `packages/hobo/test/ci-fleet-caches.test.ts` asserts the
verb sends exactly the pact's patch and Job bodies. The responses were written
by hand from the Kubernetes API reference (`AutoscalingRunnerSet` from ARC's
`actions.github.com/v1alpha1` CRD, `Job` from `batch/v1`, `Status` failures).

| Interaction | What it pins |
|---|---|
| list the runner scale sets | `GET …/autoscalingrunnersets`; the verb's default targets are every scale set it lists |
| read one runner scale set | `GET …/autoscalingrunnersets/<name>` with the runner template the patch is computed from |
| NotFound for a scale set | A 404 reads as absent, not as a failure to retry |
| JSON-patch the node caches | `PATCH` with `application/json-patch+json`: a `resourceVersion` `test`, then the hostPath volumes, the `hobo-cache-owner` init container, the runner's mounts and env |
| resourceVersion test no longer holds | A 422 means the object moved under the patch: `PROVISIONING_CONFLICT`, run again |
| not authorized | A 403 maps to `PROVIDER_AUTH_FAILED` |
| create the store prewarm Job | `POST …/jobs` with the whole Job, labelled with its scale set and commit |
| AlreadyExists on that create | A 409 means this commit's prewarm already ran or is running |
| prewarm Jobs by label | `GET …/jobs?labelSelector=hobo.ci/store-prewarm=<scale set>`; `--status` reads the newest one's conditions |

### Why the manifest is compared whole

A pact that only checked the method and path would pass while this driver
quietly stopped setting `automountServiceAccountToken: false`, or inherited the
25% `maxSurge` default that the replica bounds in
`data-models/provider_kubernetes.cue` depend on. The rendered manifest *is* the
request, so the request assertion compares all of it.

### Credentials in this directory

There are none, and `test/contract.test.ts` asserts it: no bearer token, no
compact JWS, no PEM private key appears in any recorded body. An apiserver
`Status` message quotes the object that caused the failure, and those objects
carry ServiceAccount tokens — a real one must never be transcribed here.
