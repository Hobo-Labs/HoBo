# syntax=docker/dockerfile:1.19
ARG HOBO_TOOLCHAIN_IMAGE=hobo-ci-worker:local
ARG HOBO_RELEASE_VERSION=dev
ARG HOBO_RELEASE_REVISION=local

FROM ${HOBO_TOOLCHAIN_IMAGE} AS build
ENV CI=1 TURBO_TELEMETRY_DISABLED=1 MISE_EXPERIMENTAL=1
USER root
WORKDIR /build
RUN mkdir -p /work && chown -R 1000:1000 /work
USER 1000:1000
COPY --chown=1000:1000 package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY --chown=1000:1000 packages/schema-tools packages/schema-tools
COPY --chown=1000:1000 packages/core packages/core
RUN pnpm install --frozen-lockfile --config.confirmModulesPurge=false && \
    pnpm exec turbo run build --filter=@hobo/schema-tools... && \
    pnpm --filter @hobo/schema-tools deploy --prod --offline --config.inject-workspace-packages=true /work/app

FROM ${HOBO_TOOLCHAIN_IMAGE} AS runtime
ENV NODE_ENV=production HOBO_CODEGEN_PACKAGES_ROOT=/work
WORKDIR /work
USER 1000:1000
COPY --from=build --chown=1000:1000 /work/app /work/app
RUN mkdir -p /work/app/bin && printf '#!/bin/sh\nexec node /work/app/dist/cli.js "$@"\n' > /work/app/bin/hobo-codegen && chmod +x /work/app/bin/hobo-codegen
ENV PATH="/work/app/bin:${PATH}"
VOLUME ["/work"]
ENTRYPOINT ["hobo-codegen"]
CMD ["--help"]
