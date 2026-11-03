# syntax=docker/dockerfile:1.19
# Hermetic release image: mise OCI toolchain base + @hobo/code product binary.
ARG HOBO_TOOLCHAIN_IMAGE=hobo-ci-worker:local
ARG HOBO_RELEASE_VERSION=dev
ARG HOBO_RELEASE_REVISION=local

FROM ${HOBO_TOOLCHAIN_IMAGE} AS build
ENV CI=1 TURBO_TELEMETRY_DISABLED=1 MISE_EXPERIMENTAL=1
USER root
WORKDIR /build
RUN mkdir -p /home/hobo/.hobo && chown -R 1000:1000 /home/hobo
USER 1000:1000
COPY --chown=1000:1000 package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json mise.toml mise.lock ./
COPY --chown=1000:1000 packages packages
RUN pnpm install --frozen-lockfile --config.confirmModulesPurge=false && \
    pnpm exec turbo run build --filter=@hobo/code... && \
    pnpm --filter @hobo/code deploy --prod --offline --config.inject-workspace-packages=true /home/hobo/app

FROM ${HOBO_TOOLCHAIN_IMAGE} AS runtime
ARG HOBO_RELEASE_VERSION
ARG HOBO_RELEASE_REVISION
ENV NODE_ENV=production HOBO_HOME=/home/hobo/.hobo
LABEL org.opencontainers.image.title="HoBo Code" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${HOBO_RELEASE_VERSION}" \
      org.opencontainers.image.revision="${HOBO_RELEASE_REVISION}"
WORKDIR /home/hobo
USER 1000:1000
COPY --from=build --chown=1000:1000 /home/hobo/app /home/hobo/app
ENV PATH="/home/hobo/app/node_modules/.bin:${PATH}"
VOLUME ["/home/hobo/.hobo"]
ENTRYPOINT ["hobo-code"]
CMD ["--help"]
