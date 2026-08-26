// Minimal stdio MCP server. The runner injects only a short-lived capability
// token, never an InsForge admin key. Platform writes remain finalization-only
// inside functions/agent-runtime.ts.
import readline from 'node:readline';

const runtimeUrl = process.env.FX_RUNTIME_URL;
const capability = process.env.FX_RUN_CAPABILITY_TOKEN;
const runId = process.env.FX_RUN_ID;

const tools = [
  {
    name: 'platform_get_channel_context',
    description: 'Read the bound channel and product context for this agent run.',
    inputSchema: {type: 'object', properties: {}, additionalProperties: false},
  },
  {
    name: 'platform_list_open_tasks',
    description: 'List open tasks for the product bound to this channel.',
    inputSchema: {type: 'object', properties: {}, additionalProperties: false},
  },
  {
    name: 'platform_search_knowledge',
    description: 'Search approved knowledge items belonging to the bound product.',
    inputSchema: {
      type: 'object',
      properties: {query: {type: 'string', minLength: 1, maxLength: 120}},
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'platform_get_thread',
    description: 'Read a specific conversation thread from this channel by its trigger message id.',
    inputSchema: {
      type: 'object',
      properties: {trigger_message_id: {type: 'string', format: 'uuid'}},
      required: ['trigger_message_id'],
      additionalProperties: false,
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(id, code, message) {
  send({jsonrpc: '2.0', id, error: {code, message}});
}

async function callPlatform(tool, args) {
  if (!runtimeUrl || !capability || !runId) throw new Error('platform tool capability is unavailable');
  const response = await fetch(runtimeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Run-Token': capability,
    },
    body: JSON.stringify({action: 'tool', run_id: runId, tool, arguments: args ?? {}}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error) throw new Error(body?.error?.message || `platform tool failed (${response.status})`);
  return body;
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  const {id, method, params = {}} = message;
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) return;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion || '2025-03-26',
        capabilities: {tools: {listChanged: false}},
        serverInfo: {name: 'code92-platform', version: '0.1.0'},
      },
    });
    return;
  }
  if (method === 'ping') return send({jsonrpc: '2.0', id, result: {}});
  if (method === 'tools/list') return send({jsonrpc: '2.0', id, result: {tools}});
  if (method === 'tools/call') {
    const tool = tools.find((candidate) => candidate.name === params.name);
    if (!tool) return fail(id, -32602, 'unknown platform tool');
    try {
      const result = await callPlatform(tool.name, params.arguments);
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{type: 'text', text: JSON.stringify(result)}],
          structuredContent: result,
        },
      });
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id,
        result: {content: [{type: 'text', text: `Platform tool error: ${error.message}`}], isError: true},
      });
    }
    return;
  }
  if (id !== undefined) fail(id, -32601, `unsupported method: ${method}`);
}

const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
input.on('line', (line) => {
  try {
    void handle(JSON.parse(line));
  } catch {
    // MCP is JSON Lines. Ignore malformed input rather than contaminating stdout.
  }
});
