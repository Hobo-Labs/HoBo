# syntax=docker/dockerfile:1
# Digest pinned for reproducible devcontainer builds (Node 24 + corepack in post-create).
FROM mcr.microsoft.com/devcontainers/javascript-node:24-bookworm@sha256:447fa75fbc7123952284b50229148e933ea756c40718601fa0ec46edd29fd0c6
USER root
# Official Actions runner runtime dependencies; no runtime sudo/install step.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      printf 'Acquire::https::CaInfo "/run/secrets/proxy_ca";\n' > /etc/apt/apt.conf.d/99-build-proxy-ca; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
    libicu72 liblttng-ust1 libkrb5-3 libssl3 zlib1g util-linux \
    && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99-build-proxy-ca
USER node
