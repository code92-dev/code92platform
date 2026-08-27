// The runner: an HTTP control plane that claims agent runs and executes them.
//
// It holds no InsForge key. Everything it is allowed to do it does through
// functions/agent-runtime.ts, authenticated with a shared runner secret, and
// everything the *agent* is allowed to read it reads through a capability
// token scoped to one run. The runner cannot write a platform record and
// neither can the model: a turn ends as a message plus proposals, and a
// proposal becomes a change only when a human approves it.
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runJcodeTurn} from './jcode-driver.mjs';
import {REPO_DIR, materialiseRepo} from './workspace.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));

// The harness driver is held in a binding rather than called directly so the
// tests can prove the claim → progress → finalize protocol against a fake
// turn. Exercising that flow for real would mean spending money on a model to
// assert on plumbing.
let driver = runJcodeTurn;

const config = {
  port: Number(process.env.PORT || 8080),
  runtimeUrl: process.env.AGENT_RUNTIME_URL || '',
  runnerSecret: process.env.AGENT_RUNNER_SECRET || '',
  runnerId: process.env.AGENT_RUNNER_ID || `runner-${process.pid}`,
  agentUid: Number(process.env.AGENT_UID || 0),
  agentGid: Number(process.env.AGENT_GID || 0),
  dataDir: resolve(process.env.JCODE_DATA_DIR || '/var/lib/code92-agent-runner'),
  // Capped at 4, defaulting to 1. Above one concurrent run the cost
  // reconciliation in agent-runtime.ts — which diffs OpenRouter's key ledger
  // across a run — stops being exact, because two runs share one ledger.
  maxConcurrentRuns: Math.max(1, Math.min(Number(process.env.MAX_CONCURRENT_RUNS || 1), 4)),
  // Seconds between queue checks. 0 disables polling entirely, which is right
  // when the platform can reach this runner directly and wrong the moment it
  // cannot — a runner behind NAT with polling off will never do any work.
  pollSeconds: Math.max(0, Number(process.env.POLL_INTERVAL_SECONDS ?? 0)),
  // How far the interval backs off while the queue keeps coming up empty.
  // Every poll is a billed function invocation, and a runner nobody is talking
  // to should not cost the same as a busy one.
  pollIdleSeconds: Math.max(0, Number(process.env.POLL_IDLE_SECONDS ?? 60)),
};

const activeRuns = new Set();

function configured() {
  return Boolean(config.runtimeUrl && config.runnerSecret);
}

function json(res, status, body) {
  res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(body));
}

async function readRequest(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error('request is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('request must be JSON');
  }
}

