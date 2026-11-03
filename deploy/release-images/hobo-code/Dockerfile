# syntax=docker/dockerfile:1.19
# Runtime-only release image: mise OCI toolchain base + staged @hobo/code app.
ARG HOBO_TOOLCHAIN_IMAGE=hobo-ci-worker:local
ARG HOBO_RELEASE_VERSION=dev
ARG HOBO_RELEASE_REVISION=local

FROM ${HOBO_TOOLCHAIN_IMAGE}
ARG HOBO_RELEASE_VERSION
ARG HOBO_RELEASE_REVISION
ENV NODE_ENV=production HOBO_HOME=/home/hobo/.hobo
LABEL org.opencontainers.image.title="HoBo Code" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${HOBO_RELEASE_VERSION}" \
      org.opencontainers.image.revision="${HOBO_RELEASE_REVISION}"
WORKDIR /home/hobo
COPY --chown=1000:1000 app /home/hobo/app
USER root
RUN mkdir -p /home/hobo/.hobo && chown -R 1000:1000 /home/hobo
ENV PATH="/home/hobo/app/bin:/home/hobo/app/node_modules/.bin:${PATH}"
VOLUME ["/home/hobo/.hobo"]
USER 1000:1000
ENTRYPOINT ["hobo-code"]
CMD ["--help"]
