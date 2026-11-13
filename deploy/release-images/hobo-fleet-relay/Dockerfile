# syntax=docker/dockerfile:1.19
# HoBo Fleet peer-to-peer relay (design §6.12, §6.16): iroh-relay 1.4.1, the
# release the pinned @number0/iroh binding is built against, downloaded from
# the iroh release and checked against pinned SHA-256 values (the same pins as
# .github/workflows/fleet-integration.yml). Configuration is a mounted
# iroh-relay.toml (deploy/fleet/relay/iroh-relay.toml). It needs no host OCI
# runtime and no build context.
ARG HOBO_TOOLCHAIN_IMAGE=hobo-ci-worker:local
ARG HOBO_RELEASE_VERSION=dev
ARG HOBO_RELEASE_REVISION=local

FROM ${HOBO_TOOLCHAIN_IMAGE} AS fetch
ARG TARGETARCH
ARG IROH_RELAY_VERSION=1.4.1
USER root
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
RUN case "${TARGETARCH:-$(uname -m)}" in \
      amd64|x86_64) target=x86_64-unknown-linux-musl; sum=75254641e3fad7fcbac6dee4d485556fbe06ef708340a9d8810469270ba626b8 ;; \
      arm64|aarch64) target=aarch64-unknown-linux-musl; sum=3fc0c2d67c1cd66250bf82f3e2f17a985b7081a3d272186bad9d63e3f2347b38 ;; \
      *) echo "no pinned iroh relay for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/iroh-relay.tar.gz \
      "https://github.com/n0-computer/iroh/releases/download/v${IROH_RELAY_VERSION}/iroh-relay-v${IROH_RELAY_VERSION}-${target}.tar.gz"; \
    echo "${sum}  /tmp/iroh-relay.tar.gz" | sha256sum -c -; \
    mkdir -p /out; \
    tar -xzf /tmp/iroh-relay.tar.gz -C /out ./iroh-relay; \
    chmod 0755 /out/iroh-relay

FROM ${HOBO_TOOLCHAIN_IMAGE}
ARG HOBO_RELEASE_VERSION
ARG HOBO_RELEASE_REVISION
LABEL org.opencontainers.image.title="HoBo Fleet relay" \
      org.opencontainers.image.description="Peer-to-peer relay for HoBo fleet devices (iroh-relay 1.4.1)" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${HOBO_RELEASE_VERSION}" \
      org.opencontainers.image.revision="${HOBO_RELEASE_REVISION}"
USER root
RUN mkdir -p /etc/hobo-fleet-relay
COPY --from=fetch /out/iroh-relay /usr/local/bin/iroh-relay
WORKDIR /etc/hobo-fleet-relay
EXPOSE 8443 8080 7842/udp
USER 1000:1000
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/iroh-relay"]
CMD ["--config-path", "/etc/hobo-fleet-relay/iroh-relay.toml"]
