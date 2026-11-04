# syntax=docker/dockerfile:1.19
ARG TOOLCHAIN_IMAGE=hobo-ci-worker:local

FROM ${TOOLCHAIN_IMAGE} AS fetch
USER root
RUN mkdir -p /pnpm-store /opt/actions-runner/_hobo_work/HoBo/HoBo \
  && chown -R 1000:1000 /pnpm-store /opt/actions-runner/_hobo_work
USER 1000:1000
WORKDIR /opt/actions-runner/_hobo_work/HoBo/HoBo
ENV npm_config_store_dir=/pnpm-store \
  npm_config_package_import_method=copy
COPY --chown=1000:1000 . .
RUN --mount=type=cache,id=hobo-pnpm-store,target=/pnpm-store,uid=1000,gid=1000 \
  pnpm fetch --frozen-lockfile

FROM fetch AS install
ARG SOURCE_DATE_EPOCH=0
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
WORKDIR /opt/actions-runner/_hobo_work/HoBo/HoBo
RUN --network=none --mount=type=cache,id=hobo-pnpm-store,target=/pnpm-store,uid=1000,gid=1000 \
  pnpm install --frozen-lockfile --offline --ignore-scripts \
  && pnpm rebuild @ast-grep/cli @bufbuild/buf esbuild protobufjs \
  && find . -type d -name node_modules -prune -exec sh -c \
    'for source do target="/opt/hobo-deps/${source#./}"; mkdir -p "$(dirname "$target")"; mv "$source" "$target"; done' sh {} +

FROM ${TOOLCHAIN_IMAGE} AS final
ARG DEPS_KEY
ARG TOOLCHAIN_VERSION
ARG SOURCE_DATE_EPOCH=0
LABEL hobo.ci.deps-key=${DEPS_KEY} \
  hobo.ci.toolchain=${TOOLCHAIN_VERSION}
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
  npm_config_store_dir=/pnpm-store \
  npm_config_package_import_method=copy
USER root
RUN install -d -o 1000 -g 1000 /opt/hobo-deps \
  && printf '%s\n' "$DEPS_KEY" > /opt/hobo-deps/.hobo-ci-deps-key \
  && chown 1000:1000 /opt/hobo-deps/.hobo-ci-deps-key
COPY --from=install --chown=1000:1000 /opt/hobo-deps/ /opt/hobo-deps/
USER 1000:1000
