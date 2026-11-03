# syntax=docker/dockerfile:1.19
# CI relay — runtime-only mise toolchain image with a staged application.
ARG HOBO_TOOLCHAIN_IMAGE=hobo-ci-worker:local
ARG HOBO_RELEASE_VERSION=dev
ARG HOBO_RELEASE_REVISION=local

FROM ${HOBO_TOOLCHAIN_IMAGE}
ARG HOBO_RELEASE_VERSION
ARG HOBO_RELEASE_REVISION
ENV NODE_ENV=production \
    HOBO_CI_HOST=0.0.0.0 \
    HOBO_CI_PORT=8787 \
    HOBO_CI_DB=/var/lib/hobo-ci/relay.sqlite
LABEL org.opencontainers.image.title="HoBo CI relay" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${HOBO_RELEASE_VERSION}" \
      org.opencontainers.image.revision="${HOBO_RELEASE_REVISION}"
WORKDIR /app
USER root
RUN mkdir -p /var/lib/hobo-ci && chown 1000:1000 /var/lib/hobo-ci
COPY --chown=1000:1000 app /app
EXPOSE 8787
VOLUME ["/var/lib/hobo-ci"]
USER 1000:1000
HEALTHCHECK --interval=15s --timeout=4s --start-period=15s --retries=3 \
    CMD node -e 'fetch("http://127.0.0.1:8787/readyz",{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "--use-env-proxy", "dist/main.js"]
CMD []
