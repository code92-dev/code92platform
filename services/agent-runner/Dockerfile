FROM node:22-bookworm-slim

ARG FX_VERSION=0.0.5
ARG FX_SHA256=d5639d173267774aa8228a474baf619a7076ac41a91023915007c865143429b1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL "https://github.com/vercel-labs/fx/releases/download/v${FX_VERSION}/fx-linux-x86_64.tar.gz" -o /tmp/fx.tar.gz \
  && echo "${FX_SHA256}  /tmp/fx.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/fx.tar.gz -C /usr/local/bin \
  && chmod 0755 /usr/local/bin/fx \
  && rm /tmp/fx.tar.gz \
  && useradd --create-home --uid 10001 runner \
  && useradd --create-home --uid 10002 agent

WORKDIR /app
COPY package.json server.mjs platform-mcp.mjs ./
RUN mkdir -p /var/lib/code92-agent-runner \
  && chown -R runner:runner /app /var/lib/code92-agent-runner

ENV NODE_ENV=production \
  PORT=8080 \
  FX_BINARY=/usr/local/bin/fx \
  FX_DATA_DIR=/var/lib/code92-agent-runner \
  AGENT_UID=10002 \
  AGENT_GID=10002 \
  FX_AUTO_UPGRADE=0 \
  FX_NO_OPEN_BROWSER=1

EXPOSE 8080
CMD ["node", "server.mjs"]
