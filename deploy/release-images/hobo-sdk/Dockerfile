# syntax=docker/dockerfile:1.19
# SDK artifact carrier — staged allowlisted package tarballs.
ARG HOBO_TOOLCHAIN_IMAGE=hobo-ci-worker:local
ARG HOBO_RELEASE_VERSION=dev
ARG HOBO_RELEASE_REVISION=local

FROM ${HOBO_TOOLCHAIN_IMAGE}
ARG HOBO_RELEASE_VERSION
ARG HOBO_RELEASE_REVISION
LABEL org.opencontainers.image.title="HoBo SDK artifact layer" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${HOBO_RELEASE_VERSION}" \
      org.opencontainers.image.revision="${HOBO_RELEASE_REVISION}"
WORKDIR /sdk
COPY --chown=1000:1000 artifacts /sdk/artifacts
USER root
RUN mkdir -p /sdk/out && chown -R 1000:1000 /sdk
VOLUME ["/sdk/out"]
USER 1000:1000
ENTRYPOINT ["/bin/sh"]
CMD ["-c", "echo hobo-sdk artifact image; ls -la /sdk/artifacts"]
