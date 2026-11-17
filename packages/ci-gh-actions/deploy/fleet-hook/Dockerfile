# syntax=docker/dockerfile:1.19
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

COPY --chmod=0555 packages/ci-gh-actions/templates/fleet-pre-job-hook.sh /opt/hobo/fleet/pre-job.sh
USER 1000:1000
