# syntax=docker/dockerfile:1.19
# Reuses the hobo-cli candidate image (build hobo-cli first in CI).
ARG HOBO_CLI_CANDIDATE=hobo-cli:candidate
ARG HOBO_TOOLCHAIN_IMAGE=hobo-ci-worker:local
ARG HOBO_RELEASE_VERSION=dev
ARG HOBO_RELEASE_REVISION=local

FROM ${HOBO_CLI_CANDIDATE} AS cli

FROM ${HOBO_TOOLCHAIN_IMAGE}
ARG HOBO_RELEASE_VERSION
ARG HOBO_RELEASE_REVISION
ENV NODE_ENV=production HOBO_HOME=/home/hobo/.hobo
LABEL org.opencontainers.image.title="HoBo MCP server" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${HOBO_RELEASE_VERSION}" \
      org.opencontainers.image.revision="${HOBO_RELEASE_REVISION}"
WORKDIR /home/hobo
COPY --from=cli --chown=1000:1000 /home/hobo/app /home/hobo/app
USER root
RUN mkdir -p /home/hobo/.hobo && chown -R 1000:1000 /home/hobo
ENV PATH="/home/hobo/app/bin:/home/hobo/app/node_modules/.bin:${PATH}"
VOLUME ["/home/hobo/.hobo"]
USER 1000:1000
ENTRYPOINT ["hobo-mcp"]
CMD []
