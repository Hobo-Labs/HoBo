# syntax=docker/dockerfile:1.19
# Placeholder OCI runtime for @hobo/runtime-oci private components on Kubernetes.
# The host supplies containerCommand (see host.ts); publish by digest after build.
FROM docker.io/library/busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662
USER 1000:1000
STOPSIGNAL SIGTERM
CMD ["sleep", "infinity"]
