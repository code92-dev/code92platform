// The one check that needs a real model call.
//
// Everything else about this runner is proven by test/harness.test.mjs and
// test/workspace.test.mjs against fakes. This is the exception: whether jcode
// actually connects the MCP server we configure, and therefore whether an
// operator agent can see the platform at all.
//
// It is not part of `npm test` on purpose — it spends money and needs a
// credential. Run it once before the first deploy, and again after any jcode
// upgrade:
//
//   OPENROUTER_API_KEY=sk-or-v1-... node test/mcp-live-check.mjs
//
// Use a key with a spend limit. One run costs a fraction of a cent.
import {JcodeClient} from '@1jehuang/jcode-sdk';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const runnerDir = join(moduleDir, '..');

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('OPENROUTER_API_KEY is required. Use a key with a spend limit.');
  process.exit(2);
}
const model = process.env.MODEL || 'anthropic/claude-sonnet-4.5';

const workspace = await mkdtemp(join(tmpdir(), 'c92-live-'));
const jcodeHome = await mkdtemp(join(tmpdir(), 'c92-live-home-'));

// A stand-in for functions/agent-runtime.ts. It answers the one tool the model
// is asked to call, so the check needs no platform and no capability token —
// what is under test is whether the call arrives at all.
let toolCalls = [];
const {createServer} = await import('node:http');
const control = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    toolCalls.push(body.tool);
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({
      channel: {slug: 'mcp-live-check', topic: 'a probe', product_id: null},
      context: 'CANARY-7F3A: the platform tool answered.',
    }));
  });
});
await new Promise((r) => control.listen(0, '127.0.0.1', r));
const runtimeUrl = `http://127.0.0.1:${control.address().port}/`;

await mkdir(join(workspace, '.jcode'), {recursive: true});
const mcpConfig = {
  mcpServers: {
    code92_platform: {
      command: ['node', join(runnerDir, 'platform-mcp.mjs')],
      enabled: true,
      shared: false,
      env: {
        JCODE_RUNTIME_URL: runtimeUrl,
        JCODE_RUN_CAPABILITY_TOKEN: 'live-check-token',
        JCODE_RUN_ID: '11111111-1111-1111-1111-111111111111',
      },
    },
  },
};
await writeFile(join(workspace, '.jcode', 'mcp.json'), JSON.stringify(mcpConfig, null, 2));
// Written to both locations jcode documents, so a negative result means "jcode
// did not connect it" rather than "we guessed the path wrong".
await mkdir(join(jcodeHome, '.jcode'), {recursive: true});
await writeFile(join(jcodeHome, '.jcode', 'mcp.json'), JSON.stringify(mcpConfig, null, 2));

console.log('launching jcode…');
const client = await JcodeClient.launch({
  jcodeHome,
  workingDir: workspace,
  inheritLogins: false,
  clientName: 'code92-live-check/1.0',
  env: {
    OPENROUTER_API_KEY: apiKey,
    JCODE_NO_TELEMETRY: '1',
    JCODE_NO_UPDATE: '1',
    JCODE_AUTO_UPDATE: '0',
    HOME: jcodeHome,
  },
  startupTimeoutMs: 60_000,
});

const session = await client.createSession(workspace);
await client.setModel(session.session_id, model);
console.log(`session ${session.session_id} on ${model}`);

const seen = new Set();
const turn = await client.run(
  session.session_id,
  'Call the platform_get_channel_context tool, then reply with only the CANARY code it returns.',
  {
    autoApprove: true,
    onEvent: (event) => {
      if (event.ev === 'tool_start') seen.add(event.name);
    },
  },
);

await client.close();
await new Promise((r) => control.close(r));

const namedPlatformTool = [...seen].some((name) => name.includes('platform_get_channel_context'));
const reachedControlPlane = toolCalls.includes('platform_get_channel_context');
const echoedCanary = turn.text.includes('CANARY-7F3A');

console.log('\n--- result ---');
console.log('tools the model invoked :', [...seen].join(', ') || '(none)');
console.log('MCP tool was called     :', namedPlatformTool ? 'YES' : 'no');
console.log('reached the control plane:', reachedControlPlane ? 'YES' : 'no');
console.log('canary echoed in reply  :', echoedCanary ? 'YES' : 'no');
console.log('reply                   :', turn.text.slice(0, 200));

if (reachedControlPlane && echoedCanary) {
  console.log('\nPASS — jcode connects the platform MCP server and the model can use it.');
  process.exit(0);
}
console.log(
  '\nFAIL — the model never reached the platform tool.\n' +
    'The runner would run, read a repository and answer, but with no view of the\n' +
    'channel, tasks or knowledge base. Do not deploy an operator agent until this passes.',
);
process.exit(1);
