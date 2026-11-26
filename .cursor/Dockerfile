# Cursor Cloud Agent image for HoBo.
# Node base + mise (project tools) + optional Grok/Kimi CLIs.
# Do not COPY the repo; Cursor checks it out separately.
FROM node:24-bookworm

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.local/bin:/usr/local/bin:${PATH}"
RUN curl -fsSL https://mise.run | sh

# Grok Build CLI (tier-1 coding agent).
ENV GROK_BIN_DIR=/usr/local/bin
RUN curl -fsSL https://x.ai/cli/install.sh | bash \
  && /usr/local/bin/grok --version

# Kimi Code CLI (tier-2 fallback when the Grok weekly limit is exceeded).
ARG KIMI_CODE_VERSION=2.1.1
RUN npm install -g "@moonshot-ai/kimi-code@${KIMI_CODE_VERSION}" \
  && kimi --version

USER node
ENV PATH="/home/node/.local/bin:${PATH}"
RUN curl -fsSL https://mise.run | sh
