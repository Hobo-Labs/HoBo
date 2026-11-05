# syntax=docker/dockerfile:1.19
ARG TOOLCHAIN_IMAGE=hobo-ci-worker:local

FROM ${TOOLCHAIN_IMAGE} AS fetch
USER root
RUN mkdir -p /pnpm-store /opt/actions-runner/_hobo_work/HoBo/HoBo /opt/hobo-deps /opt/hobo-deps-buckets \
  && chown -R 1000:1000 /pnpm-store /opt/actions-runner/_hobo_work /opt/hobo-deps /opt/hobo-deps-buckets
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
    'set -e; for source do target="/opt/hobo-deps/${source#./}"; mkdir -p "$(dirname "$target")"; mv "$source" "$target"; done' sh {} + \
  && node --experimental-strip-types scripts/ci/deps-layer-buckets.mts partition \
    /opt/hobo-deps \
    /opt/hobo-deps-buckets \
  && find /opt/hobo-deps /opt/hobo-deps-buckets \
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
USER root
RUN install -d -o 1000 -g 1000 /opt/hobo-deps \
  && printf '%s\n' "$DEPS_KEY" > /opt/hobo-deps/.hobo-ci-deps-key \
  && chown 1000:1000 /opt/hobo-deps/.hobo-ci-deps-key
# BEGIN GENERATED DEPS BUCKET LAYERS: scripts/ci/deps-layer-buckets.mts
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/00/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/01/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/02/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/03/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/04/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/05/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/06/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/07/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/08/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/09/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/10/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/11/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/12/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/13/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/14/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/15/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/16/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/17/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/18/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/19/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/20/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/21/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/22/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/23/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/24/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/25/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/26/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/27/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/28/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/29/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/30/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/31/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/32/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/33/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/34/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/35/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/36/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/37/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/38/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/39/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/40/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/41/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/42/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/43/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/44/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/45/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/46/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/47/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/48/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/49/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/50/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/51/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/52/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/53/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/54/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/55/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/56/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/57/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/58/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/59/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/60/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/61/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/62/ \
  /opt/hobo-deps/
COPY --link --from=install --chown=1000:1000 \
  /opt/hobo-deps-buckets/63/ \
  /opt/hobo-deps/
# END GENERATED DEPS BUCKET LAYERS
COPY --from=install --chown=1000:1000 /opt/hobo-deps/ /opt/hobo-deps/
RUN chown 1000:1000 /opt/hobo-deps /opt/hobo-deps/node_modules /opt/hobo-deps/node_modules/.pnpm
USER 1000:1000
