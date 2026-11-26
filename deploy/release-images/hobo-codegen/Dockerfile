# syntax=docker/dockerfile:1.19
ARG HOBO_TOOLCHAIN_IMAGE=hobo-ci-worker:local
ARG HOBO_RELEASE_VERSION=dev
ARG HOBO_RELEASE_REVISION=local

FROM ${HOBO_TOOLCHAIN_IMAGE}
ARG HOBO_RELEASE_VERSION
ARG HOBO_RELEASE_REVISION
ENV NODE_ENV=production HOBO_CODEGEN_PACKAGES_ROOT=/work
LABEL org.opencontainers.image.title="HoBo schema-tools codegen" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${HOBO_RELEASE_VERSION}" \
      org.opencontainers.image.revision="${HOBO_RELEASE_REVISION}"
WORKDIR /work
COPY --chown=1000:1000 app /work/app
USER root
RUN mkdir -p /work/out && chown 1000:1000 /work/out
ENV PATH="/work/app/bin:${PATH}"
VOLUME ["/work"]
USER 1000:1000
ENTRYPOINT ["hobo-codegen"]
CMD ["--help"]
