# The jcode operator runner.
#
# On credential containment, stated as it actually is rather than as intended.
# The SDK's launch() takes no uid and spawns the bridge with
# {...process.env, ...options.env}, so jcode runs as THIS process's user with
# THIS process's environment. There is no root/agent split at the process level,
# and the `agent` account below only owns files.
#
# What keeps AGENT_RUNNER_SECRET away from the harness is therefore the explicit
# scrub in jcode-driver.mjs (scrubbedHostEnv), which blanks every sensitive name
# in the env handed to launch(). That is a single function, so it is covered by
# tests that fail loudly if it stops working — do not remove them.
#
# If jcode ever gains a uid option, run it as `agent` and treat the scrub as
# defence in depth rather than the only wall.
FROM node:22-bookworm-slim

# git is here for M14c, which materialises a shallow repo into the workspace.
# ca-certificates is needed to reach OpenRouter and the control plane, and
# nothing else: egress is expected to be restricted to those two hosts at the
# platform level. See README.md.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/agent-runner

# The jcode binary arrives as an optional platform dependency of the SDK
# (@1jehuang/jcode-linux-x64), so there is no install script to curl and no
# unpinned download at build time. `npm ci` is the whole supply chain.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY server.mjs jcode-driver.mjs platform-mcp.mjs workspace.mjs ./

# The unprivileged account the harness itself runs under.
RUN useradd --system --create-home --uid 10001 --user-group agent \
 && mkdir -p /var/lib/code92-agent-runner \
 && chown -R agent:agent /var/lib/code92-agent-runner

ENV NODE_ENV=production \
    PORT=8080 \
    JCODE_DATA_DIR=/var/lib/code92-agent-runner \
    AGENT_UID=10001 \
    AGENT_GID=10001 \
    MAX_CONCURRENT_RUNS=1

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
