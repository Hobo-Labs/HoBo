# OCI component runtime image

`@hobo/runtime-oci` schedules private WASM components on Kubernetes using a
pullable **runtime** container image (`HOBO_OCI_RUNTIME_IMAGE`). The host
injects the workload command; this image only supplies a pinned, non-root base
with `sh`, `nc`, and `sleep` (Busybox applets).

Build and load locally:

```sh
docker build -f packages/runtimes/runtime-oci/deploy/Dockerfile -t hobo-oci-runtime:local .
export HOBO_OCI_RUNTIME_IMAGE=hobo-oci-runtime:local
```

Production operators should deploy by immutable digest, not a floating tag.
