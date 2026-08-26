import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('fx harness uses an atomic expiring capability claim and preserves DM boundaries', async () => {
  const migration = await read('migrations/20260826100000_add-fx-agent-harness.sql');
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.claim_fx_agent_run/);
  assert.match(migration, /capability_token_hash = md5\(v_token\)/);
  assert.match(migration, /lease_expires_at = now\(\) \+ make_interval/);
  assert.match(migration, /v_claimed := v_row_count > 0/);
  assert.match(migration, /kind = 'dm'/);
  assert.match(migration, /ag\.runtime/);
});

test('existing queue routes fx runs to compute without giving it edge credentials or a static Gateway key', async () => {
  const source = await read('functions/thread-agent.ts');
  const runner = await read('services/agent-runner/server.mjs');
  assert.match(source, /if \(run\.runtime === 'fx'\)/);
  assert.match(source, /dispatchFxRun/);
  assert.match(runner, /AI_GATEWAY_API_KEY/);
  assert.match(runner, /claim\.gateway_api_key/);
  assert.doesNotMatch(runner, /fxApiKey: process\.env\.AI_GATEWAY_API_KEY/);
  assert.match(runner, /FX_RUN_CAPABILITY_TOKEN/);
  assert.doesNotMatch(runner, /INSFORGE_API_KEY|API_KEY: process\.env/);
  assert.match(runner, /agentProcessOptions/);
  assert.match(runner, /setInterval\(\(\) =>/);
});

test('the Gateway credential is encrypted, status-only in the browser, and run-scoped for fx', async () => {
  const migration = await read('migrations/20260826110000_add-ai-gateway-connection.sql');
  const edge = await read('functions/agent-runtime.ts');
  const settings = await read('components/agents/VercelGatewayPanel.tsx');

  assert.match(migration, /CREATE TABLE public\.ai_gateway_connection/);
  assert.match(migration, /REVOKE ALL ON public\.ai_gateway_connection FROM anon, authenticated/);
  assert.match(migration, /ai_gateway_connection_status\(\)/);
  assert.match(edge, /async function loadAiGatewayKey/);
  assert.match(edge, /gateway_api_key: gatewayApiKey/);
  assert.match(settings, /BYOK/);
  assert.doesNotMatch(settings, /key_ciphertext|key_iv/);
});
