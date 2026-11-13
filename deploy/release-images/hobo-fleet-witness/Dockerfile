# syntax=docker/dockerfile:1.19
# HoBo Fleet witness — runtime-only mise toolchain image with the staged
# @hobo/fleet-authority application, running its hobo-fleet-witness binary
# (design §6.14, §6.16). It co-signs audit checkpoints and proposed trust
# records; it keeps no state of its own. Run it under another account than the
# authority (standalone) or on another host (high availability).
ARG HOBO_TOOLCHAIN_IMAGE=hobo-ci-worker:local
ARG HOBO_RELEASE_VERSION=dev
ARG HOBO_RELEASE_REVISION=local

FROM ${HOBO_TOOLCHAIN_IMAGE}
ARG HOBO_RELEASE_VERSION
ARG HOBO_RELEASE_REVISION
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="HoBo Fleet witness" \
      org.opencontainers.image.description="Audit and trust-record co-signer for a HoBo fleet (hobo-fleet-witness)" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${HOBO_RELEASE_VERSION}" \
      org.opencontainers.image.revision="${HOBO_RELEASE_REVISION}"
WORKDIR /app
USER root
RUN mkdir -p /etc/hobo-fleet
COPY --chown=1000:1000 app /app
USER 1000:1000
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "--use-env-proxy", "dist/bin/hobo-fleet-witness.js"]
CMD ["--config", "/etc/hobo-fleet/witness.json"]
