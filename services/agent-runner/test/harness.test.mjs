import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import test from 'node:test';

const runId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const channelId = '33333333-3333-4333-8333-333333333333';

function request(port, path, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...headers},
    body: JSON.stringify(body),
  }).then(async (response) => ({status: response.status, body: await response.json()}));
}

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {server, port: server.address().port};
}

async function waitFor(predicate, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for condition');
}

async function waitForRunner(port) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // The child process has not bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('runner did not become healthy');
}

test('runner claims a queued fx run, renews its lifecycle, persists jobs, and finalizes', async (t) => {
  const calls = [];
  const runtime = await listen(async (req, res) => {
    const body = await new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => resolve(JSON.parse(raw)));
    });
    calls.push({headers: req.headers, body});
    const result = body.action === 'claim'
      ? {
          claimed: true,
          run_id: runId,
          capability_token: 'short-lived-test-capability',
          gateway_api_key: 'gateway-test-key-123456',
          prompt: 'Return the requested JSON.',
          model: 'openai/gpt-5.6-luna',
          tool_profile: 'research',
          max_tool_steps: 4,
          max_run_seconds: 30,
          agent_id: agentId,
          channel_id: channelId,
          thread_root_id: null,
          fx_session_id: null,
        }
      : {ok: true};
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(result));
  });
  t.after(() => runtime.server.close());

  const dir = await mkdtemp(join(tmpdir(), 'code92-fx-runner-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const fake = join(dir, 'fake-fx.mjs');
  const wrapper = join(dir, 'fx');
  await writeFile(fake, `
const command = process.argv[2];
if (command === 'usage') process.stdout.write(JSON.stringify({totals:{spend:1}}));
else if (command === 'provider') {
  if (process.env.AI_GATEWAY_API_KEY !== 'gateway-test-key-123456') process.exitCode = 1;
  else process.stdout.write('gateway');
}
else if (command === 'ask') process.stdout.write(JSON.stringify({exit_code:0, output:'{"reply":"Harness reply","proposals":[]}', session_id:'session-test', usage:{input_tokens:12, output_tokens:8}, tool_calls:[{name:'web_search', status:'ok'}]}));
else if (command === 'background') process.stdout.write(JSON.stringify({background:[{id:'bg-test', state:'running', command:'long research'}]}));
else process.exitCode = 1;
`);
  await writeFile(wrapper, `#!/bin/sh\nexec ${process.execPath} ${fake} "$@"\n`);
  await chmod(wrapper, 0o755);

  const port = 19100 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      AGENT_RUNTIME_URL: `http://127.0.0.1:${runtime.port}/runtime`,
      AGENT_RUNNER_SECRET: 'runner-test-secret',
      AGENT_RUNNER_ID: 'runner-test',
      FX_BINARY: wrapper,
      FX_DATA_DIR: join(dir, 'data'),
    },
    stdio: 'ignore',
  });
  t.after(() => child.kill('SIGTERM'));
  await waitForRunner(port);

  const dispatched = await request(port, '/dispatch', {run_id: runId}, {Authorization: 'Bearer runner-test-secret'});
  assert.equal(dispatched.status, 202);
  await waitFor(() => calls.some((call) => call.body.action === 'finalize'));

  assert.deepEqual(calls.map((call) => call.body.action), ['claim', 'event', 'jobs', 'event', 'finalize']);
  const finalize = calls.find((call) => call.body.action === 'finalize').body;
  assert.equal(finalize.output, '{"reply":"Harness reply","proposals":[]}');
  assert.equal(finalize.fx_session_id, 'session-test');
  assert.deepEqual(finalize.tool_summary, [{name: 'web_search', status: 'ok'}]);
  assert.equal(calls.every((call) => call.headers.authorization === 'Bearer runner-test-secret'), true);
  assert.equal(JSON.stringify(calls).includes('gateway-test-key-123456'), false);
});

test('platform MCP exposes only read tools and forwards the short-lived capability', async (t) => {
  const requests = [];
  const runtime = await listen(async (req, res) => {
    const raw = await new Promise((resolve) => {
      let value = '';
      req.on('data', (chunk) => { value += chunk; });
      req.on('end', () => resolve(value));
    });
    requests.push({headers: req.headers, body: JSON.parse(raw)});
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({channel: {slug: 'platform'}, context: 'safe context'}));
  });
  t.after(() => runtime.server.close());

  const child = spawn(process.execPath, ['platform-mcp.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      FX_RUNTIME_URL: `http://127.0.0.1:${runtime.port}/runtime`,
      FX_RUN_CAPABILITY_TOKEN: 'mcp-capability',
      FX_RUN_ID: runId,
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  t.after(() => child.kill('SIGTERM'));
  const lines = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => lines.push(...chunk.trim().split('\n').filter(Boolean).map(JSON.parse)));
  child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'})}\n`);
  await waitFor(() => lines.some((line) => line.id === 1));
  const list = lines.find((line) => line.id === 1);
  assert.deepEqual(list.result.tools.map((tool) => tool.name), [
    'platform_get_channel_context',
    'platform_list_open_tasks',
    'platform_search_knowledge',
    'platform_get_thread',
  ]);
  assert.equal(list.result.tools.some((tool) => /write|create|update/i.test(tool.name)), false);

  child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'platform_get_channel_context', arguments: {}}})}\n`);
  await waitFor(() => lines.some((line) => line.id === 2));
  assert.equal(requests[0].headers['x-agent-run-token'], 'mcp-capability');
  assert.deepEqual(requests[0].body, {action: 'tool', run_id: runId, tool: 'platform_get_channel_context', arguments: {}});
});
