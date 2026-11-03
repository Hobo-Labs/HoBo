# syntax=docker/dockerfile:1.19
# Reuses the hobo-cli candidate image (build hobo-cli first in CI).
ARG HOBO_CLI_CANDIDATE=hobo-cli:candidate
ARG HOBO_TOOLCHAIN_IMAGE=hobo-ci-worker:local

FROM ${HOBO_CLI_CANDIDATE} AS cli

FROM ${HOBO_TOOLCHAIN_IMAGE} AS runtime
ENV NODE_ENV=production HOBO_HOME=/home/hobo/.hobo
WORKDIR /home/hobo
USER 1000:1000
COPY --from=cli --chown=1000:1000 /home/hobo/app /home/hobo/app
ENV PATH="/home/hobo/app/node_modules/.bin:${PATH}"
VOLUME ["/home/hobo/.hobo"]
ENTRYPOINT ["hobo-mcp"]
CMD []
