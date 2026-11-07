# syntax=docker/dockerfile:1.19
ARG HOBO_TOOLCHAIN_IMAGE=hobo-ci-worker:local
ARG HOBO_RELEASE_VERSION=dev
ARG HOBO_RELEASE_REVISION=local

FROM ${HOBO_TOOLCHAIN_IMAGE}
ARG HOBO_RELEASE_VERSION
ARG HOBO_RELEASE_REVISION
ENV NODE_ENV=production HOBO_SITE_PORT=4321 HOBO_SITE_BASE=/HoBo/
LABEL org.opencontainers.image.title="HoBo docs PWA" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${HOBO_RELEASE_VERSION}" \
      org.opencontainers.image.revision="${HOBO_RELEASE_REVISION}"
WORKDIR /site
COPY --chown=1000:1000 dist /site/dist
COPY --chown=1000:1000 server.mjs /site/server.mjs
EXPOSE 4321
USER 1000:1000
HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 \
    CMD node -e 'fetch(`http://127.0.0.1:${process.env.HOBO_SITE_PORT||4321}/`,{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
ENTRYPOINT ["node", "server.mjs"]
CMD []
