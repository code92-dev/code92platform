import {createServer} from 'node:http';
import {chown, mkdir, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const config = {
  port: Number(process.env.PORT || 8080),
  runtimeUrl: process.env.AGENT_RUNTIME_URL || '',
  runnerSecret: process.env.AGENT_RUNNER_SECRET || '',
  runnerId: process.env.AGENT_RUNNER_ID || `runner-${process.pid}`,
  fxBinary: process.env.FX_BINARY || 'fx',
  fxModel: process.env.FX_MODEL || '',
  agentUid: Number(process.env.AGENT_UID || 0),
  agentGid: Number(process.env.AGENT_GID || 0),
  dataDir: resolve(process.env.FX_DATA_DIR || '/var/lib/code92-agent-runner'),
  maxConcurrentRuns: Math.max(1, Math.min(Number(process.env.MAX_CONCURRENT_RUNS || 1), 4)),
};

const activeRuns = new Set();

function configured() {
  return Boolean(config.runtimeUrl && config.runnerSecret && existsSync(config.fxBinary));
}

function agentProcessOptions() {
  // In production the HTTP control plane stays root-owned while fx runs as a
  // different unprivileged account. That stops terminal tools from reading the
  // runner process's environment (which contains its runner secret). Local
  // development and tests omit these values and keep the current user.
  if (process.getuid?.() === 0 && Number.isInteger(config.agentUid) && config.agentUid > 0) {
    return {uid: config.agentUid, gid: config.agentGid || config.agentUid};
  }
  return {};
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
  if (!response.ok || body?.error) throw new Error(body?.error?.message || `runtime ${action} failed (${response.status})`);
  return body;
}

function processOutput(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.asAgent ? agentProcessOptions() : {}),
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const limit = 1_000_000;
    const collect = (target, chunk) => (target.length >= limit ? target : `${target}${chunk.toString('utf8').slice(0, limit - target.length)}`);
    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, options.timeoutMs ?? 240_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({code: code ?? 1, signal, stdout, stderr, timedOut});
    });
  });
}

async function usage(env, cwd) {
  const result = await processOutput(config.fxBinary, ['usage', '--json'], {env, cwd, timeoutMs: 20_000});
  if (result.code !== 0) return {spend: null};
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return {spend: typeof parsed?.totals?.spend === 'number' ? parsed.totals.spend : null};
  } catch {
    return {spend: null};
  }
}

async function prepareFxHome(claim) {
  const agentDir = join(config.dataDir, 'agents', claim.agent_id);
  const homeDir = join(agentDir, 'home');
  const workspace = join(agentDir, 'workspaces', claim.channel_id, claim.thread_root_id || 'channel');
  await mkdir(join(homeDir, '.fx'), {recursive: true});
  await mkdir(workspace, {recursive: true});

  const settings = {
    model: claim.model || config.fxModel,
    permission_mode: 'auto',
    max_agent_steps: claim.max_tool_steps,
    max_tool_result_bytes: 65536,
    auto_upgrade: false,
    notifications: {turn_end: false, attention_required: false, max: false},
  };
  const mcp = {
    mcp: {
      code92_platform: {
        type: 'stdio',
        command: ['node', join(moduleDir, 'platform-mcp.mjs')],
        enabled: true,
        required: false,
        environment: {
          FX_RUNTIME_URL: config.runtimeUrl,
          FX_RUN_CAPABILITY_TOKEN: claim.capability_token,
          FX_RUN_ID: claim.run_id,
        },
      },
    },
  };
  await writeFile(join(homeDir, '.fx', 'settings.json'), JSON.stringify(settings), {mode: 0o600});
  await writeFile(join(homeDir, '.fx', 'mcp.json'), JSON.stringify(mcp), {mode: 0o600});
  if (process.getuid?.() === 0 && Number.isInteger(config.agentUid) && config.agentUid > 0) {
    const gid = config.agentGid || config.agentUid;
    await Promise.all([
      chown(agentDir, config.agentUid, gid),
      chown(homeDir, config.agentUid, gid),
      chown(join(homeDir, '.fx'), config.agentUid, gid),
      chown(join(homeDir, '.fx', 'settings.json'), config.agentUid, gid),
      chown(join(homeDir, '.fx', 'mcp.json'), config.agentUid, gid),
      chown(workspace, config.agentUid, gid),
    ]);
  }
  return {homeDir, workspace};
}

function summariseTools(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.slice(0, 50).map((tool) => ({
    name: typeof tool?.name === 'string' ? tool.name.slice(0, 120) : 'unknown',
    status: typeof tool?.status === 'string' ? tool.status.slice(0, 30) : 'unknown',
  }));
}

function extractBackgroundJobs(value) {
  const candidates = Array.isArray(value)
    ? value
    : value?.background ?? value?.backgrounds ?? value?.processes ?? value?.commands ?? [];
  if (!Array.isArray(candidates)) return [];
  return candidates.slice(0, 20).flatMap((job) => {
    const id = typeof job?.id === 'string' ? job.id : typeof job?.background_id === 'string' ? job.background_id : '';
    if (!id) return [];
    const rawState = String(job?.state ?? job?.status ?? 'running').toLowerCase();
    const state = rawState.includes('success') || rawState === 'exited'
      ? 'succeeded'
      : rawState.includes('fail') || rawState.includes('error') ? 'failed'
        : rawState.includes('cancel') || rawState.includes('stop') ? 'cancelled' : 'running';
    return [{
      id,
      state,
      command_summary: String(job?.command ?? job?.summary ?? 'background command').slice(0, 500),
      error: job?.error ? String(job.error).slice(0, 500) : undefined,
    }];
  });
}

