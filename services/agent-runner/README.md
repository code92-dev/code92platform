# Code 92 jcode runner

The execution service for agents whose `runtime` is `jcode`. Deliberately
separate from the InsForge edge functions: a harness run needs a workspace, a
terminal and minutes of wall clock, none of which a Deno edge function has,
while the edge function keeps the platform API key and all write authority.

## What it is allowed to do

Nothing directly. The runner holds no InsForge key. It claims a run through
`functions/agent-runtime.ts` with a shared secret, and the *agent* reads the
platform through an MCP server carrying a capability token scoped to that one
run and valid only while its lease is live.

A turn ends as a message plus rows in `agent_proposals`. The runner cannot
write a platform record and neither can the model. Approval happens later, in
`decide_agent_proposal`, under a human's own authority — the same boundary the
conversational agents have had since M13c, unchanged by adding a harness.

### Trust boundary inside the container

The HTTP control plane and jcode run in the same container, but jcode receives
no shell or runner credential. The structured file tools are intentionally
limited to the materialised workspace; without a shell the model cannot turn
the process environment or network stack into an exfiltration API.

The OpenRouter key is necessarily reachable by jcode during an active run. It is
fetched from `openrouter_connection` for one claimed run and passed as an
environment variable to that process — it is not a compute-service secret and it
is not written to disk. Use the same capped key the rest of the platform uses;
that is the entire point of this runtime choosing a harness that reads
`OPENROUTER_API_KEY` natively.

### Tools

The operator profile gets `read`, `write`, `edit`, `apply_patch`, `grep`, `glob`,
`ls` — an explicit allow-list, not a named profile, so a jcode release cannot
widen the sandbox. It does not get a shell: repository changes use structured
file tools and become proposals. `web_search`, `web_fetch`, `browser`,
`integration` and `swarm` are denied outright: an agent that has read a private
repository must not also hold the means to post it somewhere. Research agents
stay on the OpenRouter runtime, where there is no workspace to exfiltrate.

## Required environment

| Variable | Purpose |
| --- | --- |
| `AGENT_RUNTIME_URL` | `https://<appkey>.<region>.insforge.app/functions/agent-runtime` |
| `AGENT_RUNNER_SECRET` | Random shared secret, used only between the runner and the edge functions |
| `AGENT_RUNNER_ID` | Optional stable runner identity, recorded as the lease owner |
| `MAX_CONCURRENT_RUNS` | Optional, 1–4, defaults to 1 |
| `POLL_INTERVAL_SECONDS` | Seconds between queue checks. Unset or `0` disables polling |
| `POLL_IDLE_SECONDS` | Ceiling the poll interval backs off to while idle. Defaults to 60 |
| `BIND_HOST` | Listen address. Defaults to loopback when polling, `0.0.0.0` otherwise |

`PORT`, `JCODE_DATA_DIR`, `AGENT_UID` and `AGENT_GID` are set by the image.

Keep `MAX_CONCURRENT_RUNS=1` unless you have a reason not to. Cost is
reconciled by diffing OpenRouter's key ledger across a run, which is exact only
while one run holds the key at a time. Above one, `agent_runs.cost_usd` becomes
an apportioned estimate and `budget_usd_month` is enforced against that estimate.

## Egress

Restrict outbound traffic to two hosts:

- `openrouter.ai` — the model
- the InsForge functions host — the control plane

Everything else should be blocked. The container has `git` for the repo
materialisation added in M14c, but the agent never authenticates to GitHub: the
repository arrives as a tarball streamed by the control plane, which is the only
thing holding the org PAT.

## How work reaches the runner

Two wirings. They are not exclusive — both end in the same claim, and the claim
is what settles the race — but on most hosts you want exactly one.

### Pull (recommended, and the only option on a VPS behind NAT)

Set `POLL_INTERVAL_SECONDS`. The runner asks the control plane for pending runs
over its existing outbound connection.

**Nothing reaches this machine from the internet.** No DNS record, no TLS
certificate, no open port, no firewall rule. The runner binds `/healthz` to
loopback and that is the whole listening surface.

