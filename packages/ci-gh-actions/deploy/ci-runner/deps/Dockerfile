ARG TOOLCHAIN_IMAGE=hobo-ci-worker:local
ARG FETCH_IMAGE=hobo-ci-deps-fetch:local

FROM ${TOOLCHAIN_IMAGE} AS fetch
USER root
RUN mkdir -p /pnpm-store /opt/actions-runner/_hobo_work/HoBo/HoBo \
  && chown -R 1000:1000 /pnpm-store /opt/actions-runner/_hobo_work
USER 1000:1000
WORKDIR /opt/actions-runner/_hobo_work/HoBo/HoBo
ENV npm_config_store_dir=/pnpm-store \
  npm_config_package_import_method=copy
COPY --chown=1000:1000 . .
RUN pnpm fetch --frozen-lockfile

FROM ${FETCH_IMAGE} AS install
ARG SOURCE_DATE_EPOCH=0
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
WORKDIR /opt/actions-runner/_hobo_work/HoBo/HoBo
RUN pnpm install --frozen-lockfile --offline --ignore-scripts \
  && pnpm rebuild @ast-grep/cli @bufbuild/buf esbuild protobufjs \
  && git init --quiet \
  && git config remote.origin.url https://github.com/Hobo-Labs/HoBo

FROM ${TOOLCHAIN_IMAGE} AS final
ARG DEPS_KEY
ARG TOOLCHAIN_VERSION
ARG SOURCE_DATE_EPOCH=0
LABEL hobo.ci.deps-key=${DEPS_KEY} \
  hobo.ci.toolchain=${TOOLCHAIN_VERSION}
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
  npm_config_store_dir=/pnpm-store \
  npm_config_package_import_method=copy
COPY --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/HoBo/HoBo \
  /opt/actions-runner/_hobo_work/HoBo/HoBo
USER root
RUN find /opt/actions-runner/_hobo_work/HoBo/HoBo -mindepth 1 \
    \( -name node_modules -o -name .git \) -prune -o -type f -delete \
  && find /opt/actions-runner/_hobo_work/HoBo/HoBo -depth -mindepth 1 \
    \( -name node_modules -o -name .git \) -prune -o -type d -empty -delete
USER 1000:1000
WORKDIR /opt/actions-runner/_hobo_work/HoBo/HoBo
