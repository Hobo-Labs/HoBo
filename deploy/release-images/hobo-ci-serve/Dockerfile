# syntax=docker/dockerfile:1.19
# CI relay — extends packages/ci-gh-actions/deploy/Dockerfile runtime with mise toolchain base.
ARG HOBO_TOOLCHAIN_IMAGE=hobo-ci-worker:local
ARG HOBO_RELEASE_VERSION=dev
ARG HOBO_RELEASE_REVISION=local

FROM ${HOBO_TOOLCHAIN_IMAGE} AS build
ENV CI=1 TURBO_TELEMETRY_DISABLED=1
USER root
WORKDIR /build
USER 1000:1000
COPY --chown=1000:1000 package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY --chown=1000:1000 packages/ci packages/ci
COPY --chown=1000:1000 packages/ci-gh-actions packages/ci-gh-actions
COPY --chown=1000:1000 packages/ci-dagger packages/ci-dagger
COPY --chown=1000:1000 packages/ci-cf packages/ci-cf
COPY --chown=1000:1000 packages/dispatcher packages/dispatcher
RUN pnpm install --frozen-lockfile --config.confirmModulesPurge=false && \
    pnpm exec turbo run build --filter=@hobo/ci-gh-actions && \
    pnpm --filter @hobo/ci-gh-actions deploy --prod --offline --config.inject-workspace-packages=true /out

FROM ${HOBO_TOOLCHAIN_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOBO_CI_HOST=0.0.0.0 \
    HOBO_CI_PORT=8787 \
    HOBO_CI_DB=/var/lib/hobo-ci/relay.sqlite
WORKDIR /app
USER root
RUN mkdir -p /var/lib/hobo-ci && chown 1000:1000 /var/lib/hobo-ci
USER 1000:1000
COPY --from=build --chown=1000:1000 /out /app
EXPOSE 8787
VOLUME ["/var/lib/hobo-ci"]
HEALTHCHECK --interval=15s --timeout=4s --start-period=15s --retries=3 \
    CMD node -e 'fetch("http://127.0.0.1:8787/readyz",{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "--use-env-proxy", "dist/main.js"]
CMD []