Cost is one function invocation per poll, so the interval backs off while the
queue is empty — `POLL_INTERVAL_SECONDS=5` with `POLL_IDLE_SECONDS=60` is about
1,500 calls on a quiet day and 5-second latency on a busy one, on work that
takes minutes either way.

### Push

Leave `POLL_INTERVAL_SECONDS` unset and store this runner's public HTTPS URL as
the `AGENT_RUNNER_URL` InsForge secret. `thread-agent` then pings `/dispatch`
the moment a run is queued.

This needs the runner reachable from InsForge's edge functions, whose egress
addresses are not stable enough to allowlist — so the port is open to everyone
and a bearer secret is the only thing in front of it. Worth it for the few
seconds of latency only when the host is already a private service on the same
network, which is what the InsForge compute-service path gives you.

`GET /healthz` reports which mode is live as `mode`. A runner with polling off
and no reachable dispatch URL is healthy and idle forever; that field is how you
notice.

## Deploy on a VPS

```bash
git clone <this repo> && cd services/agent-runner
cp .env.example .env
openssl rand -hex 32              # → AGENT_RUNNER_SECRET, into .env
docker compose up -d
docker compose logs -f runner     # expect "polling every 5s"
```

### On your workstation, not the runner host

Everything in this section talks to InsForge and belongs on the machine where
you develop — the one already logged into the CLI. The runner host needs none
of it: it holds no InsForge key, authenticates with `AGENT_RUNNER_SECRET`
alone, and never calls the CLI. Logging the CLI in over a headless SSH session
cannot work anyway, because its OAuth redirect targets a loopback port on the
box running the browser.

Set the InsForge secrets:

| Secret | Value |
| --- | --- |
| `AGENT_RUNNER_SECRET` | the same value as in `.env` |
| `AGENT_REPO_SECRET` | `openssl rand -hex 32`, shared by `agent-runtime` and `github-sync` |
| `AGENT_RUNNER_URL` | **only if pushing** — omit entirely when polling |

…and redeploy the three functions that read them:

```bash
npx @insforge/cli functions deploy agent-runtime --file functions/agent-runtime.ts
npx @insforge/cli functions deploy github-sync   --file functions/github-sync.ts
npx @insforge/cli functions deploy thread-agent  --file functions/thread-agent.ts
```

Only then set one low-budget agent's runtime to **jcode harness** in Settings
and mention it in a non-DM channel.

### Locking down egress

The container should reach two hosts, plus `codeload.github.com` for repository
archives. With Docker the practical place to enforce this is the host firewall
against the container's subnet, or a user-defined network with an egress proxy.

```bash
# Outbound allow-list on the host, applied to Docker's forward chain.
sudo iptables -I DOCKER-USER -d 127.0.0.0/8 -j RETURN
sudo iptables -A DOCKER-USER -p tcp --dport 443 -m string --algo bm \
  --string "openrouter.ai" -j RETURN
# …repeat for your InsForge functions host and codeload.github.com, then:
sudo iptables -A DOCKER-USER -j DROP
```

Treat that as the shape rather than the recipe — SNI matching is brittle and an
egress proxy such as Squid with an allow-list is the sturdier version. The
important property is that the harness runs untrusted model output next to a
private repository with structured file tools only, and should not be able to
reach a host nobody chose.

### Without Docker

`node server.mjs` under systemd works the same way. Run it as a dedicated
unprivileged user, set `JCODE_DATA_DIR` somewhere that user owns, and prefer
the container for filesystem and egress policy. The harness still receives no
shell, and sensitive environment names are scrubbed before the bridge starts.

Never scale this to zero and never let the host sleep. A claimed run holds a
five-minute lease that its runner renews; a machine that vanishes mid-run leaves
the run to expire and be reclaimed, which is survivable but wasteful.

## Local verification

```bash
npm install
npm test
docker build -t code92-agent-runner:local .
docker run --rm -p 8080:8080 \
  -e AGENT_RUNTIME_URL=https://example.invalid/functions/agent-runtime \
  -e AGENT_RUNNER_SECRET=local-only \
  code92-agent-runner:local
curl http://localhost:8080/healthz
```

The tests drive the claim → progress → finalize protocol against a fake control
plane and a fake turn. They deliberately do not call a model: what can break
here is the protocol, and asserting on plumbing should not cost money.
