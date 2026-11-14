# syntax=docker/dockerfile:1.19
# The release build records the resolved digest; operators should publish and deploy by digest.
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
ENV CI=1 TURBO_TELEMETRY_DISABLED=1
WORKDIR /build
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm install --global pnpm@10.33.4 --ignore-scripts
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY --exclude=**/node_modules --exclude=**/dist packages/ci packages/ci
COPY --exclude=**/node_modules --exclude=**/dist packages/ci-gh-actions packages/ci-gh-actions
COPY --exclude=**/node_modules --exclude=**/dist packages/ci-dagger packages/ci-dagger
COPY --exclude=**/node_modules --exclude=**/dist packages/ci-cf packages/ci-cf
COPY --exclude=**/node_modules --exclude=**/dist packages/dispatcher packages/dispatcher
RUN --mount=type=secret,id=proxy_ca \
    set -eu; \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    pnpm --filter @hobo/ci-gh-actions... install --frozen-lockfile --ignore-scripts && \
    pnpm exec turbo run build --filter=@hobo/ci-gh-actions && \
    pnpm --filter @hobo/ci-gh-actions deploy --prod --offline --config.inject-workspace-packages=true /out

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
ENV NODE_ENV=production HOBO_CI_HOST=0.0.0.0 HOBO_CI_PORT=8787 HOBO_CI_DB=/var/lib/hobo-ci/relay.sqlite
WORKDIR /app
COPY --from=build --chown=1000:1000 /out /app
RUN mkdir -p /var/lib/hobo-ci/git && chown 1000:1000 /var/lib/hobo-ci /var/lib/hobo-ci/git
RUN command -v flock
USER 1000:1000
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=4s --start-period=15s --retries=3 \
    CMD node -e 'fetch("http://127.0.0.1:8787/readyz",{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
ENTRYPOINT ["node", "--use-env-proxy", "dist/main.js"]
