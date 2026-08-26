# Code 92 native fx runner

This is the long-running execution service for agents whose runtime is set to
`fx`. It is intentionally separate from the InsForge edge functions: `fx` can
use web search, terminal tools, MCP, and background commands, while the edge
function retains the platform API key and all platform write authority.

## Trust boundary

The runner receives a run id from `thread-agent`, atomically claims it through
`agent-runtime`, and receives a short-lived, hashed capability. Its MCP server
can read only the originating channel and its bound product. It cannot write
platform records; a reply can create proposals only, and people approve those
through the existing database gate.

Inside the production image, the HTTP control plane runs as root and `fx` runs
as the separate `agent` user. This prevents terminal tools from reading the
runner process environment, including `AGENT_RUNNER_SECRET`. The AI Gateway
credential is necessarily available to `fx` during an active run. It is fetched
from Code92's encrypted admin connection for that one claimed run; it is not a
compute-service environment variable. Use a dedicated Vercel AI Gateway key
with an explicit spend limit, never a personal Codex login or the platform's
OpenRouter key.

## Required environment

| Variable | Purpose |
| --- | --- |
| `AGENT_RUNTIME_URL` | `https://<appkey>.<region>.insforge.app/functions/agent-runtime` |
| `AGENT_RUNNER_SECRET` | Random shared secret used only between runner and edge functions |
| `AGENT_RUNNER_ID` | Optional stable runner identity for leases |
| `MAX_CONCURRENT_RUNS` | Optional, 1–4; defaults to 1 |

`PORT`, `FX_BINARY`, `FX_DATA_DIR`, `AGENT_UID`, and `AGENT_GID` are already
provided by the Docker image.

## Deploy and activate

1. Generate one random `AGENT_RUNNER_SECRET`; store the same value as an
   InsForge secret and as the compute-service environment variable.
2. Deploy this directory as an always-on InsForge compute service on port 8080
   with the required environment. Set `AGENT_RUNTIME_URL` to the production
   function URL above.
3. Store the compute service's private HTTPS URL as `AGENT_RUNNER_URL` in
   InsForge, then redeploy `thread-agent` and `agent-runtime`.
4. In **Settings → Vercel AI Gateway**, save a dedicated Gateway API key with
   a spend limit. Configure and test your OpenAI, Anthropic, or other provider
   credential in Vercel **AI Gateway → Bring Your Own Key (BYOK)**. Code92
   never receives that provider credential.
5. Check `GET /healthz` returns `{"ok":true}`. Only then change one low-budget
   agent to runtime **Native fx harness** in Settings and mention it in a
   non-DM channel.

Keep `MAX_CONCURRENT_RUNS=1` for the first canary. The runner keeps workspaces
per agent/channel/thread, renews its five-minute run lease every minute, and
records progress, tools, background jobs, cost, and failures in the platform.

## Local verification

```bash
npm test
docker build -t code92-agent-runner:local .
docker run --rm -p 8080:8080 \
  -e AGENT_RUNTIME_URL=https://example.invalid/functions/agent-runtime \
  -e AGENT_RUNNER_SECRET=local-only \
  code92-agent-runner:local
curl http://localhost:8080/healthz
```

The test suite uses a fake fx binary and a fake control plane; it proves the
claim → event → background-job → finalize flow without calling a model provider.