async function runtime(action, payload) {
  const response = await fetch(config.runtimeUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.runnerSecret}`,
      'X-Agent-Runner-Id': config.runnerId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({action, ...payload}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error) {
    throw new Error(body?.error?.message || `runtime ${action} failed (${response.status})`);
  }
  return body;
}

// Per agent, per channel, per thread. Not per run: the point of a stable path
// is that a follow-up in the same thread finds the workspace the previous turn
// left behind. Not shared across channels either — a workspace carries files
// the agent was shown, and one room's material must not be sitting in another
// room's working directory.
function pathsFor(claim) {
  const agentDir = join(config.dataDir, 'agents', claim.agent_id);
  return {
    // jcode binds its API socket at $HOME/run/jcode-api.sock, and a Unix socket
    // path cannot exceed SUN_LEN (108 bytes on Linux) — a limit that has nothing
    // to do with the filesystem and fails at bind() with a bare errno. A full
    // agent UUID plus a readable directory name is enough to cross it, so the
    // home is keyed by a short digest instead. Workspaces keep the readable ids:
    // no socket is bound there, so only the ordinary path limit applies.
    jcodeHome: join(config.dataDir, 'h', shortKey(claim.agent_id)),
    workspace: join(agentDir, 'workspaces', claim.channel_id, claim.thread_root_id || 'channel'),
  };
}

// Short, stable, and collision-resistant enough for a per-agent directory: 48
// bits over a set of agents that is small by construction.
function shortKey(id) {
  return createHash('sha256').update(String(id)).digest('hex').slice(0, 12);
}

// The longest socket path this runner can ever produce, checked once at startup
// rather than discovered on the first run. jcodeHome is fixed-width by
// construction, so this is exact.
const JCODE_SOCKET_SUFFIX = '/run/jcode-api.sock';
const SUN_LEN = 108;

function socketPathBudget() {
  const sample = join(config.dataDir, 'h', 'x'.repeat(12)) + JCODE_SOCKET_SUFFIX;
  return {path: sample, length: Buffer.byteLength(sample), limit: SUN_LEN};
}

async function executeRun(runId) {
  let claimed = false;
  let heartbeat;
  try {
    const claim = await runtime('claim', {run_id: runId});
    if (!claim.claimed) return;
    claimed = true;

    if (typeof claim.openrouter_api_key !== 'string' || claim.openrouter_api_key.length < 20) {
      throw new Error('run was claimed without an OpenRouter key');
    }

    // A turn can spend minutes inside one tool call. The lease is renewed on a
    // timer rather than on output, so a legitimately slow run cannot have its
    // capability expire underneath it and be reclaimed by another runner.
    heartbeat = setInterval(() => {
      void runtime('event', {run_id: runId, phase: 'executing', event_type: 'heartbeat', detail: {}})
        .catch((error) => console.error('agent runner heartbeat failed', runId, error.message));
    }, 60_000);
    heartbeat.unref();

    const {jcodeHome, workspace} = pathsFor(claim);
    await mkdir(workspace, {recursive: true});

    // The working tree, if this agent has one. Failing to materialise it is
    // reported and then survived: an operator agent that cannot read the repo
    // can still read the channel and say so, which is more useful than a run
    // that dies with a stack trace.
    let repoInfo = null;
    if (claim.repo?.url) {
      await runtime('event', {run_id: runId, phase: 'preparing', event_type: 'repo_fetch', detail: {repo: claim.repo.repo, ref: claim.repo.ref}});
      try {
        repoInfo = await materialiseRepo({workspace, repo: claim.repo});
        await runtime('event', {
          run_id: runId,
          phase: 'preparing',
          event_type: 'repo_ready',
          detail: {repo: repoInfo.repo, ref: repoInfo.ref, entries: repoInfo.entries, path: REPO_DIR},
        });
      } catch (error) {
        await runtime('event', {
          run_id: runId,
          phase: 'preparing',
          event_type: 'repo_failed',
          detail: {reason: error instanceof Error ? error.message : 'unknown'},
        });
      }
    }

    await runtime('event', {
      run_id: runId,
      phase: 'executing',
      event_type: 'jcode_started',
      detail: {model: claim.model, tool_profile: claim.tool_profile, resumed: Boolean(claim.jcode_session_id)},
    });

    // Progress is best-effort and deliberately un-awaited inside the event
    // callback: a slow control plane must not stall the model's turn, and a
    // dropped progress line is not worth failing a run for.
    const onProgress = (phase, eventType, detail) => {
      void runtime('event', {run_id: runId, phase, event_type: eventType, detail}).catch(() => {});
    };

    const timeoutMs = Math.max(30, Number(claim.max_run_seconds) || 240) * 1000;
    const turn = await Promise.race([
      driver({
        claim,
        workspace,
        repoInfo,
        jcodeHome,
        moduleDir,
        runtimeUrl: config.runtimeUrl,
        agentUid: config.agentUid,
        agentGid: config.agentGid,
        onProgress,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`jcode exceeded its ${claim.max_run_seconds}s run limit`)), timeoutMs).unref(),
      ),
    ]);

    if (typeof turn.output !== 'string' || !turn.output.trim()) {
      // Say why, when the bridge said why. A turn ends empty for reasons the
      // operator can act on — a rejected credential, an exhausted budget, a
      // model that refused — and all of them arrive as error events.
      const why = turn.errors?.length
        ? `: ${turn.errors.join('; ')}`
        : ' and reported no error (check the model slug and the OpenRouter key)';
      throw new Error(`jcode returned an empty turn${why}`);
    }

    if (turn.jobs?.length) {
      await runtime('jobs', {run_id: runId, jobs: turn.jobs}).catch((error) => {
        // Background bookkeeping is opportunistic. Losing it must not lose a
        // reply the model already produced.
        console.error('could not record background jobs', runId, error.message);
      });
    }

    await runtime('event', {
      run_id: runId,
      phase: 'finalizing',
      event_type: 'jcode_finished',
      detail: {tools: turn.toolSummary},
    });

    await runtime('finalize', {
      run_id: runId,
      output: turn.output,
      jcode_session_id: turn.sessionId,
      usage: {
        input_tokens: turn.usage?.input ?? null,
        output_tokens: turn.usage?.output ?? null,
      },
      tool_summary: turn.toolSummary,
    });
  } catch (error) {
    if (claimed) {
      try {
        await runtime('fail', {run_id: runId, error: error instanceof Error ? error.message : String(error)});
      } catch (failure) {
        console.error('could not record runner failure', runId, failure);
      }
    }
    console.error('agent runner failed', runId, error);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    activeRuns.delete(runId);
  }
}

// Pull, rather than wait to be pushed to.
//
// Both paths end in the same executeRun, and the claim inside it is what
// settles the race — so polling and dispatch can be enabled together with no
// coordination between them.
let pollTimer;
let pollDelay = 0;

async function pollOnce() {
  if (activeRuns.size >= config.maxConcurrentRuns) return false;

  const capacity = config.maxConcurrentRuns - activeRuns.size;
  const {runs} = await runtime('poll', {limit: capacity});
  if (!runs?.length) return false;

  for (const runId of runs) {
    if (activeRuns.size >= config.maxConcurrentRuns) break;
    if (activeRuns.has(runId)) continue;
    activeRuns.add(runId);
    void executeRun(runId);
  }
  return true;
}

function schedulePoll() {
  if (!config.pollSeconds) return;
  pollTimer = setTimeout(async () => {
    try {
      const found = await pollOnce();
      // Back to the fast interval the moment there is work, so a burst of
      // mentions is not answered at idle cadence.
      pollDelay = found
        ? config.pollSeconds
        : Math.min(Math.max(pollDelay * 2, config.pollSeconds), config.pollIdleSeconds);
    } catch (error) {
      // A control plane that is down or redeploying is a normal condition, not
      // a reason to stop polling. Back off and keep asking.
      pollDelay = Math.min(Math.max(pollDelay * 2, config.pollSeconds), config.pollIdleSeconds);
      console.error('agent runner poll failed', error.message);
    }
    schedulePoll();
  }, Math.max(pollDelay, config.pollSeconds) * 1000);
  pollTimer.unref();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(res, configured() ? 200 : 503, {
      ok: configured(),
      active_runs: activeRuns.size,
      capacity: config.maxConcurrentRuns,
      runner_id: config.runnerId,
      // So an operator can see at a glance which wiring is live. A runner with
      // neither polling nor a reachable dispatch URL looks healthy and does
      // nothing, which is the failure this line exists to make obvious.
      mode: config.pollSeconds ? `poll:${config.pollSeconds}s` : 'dispatch-only',
    });
  }

  if (req.method !== 'POST' || url.pathname !== '/dispatch') return json(res, 404, {error: 'not found'});

  const supplied = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!config.runnerSecret || supplied !== config.runnerSecret) return json(res, 401, {error: 'unauthorized'});
  if (!configured()) return json(res, 503, {error: 'runner is not configured'});

  try {
    const body = await readRequest(req);
    const runId = String(body?.run_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(runId)) return json(res, 400, {error: 'run_id must be a UUID'});
    // Dispatch is a ping, not a queue. The run is already durable in
    // agent_runs; a duplicate ping is a no-op and a full runner is a 429 that
    // leaves the run pending for the next tick to retry.
    if (activeRuns.has(runId)) return json(res, 202, {accepted: true, duplicate: true});
    if (activeRuns.size >= config.maxConcurrentRuns) return json(res, 429, {error: 'runner is at capacity'});
    activeRuns.add(runId);
    void executeRun(runId);
    return json(res, 202, {accepted: true});
  } catch (error) {
    return json(res, 400, {error: error instanceof Error ? error.message : 'bad request'});
  }
});

// Importing this module must not bind a port — the tests do exactly that.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await mkdir(config.dataDir, {recursive: true});

  // Refuse to start rather than fail at the first claim. A too-long JCODE_DATA_DIR
  // surfaces as "path must be shorter than SUN_LEN" from inside jcode, minutes
  // into a run that has already been claimed and charged for.
  const budget = socketPathBudget();
  if (budget.length > budget.limit) {
    throw new Error(
      `JCODE_DATA_DIR is too long: the jcode API socket would be ${budget.length} bytes ` +
        `(${budget.path}) and the limit is ${budget.limit}. Shorten JCODE_DATA_DIR by at ` +
        `least ${budget.length - budget.limit} characters.`,
    );
  }

  // Bind to loopback when polling, because nothing needs to reach this port
  // from outside — /healthz stays available to the host and to a container
  // health check. Binding publicly "just in case" is how a bearer-secret
  // endpoint ends up on the internet unnoticed.
  const host = config.pollSeconds ? (process.env.BIND_HOST || '127.0.0.1') : '0.0.0.0';
  server.listen(config.port, host, () => {
    console.log(
      `agent runner listening on ${host}:${config.port} as ${config.runnerId} ` +
        `(${config.pollSeconds ? `polling every ${config.pollSeconds}s` : 'dispatch only'})`,
    );
  });
  schedulePoll();
}

export {config, pathsFor, shortKey, socketPathBudget, executeRun, pollOnce, server};
export function __setDriver(fn) {
  driver = fn;
}
