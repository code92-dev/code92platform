// Proves the runner's contract with the platform without calling a model.
//
// What matters here is the protocol, not the prose a model would produce: that
// a run is claimed before anything else happens, that a failure is always
// reported rather than left to a lease timeout, and that the capability token
// reaches the MCP server and nowhere else.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createConnection} from 'node:net';
import {mkdtemp, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {__test__, scrubbedHostEnv} from '../jcode-driver.mjs';
import {pathsFor, socketPathBudget} from '../server.mjs';

const {
  OPERATOR_TOOLS,
  DENIED_TOOLS,
  toolsFor,
  createCollector,
  writeMcpConfig,
  createCapabilityBroker,
} = __test__;

test('the operator toolset never includes a tool that is also denied', () => {
  const overlap = OPERATOR_TOOLS.filter((tool) => DENIED_TOOLS.includes(tool));
  assert.deepEqual(overlap, [], 'a denied tool was also allow-listed');
});

test('only the operator profile gets tools that can change or execute things', () => {
  const operator = toolsFor('operator');
  assert.ok(operator.includes('write'));
  assert.ok(!operator.includes('bash'), 'the operator must not receive a shell');

  for (const profile of ['chat', 'research', undefined]) {
    const tools = toolsFor(profile);
    assert.ok(!tools.includes('bash'), `${profile} must not get bash`);
    assert.ok(!tools.includes('write'), `${profile} must not get write`);
    assert.ok(!tools.includes('apply_patch'), `${profile} must not get apply_patch`);
  }
});

test('the collector tallies tools, counts failures and keeps the last token usage', () => {
  const collector = createCollector();
  collector.observe({ev: 'tool_start', name: 'read', call_id: '1'});
  collector.observe({ev: 'tool_done', name: 'read', call_id: '1', output: 'ok'});
  collector.observe({ev: 'tool_start', name: 'read', call_id: '2'});
  collector.observe({ev: 'tool_done', name: 'read', call_id: '2', output: '', error: 'nope'});
  collector.observe({ev: 'tool_start', name: 'bash', call_id: '3'});
  collector.observe({ev: 'token_usage', input: 1200, output: 340});
  // Thousands of these arrive per run and none of them may be persisted.
  collector.observe({ev: 'text_delta', text: 'hello'});

  const {toolSummary, usage} = collector.result();
  assert.deepEqual(
    [...toolSummary].sort((a, b) => a.tool.localeCompare(b.tool)),
    [{tool: 'bash', calls: 1}, {tool: 'read', calls: 2, failed: 1}],
  );
  assert.deepEqual(usage, {input: 1200, output: 340, cacheReadInput: undefined});
});

test('background progress becomes one job per task, ending in a terminal state', () => {
  const collector = createCollector();
  collector.observe({ev: 'background_progress', task_id: 'a', label: 'npm test', summary: 'running'});
  collector.observe({ev: 'background_progress', task_id: 'a', label: 'npm test', summary: 'done', done: true});
  collector.observe({ev: 'background_progress', task_id: 'b', label: 'build', summary: 'running'});

  const {jobs} = collector.result();
  assert.equal(jobs.length, 2);
  assert.equal(jobs.find((job) => job.id === 'a').state, 'succeeded');
  assert.equal(jobs.find((job) => job.id === 'b').state, 'running');
});

test('the MCP config carries no bearer token and is not world-readable', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'c92-ws-'));
  const path = await writeMcpConfig(workspace, {
    runtimeUrl: 'https://example.invalid/functions/agent-runtime',
    runId: '11111111-1111-1111-1111-111111111111',
    capabilitySocket: '/var/lib/code92-agent-runner/h/abc123/run/capability.sock',
    moduleDir: '/srv/agent-runner',
  });

  const config = JSON.parse(await readFile(path, 'utf8'));
  const server = config.mcpServers.code92_platform;
  assert.equal(server.env.JCODE_RUN_CAPABILITY_SOCKET, '/var/lib/code92-agent-runner/h/abc123/run/capability.sock');
  assert.ok(!('JCODE_RUN_CAPABILITY_TOKEN' in server.env));
  assert.equal(server.env.JCODE_RUN_ID, '11111111-1111-1111-1111-111111111111');
  assert.equal(server.shared, false, 'a run-scoped token must not be shared between sessions');
  assert.deepEqual(server.command, ['node', '/srv/agent-runner/platform-mcp.mjs']);

  // The config is model-readable, so only the non-secret socket path is stored.
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600);

  // Nothing that authenticates the *runner* may be in the sandbox's config.
  const raw = await readFile(path, 'utf8');
  assert.ok(!raw.includes('AGENT_RUNNER_SECRET'));
  assert.ok(!raw.includes('OPENROUTER_API_KEY'));
  assert.ok(!raw.includes('capability-token-value'));
});

