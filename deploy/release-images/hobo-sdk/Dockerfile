# syntax=docker/dockerfile:1.19
# SDK artifact carrier — allowlisted package tarballs for downstream CLI/PWA builds.
ARG HOBO_TOOLCHAIN_IMAGE=hobo-ci-worker:local
ARG HOBO_SDK_ARTIFACT_IMAGE=

FROM ${HOBO_TOOLCHAIN_IMAGE} AS build
ENV CI=1 TURBO_TELEMETRY_DISABLED=1
USER 1000:1000
WORKDIR /build
COPY --chown=1000:1000 package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json release/npm-scope-map.json release/
COPY --chown=1000:1000 scripts/ci/npm-publish-scope.mts scripts/ci/npm-publish-scope.mts
COPY --chown=1000:1000 scripts/ci/stage-sdk-artifacts.mts scripts/ci/stage-sdk-artifacts.mts
COPY --chown=1000:1000 packages packages
RUN pnpm install --frozen-lockfile --config.confirmModulesPurge=false && \
    pnpm exec turbo run build --filter=@hobo/core --filter=@hobo/bindles --filter=@hobo/contracts --filter=@hobo/cli --filter=@hobo/runtime-local && \
    node --no-warnings scripts/ci/stage-sdk-artifacts.mts /sdk/artifacts

FROM ${HOBO_TOOLCHAIN_IMAGE} AS runtime
WORKDIR /sdk
USER 1000:1000
COPY --from=build --chown=1000:1000 /sdk/artifacts /sdk/artifacts
VOLUME ["/sdk/out"]
ENTRYPOINT ["/bin/sh"]
CMD ["-c", "echo hobo-sdk artifact image; ls -la /sdk/artifacts"]
