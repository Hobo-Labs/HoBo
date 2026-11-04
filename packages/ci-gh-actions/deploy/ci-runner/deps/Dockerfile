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
  && git init --quiet \
  && git config remote.origin.url https://github.com/Hobo-Labs/HoBo \
  && find . -type d -name node_modules -prune -exec sh -c \
    'for source do target="/opt/actions-runner/_hobo_work/deps/${source#./}"; mkdir -p "$(dirname "$target")"; mv "$source" "$target"; done' sh {} + \
  && mv .git /opt/actions-runner/_hobo_work/deps/.git
RUN --network=none \
  node --experimental-strip-types scripts/ci/deps-layer-buckets.mts partition \
    /opt/actions-runner/_hobo_work/deps \
    /opt/actions-runner/_hobo_work/deps-buckets \
  && find /opt/actions-runner/_hobo_work/deps /opt/actions-runner/_hobo_work/deps-buckets \
    -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

FROM ${TOOLCHAIN_IMAGE} AS final
ARG DEPS_KEY
ARG TOOLCHAIN_VERSION
ARG SOURCE_DATE_EPOCH=0
LABEL hobo.ci.deps-key=${DEPS_KEY} \
  hobo.ci.toolchain=${TOOLCHAIN_VERSION}
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
  npm_config_store_dir=/pnpm-store \
  npm_config_package_import_method=copy
# BEGIN GENERATED DEPS BUCKET LAYERS: scripts/ci/deps-layer-buckets.mts
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/00/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/01/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/02/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/03/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/04/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/05/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/06/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/07/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/08/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/09/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/10/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/11/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/12/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/13/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/14/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/15/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/16/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/17/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/18/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/19/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/20/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/21/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/22/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/23/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/24/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/25/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/26/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/27/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/28/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/29/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/30/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/31/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/32/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/33/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/34/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/35/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/36/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/37/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/38/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/39/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/40/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/41/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/42/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/43/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/44/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/45/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/46/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/47/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/48/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/49/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/50/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/51/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/52/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/53/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/54/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/55/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/56/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/57/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/58/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/59/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/60/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/61/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/62/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps-buckets/63/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
# END GENERATED DEPS BUCKET LAYERS
COPY --link --from=install --chown=1000:1000 \
  /opt/actions-runner/_hobo_work/deps/ \
  /opt/actions-runner/_hobo_work/HoBo/HoBo/
USER 1000:1000
WORKDIR /opt/actions-runner/_hobo_work/HoBo/HoBo
