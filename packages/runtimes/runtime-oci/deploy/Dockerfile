# syntax=docker/dockerfile:1.19
# Placeholder OCI runtime for @hobo/runtime-oci private components on Kubernetes.
# The host supplies containerCommand (see host.ts); publish by digest after build.
FROM docker.io/library/busybox:1.38@sha256:a46257e06c82ad85242d0d38077d0a52d9896389ca60a1a59d3463db586e5fa4
USER 1000:1000
STOPSIGNAL SIGTERM
CMD ["sleep", "infinity"]