test('the capability broker delivers the token over a private socket', async () => {
  const jcodeHome = await mkdtemp(join(tmpdir(), 'c92-home-'));
  const broker = await createCapabilityBroker(jcodeHome, 'capability-token-value');
  const token = await new Promise((resolve, reject) => {
    const socket = createConnection(broker.socketPath);
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (raw += chunk));
    socket.on('end', () => resolve(raw.trim()));
    socket.on('error', reject);
  });
  await broker.close();
  assert.equal(token, 'capability-token-value');
});

// --- the claim → progress → finalize protocol --------------------------------

async function withFakeControlPlane(handler, body) {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const payload = JSON.parse(raw);
      calls.push(payload);
      const response = handler(payload) ?? {ok: true};
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(response));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;

  process.env.AGENT_RUNTIME_URL = url;
  process.env.AGENT_RUNNER_SECRET = 'test-secret';
  process.env.JCODE_DATA_DIR = await mkdtemp(join(tmpdir(), 'c92-runner-'));

  try {
    const mod = await import(`../server.mjs?case=${Math.random()}`);
    await body(mod, calls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const CLAIM = {
  claimed: true,
  run_id: '22222222-2222-2222-2222-222222222222',
  capability_token: 'token',
  openrouter_api_key: 'sk-or-v1-0000000000000000000000',
  prompt: 'draft the phase document',
  model: 'anthropic/claude-sonnet-4.5',
  tool_profile: 'operator',
  max_tool_steps: 12,
  max_run_seconds: 240,
  agent_id: '33333333-3333-3333-3333-333333333333',
  channel_id: '44444444-4444-4444-4444-444444444444',
  thread_root_id: null,
  jcode_session_id: null,
};

test('a successful turn claims, reports progress, then finalizes exactly once', async () => {
  await withFakeControlPlane(
    (payload) => (payload.action === 'claim' ? CLAIM : {ok: true}),
    async (mod, calls) => {
      mod.__setDriver(async () => ({
        output: 'Here is the drafted PSR.',
        sessionId: 'session-1',
        usage: {input: 900, output: 120},
        toolSummary: [{tool: 'read', calls: 3}],
        jobs: [],
      }));

      await mod.executeRun(CLAIM.run_id);

      const actions = calls.map((call) => call.action);
      assert.equal(actions[0], 'claim', 'nothing may happen before the run is claimed');
      assert.equal(actions.filter((action) => action === 'finalize').length, 1);
      assert.ok(!actions.includes('fail'));

      const finalize = calls.find((call) => call.action === 'finalize');
      assert.equal(finalize.output, 'Here is the drafted PSR.');
      assert.equal(finalize.jcode_session_id, 'session-1');
      assert.deepEqual(finalize.usage, {input_tokens: 900, output_tokens: 120});
    },
  );
});

test('a turn that throws is reported as a failure, never left to the lease', async () => {
  await withFakeControlPlane(
    (payload) => (payload.action === 'claim' ? CLAIM : {ok: true}),
    async (mod, calls) => {
      mod.__setDriver(async () => {
        throw new Error('jcode exploded');
      });

      await mod.executeRun(CLAIM.run_id);

      const fail = calls.find((call) => call.action === 'fail');
      assert.ok(fail, 'a failed run must be reported');
      assert.match(fail.error, /jcode exploded/);
      assert.ok(!calls.some((call) => call.action === 'finalize'));
    },
  );
});

test('an empty turn is a failure, not an empty message posted to the channel', async () => {
  await withFakeControlPlane(
    (payload) => (payload.action === 'claim' ? CLAIM : {ok: true}),
    async (mod, calls) => {
      mod.__setDriver(async () => ({output: '   ', sessionId: 's', toolSummary: [], jobs: []}));
      await mod.executeRun(CLAIM.run_id);
      assert.ok(calls.some((call) => call.action === 'fail'));
      assert.ok(!calls.some((call) => call.action === 'finalize'));
    },
  );
});

test('a claim without a model credential fails before the harness is launched', async () => {
  await withFakeControlPlane(
    (payload) => (payload.action === 'claim' ? {...CLAIM, openrouter_api_key: undefined} : {ok: true}),
    async (mod, calls) => {
      let launched = false;
      mod.__setDriver(async () => {
        launched = true;
        return {output: 'x', sessionId: 's', toolSummary: [], jobs: []};
      });

      await mod.executeRun(CLAIM.run_id);

      assert.equal(launched, false, 'the harness must not start without a credential');
      const fail = calls.find((call) => call.action === 'fail');
      assert.match(fail.error, /without an OpenRouter key/);
    },
  );
});

test('a run that is not claimed does no work at all', async () => {
  await withFakeControlPlane(
    (payload) => (payload.action === 'claim' ? {claimed: false} : {ok: true}),
    async (mod, calls) => {
      mod.__setDriver(async () => assert.fail('the driver must not run for an unclaimed run'));
      await mod.executeRun(CLAIM.run_id);
      assert.deepEqual(calls.map((call) => call.action), ['claim']);
    },
  );
});

test('background jobs are recorded before the run is finalized', async () => {
  await withFakeControlPlane(
    (payload) => (payload.action === 'claim' ? CLAIM : {ok: true}),
    async (mod, calls) => {
      mod.__setDriver(async () => ({
        output: 'done',
        sessionId: 's',
        toolSummary: [],
        jobs: [{id: 'a', state: 'running', command_summary: 'npm test'}],
      }));

      await mod.executeRun(CLAIM.run_id);

      const actions = calls.map((call) => call.action);
      assert.ok(actions.indexOf('jobs') < actions.indexOf('finalize'));
      assert.deepEqual(calls.find((call) => call.action === 'jobs').jobs, [
        {id: 'a', state: 'running', command_summary: 'npm test'},
      ]);
    },
  );
});

// --- polling ------------------------------------------------------------------

test('polling claims what the queue offers, up to capacity', async () => {
  await withFakeControlPlane(
    (payload) => {
      if (payload.action === 'poll') return {runs: [CLAIM.run_id]};
      if (payload.action === 'claim') return CLAIM;
      return {ok: true};
    },
    async (mod, calls) => {
      mod.__setDriver(async () => ({
        output: 'polled work',
        sessionId: 's',
        toolSummary: [],
        jobs: [],
      }));

      const found = await mod.pollOnce();
      assert.equal(found, true);

      // executeRun is started but not awaited by the poll loop, so give the
      // dispatched run a turn to finish before asserting on the transcript.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const actions = calls.map((call) => call.action);
      assert.equal(actions[0], 'poll');
      assert.ok(actions.includes('claim'));
      assert.ok(actions.includes('finalize'));
    },
  );
});

test('an empty queue reports no work rather than claiming nothing', async () => {
  await withFakeControlPlane(
    (payload) => (payload.action === 'poll' ? {runs: []} : {ok: true}),
    async (mod, calls) => {
      mod.__setDriver(async () => assert.fail('nothing should run for an empty queue'));
      assert.equal(await mod.pollOnce(), false);
      assert.deepEqual(calls.map((call) => call.action), ['poll']);
    },
  );
});

test('polling asks for no more than the free capacity', async () => {
  await withFakeControlPlane(
    (payload) => (payload.action === 'poll' ? {runs: []} : {ok: true}),
    async (mod, calls) => {
      await mod.pollOnce();
      // MAX_CONCURRENT_RUNS defaults to 1 and nothing is active.
      assert.equal(calls[0].limit, 1);
    },
  );
});

// jcode binds its API socket under $HOME, so the home path is subject to
// SUN_LEN (108) rather than the filesystem's path limit. This is a real bind()
// failure that only shows up once a run has already been claimed.
test('jcode home leaves room for the API socket under SUN_LEN', () => {
  const {jcodeHome} = pathsFor({
    agent_id: '4e20b867-031b-49be-aeb7-2f9bf8600a6a',
    channel_id: 'b8cb946a-a4d6-42cd-a31f-6018a3b0e0b0',
    thread_root_id: null,
  });
  const socket = `${jcodeHome}/run/jcode-api.sock`;
  assert.ok(
    Buffer.byteLength(socket) <= 108,
    `socket path is ${Buffer.byteLength(socket)} bytes: ${socket}`,
  );
});

test('socketPathBudget measures the worst case, not a sample run', () => {
  const budget = socketPathBudget();
  assert.equal(budget.limit, 108);
  // Must be at least as long as any path pathsFor can actually produce.
  const {jcodeHome} = pathsFor({agent_id: 'x', channel_id: 'c', thread_root_id: null});
  assert.ok(budget.length >= Buffer.byteLength(`${jcodeHome}/run/jcode-api.sock`));
});

test('agent home is stable per agent and distinct across agents', () => {
  const a = pathsFor({agent_id: 'agent-one', channel_id: 'c', thread_root_id: null});
  const b = pathsFor({agent_id: 'agent-one', channel_id: 'other', thread_root_id: null});
  const c = pathsFor({agent_id: 'agent-two', channel_id: 'c', thread_root_id: null});
  assert.equal(a.jcodeHome, b.jcodeHome, 'home follows the agent, not the channel');
  assert.notEqual(a.jcodeHome, c.jcodeHome);
  assert.notEqual(a.workspace, b.workspace, 'workspaces stay per channel');
});

// The image copies named files rather than the whole directory, so adding a
// module is one edit away from an image that crashes on boot with
// ERR_MODULE_NOT_FOUND — after deploy, not at build time.
test('every local module the runner imports is copied into the image', async () => {
  const root = new URL('../', import.meta.url);
  const dockerfile = await readFile(new URL('Dockerfile', root), 'utf8');
  const copied = new Set(
    dockerfile
      .split('\n')
      .filter((line) => line.startsWith('COPY '))
      .flatMap((line) => line.slice(5).trim().split(/\s+/))
      .filter((token) => token.endsWith('.mjs')),
  );

  const entrypoints = ['server.mjs', 'jcode-driver.mjs', 'platform-mcp.mjs', 'workspace.mjs'];
  for (const entry of entrypoints) {
    assert.ok(copied.has(entry), `Dockerfile never copies ${entry}`);
    const source = await readFile(new URL(entry, root), 'utf8');
    for (const [, spec] of source.matchAll(/from '\.\/([\w.-]+\.mjs)'/g)) {
      assert.ok(copied.has(spec), `${entry} imports ${spec}, which the Dockerfile never copies`);
    }
  }
});

// The SDK spawns the bridge with {...process.env, ...options.env} and takes no
// uid, so jcode runs as this user with this environment. The runner therefore
// scrubs sensitive names as defence in depth even though the operator has no
// shell or network tool.
test('the runner secret never reaches the harness environment', () => {
  const scrubbed = scrubbedHostEnv({
    AGENT_RUNNER_SECRET: 'super-secret',
    AGENT_REPO_SECRET: 'also-secret',
    GITHUB_TOKEN: 'ghp_xxx',
    AWS_SECRET_ACCESS_KEY: 'aws',
    DB_PASSWORD: 'hunter2',
    PATH: '/usr/bin',
    LANG: 'C.UTF-8',
  });
  for (const leaky of [
    'AGENT_RUNNER_SECRET',
    'AGENT_REPO_SECRET',
    'GITHUB_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'DB_PASSWORD',
  ]) {
    assert.equal(scrubbed[leaky], '', `${leaky} still carries a value`);
  }
});

test('scrubbing blanks rather than omits, or process.env wins', () => {
  const scrubbed = scrubbedHostEnv({AGENT_RUNNER_SECRET: 'super-secret'});
  // Present-and-empty is the whole point: an absent key is inherited from the
  // parent by the SDK's spread.
  assert.ok('AGENT_RUNNER_SECRET' in scrubbed);
  assert.equal(scrubbed.AGENT_RUNNER_SECRET, '');
});

test('ordinary variables and the model credential survive scrubbing', () => {
  const scrubbed = scrubbedHostEnv({
    PATH: '/usr/bin',
    HOME: '/home/agent',
    OPENROUTER_API_KEY: 'sk-or-v1-real',
  });
  assert.ok(!('PATH' in scrubbed), 'PATH must pass through untouched');
  assert.ok(!('HOME' in scrubbed), 'HOME must pass through untouched');
  assert.ok(
    !('OPENROUTER_API_KEY' in scrubbed),
    'the model credential is granted explicitly and must not be blanked',
  );
});

// An empty turn with no explanation is the least actionable failure the runner
// can produce, and the bridge almost always explains itself first.
test('the collector keeps error events so an empty turn can say why', () => {
  const collector = createCollector();
  collector.observe({ev: 'error', code: 'model_error', message: 'insufficient credits'});
  collector.observe({ev: 'error', code: 'auth', message: 'invalid api key'});
  const {errors} = collector.result();
  assert.deepEqual(errors, ['model_error: insufficient credits', 'auth: invalid api key']);
});

test('a clean turn collects no errors', () => {
  const collector = createCollector();
  collector.observe({ev: 'tool_start', name: 'read'});
  collector.observe({ev: 'turn_done', session_id: 's1'});
  assert.deepEqual(collector.result().errors, []);
});

test('an error event with no message still yields something printable', () => {
  const collector = createCollector();
  collector.observe({ev: 'error', code: '', message: ''});
  assert.deepEqual(collector.result().errors, ['unspecified error']);
});
