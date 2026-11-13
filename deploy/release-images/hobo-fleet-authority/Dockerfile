# syntax=docker/dockerfile:1.19
# HoBo Fleet authority — runtime-only mise toolchain image with the staged
# @hobo/fleet-authority application (design §6.15, §6.16). Configuration is a
# mounted FleetAuthorityConfig JSON file; every key comes from OpenBao.
ARG HOBO_TOOLCHAIN_IMAGE=hobo-ci-worker:local
ARG HOBO_RELEASE_VERSION=dev
ARG HOBO_RELEASE_REVISION=local

FROM ${HOBO_TOOLCHAIN_IMAGE}
ARG HOBO_RELEASE_VERSION
ARG HOBO_RELEASE_REVISION
ENV NODE_ENV=production
LABEL org.opencontainers.image.title="HoBo Fleet authority" \
      org.opencontainers.image.description="Enrollment, credentials, registry and auth callout for a HoBo fleet (hobo-fleet-authority)" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${HOBO_RELEASE_VERSION}" \
      org.opencontainers.image.revision="${HOBO_RELEASE_REVISION}"
WORKDIR /app
USER root
RUN mkdir -p /var/lib/hobo-fleet /etc/hobo-fleet && chown 1000:1000 /var/lib/hobo-fleet
COPY --chown=1000:1000 app /app
EXPOSE 8443
VOLUME ["/var/lib/hobo-fleet"]
USER 1000:1000
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=3 \
    CMD node -e 'fetch("http://127.0.0.1:8443/readyz",{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "--use-env-proxy", "dist/bin/hobo-fleet-authority.js"]
CMD ["--config", "/etc/hobo-fleet/authority.json"]