async function executeRun(runId) {
  let claimed = false;
  let heartbeat;
  try {
    const claim = await runtime('claim', {run_id: runId});
    if (!claim.claimed) return;
    claimed = true;
    if (typeof claim.gateway_api_key !== 'string' || claim.gateway_api_key.length < 20) {
      throw new Error('run was claimed without a Vercel AI Gateway key');
    }
    // `fx ask` can spend most of a run in a tool call. Renew independently of
    // stdout so the capability cannot expire halfway through a valid job.
    heartbeat = setInterval(() => {
      void runtime('event', {run_id: runId, phase: 'executing', event_type: 'heartbeat', detail: {}})
        .catch((error) => console.error('agent runner heartbeat failed', runId, error.message));
    }, 60_000);
    heartbeat.unref();
    const {homeDir, workspace} = await prepareFxHome(claim);
    const env = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: homeDir,
      // The access key is supplied only by the authenticated control plane for
      // this claimed run. It is neither a process-level compute secret nor a
      // durable fx setting, so key rotation takes effect on the next run.
      AI_GATEWAY_API_KEY: claim.gateway_api_key,
      FX_MODEL: claim.model || config.fxModel,
      FX_MAX_AGENT_STEPS: String(claim.max_tool_steps),
      FX_PERMISSION_MODE: 'auto',
      FX_AUTO_UPGRADE: '0',
      FX_NO_OPEN_BROWSER: '1',
      LANG: 'C.UTF-8',
    };
    await runtime('event', {run_id: runId, phase: 'executing', event_type: 'fx_started', detail: {model: env.FX_MODEL, max_steps: claim.max_tool_steps}});
    const provider = await processOutput(config.fxBinary, ['provider', 'gateway'], {env, cwd: workspace, timeoutMs: 20_000, asAgent: true});
    if (provider.code !== 0) throw new Error(provider.stderr.slice(-500) || 'could not select the AI Gateway provider');
    const before = await usage(env, workspace);
    const args = ['ask', '--auto', '--json'];
    if (claim.fx_session_id) args.push('--resume-id', claim.fx_session_id);
    args.push(claim.prompt);
    const result = await processOutput(config.fxBinary, args, {env, cwd: workspace, timeoutMs: claim.max_run_seconds * 1000, asAgent: true});
    const after = await usage(env, workspace);
    if (result.timedOut) throw new Error(`fx exceeded its ${claim.max_run_seconds}s run limit`);
    let fxResult;
    try {
      fxResult = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error(`fx returned invalid JSON: ${result.stderr.slice(-300) || result.stdout.slice(-300)}`);
    }
    if (result.code !== 0 || fxResult.exit_code !== 0 || typeof fxResult.output !== 'string') {
      throw new Error(fxResult?.error || result.stderr.slice(-500) || `fx exited with ${result.code}`);
    }
    const background = await processOutput(config.fxBinary, ['background', '--json'], {env, cwd: workspace, timeoutMs: 20_000, asAgent: true});
    if (background.code === 0) {
      try {
        const jobs = extractBackgroundJobs(JSON.parse(background.stdout.trim()));
        if (jobs.length) await runtime('jobs', {run_id: runId, jobs});
      } catch {
        // Background support is opportunistic; a bad status payload cannot lose the reply.
      }
    }
    const cost = before.spend !== null && after.spend !== null ? Math.max(0, after.spend - before.spend) : null;
    await runtime('event', {run_id: runId, phase: 'finalizing', event_type: 'fx_finished', detail: {tools: summariseTools(fxResult.tool_calls)}});
    await runtime('finalize', {
      run_id: runId,
      output: fxResult.output,
      fx_session_id: fxResult.session_id || null,
      usage: {
        input_tokens: fxResult?.usage?.input_tokens ?? null,
        output_tokens: fxResult?.usage?.output_tokens ?? null,
        cost_usd: cost,
      },
      tool_summary: summariseTools(fxResult.tool_calls),
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(res, configured() ? 200 : 503, {
      ok: configured(),
      active_runs: activeRuns.size,
      capacity: config.maxConcurrentRuns,
      fx_binary: config.fxBinary,
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
    if (activeRuns.has(runId)) return json(res, 202, {accepted: true, duplicate: true});
    if (activeRuns.size >= config.maxConcurrentRuns) return json(res, 429, {error: 'runner is at capacity'});
    activeRuns.add(runId);
    void executeRun(runId);
    return json(res, 202, {accepted: true});
  } catch (error) {
    return json(res, 400, {error: error instanceof Error ? error.message : 'bad request'});
  }
});

await mkdir(config.dataDir, {recursive: true});
server.listen(config.port, '0.0.0.0', () => {
  console.log(`agent runner listening on ${config.port}`);
});
