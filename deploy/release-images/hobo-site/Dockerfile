# syntax=docker/dockerfile:1.19
ARG HOBO_TOOLCHAIN_IMAGE=hobo-ci-worker:local

FROM ${HOBO_TOOLCHAIN_IMAGE} AS build
ENV CI=1 TURBO_TELEMETRY_DISABLED=1
USER 1000:1000
WORKDIR /build
COPY --chown=1000:1000 package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY --chown=1000:1000 site site
COPY --chown=1000:1000 packages packages
RUN pnpm install --frozen-lockfile --config.confirmModulesPurge=false && \
    pnpm --filter hobo-site run build

FROM ${HOBO_TOOLCHAIN_IMAGE} AS runtime
ENV NODE_ENV=production HOBO_SITE_PORT=4321 HOBO_SITE_BASE=/HoBo/
WORKDIR /site
USER 1000:1000
COPY --from=build --chown=1000:1000 /build/site/dist /site/dist
COPY --chown=1000:1000 deploy/release-images/hobo-site/server.mjs /site/server.mjs
EXPOSE 4321
HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 \
    CMD node -e 'fetch(`http://127.0.0.1:${process.env.HOBO_SITE_PORT||4321}/`,{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
ENTRYPOINT ["node", "server.mjs"]
CMD []
