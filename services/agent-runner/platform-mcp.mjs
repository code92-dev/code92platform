// Minimal stdio MCP server: how the harness reads the platform.
//
// jcode is an MCP client, so the platform is exposed to it as a server rather
// than as tools registered in-process. Everything here is a read. There is no
// write tool and there must never be one: an agent's only route into the
// record is a proposal written by functions/agent-runtime.ts at finalisation,
// which a human then approves. A write tool here would reopen that boundary
// from the inside.
//
// The runner injects a short-lived capability token scoped to one run, never
// an InsForge admin key. The token is accepted only while the run's lease is
// live, and the control plane re-derives the channel and product scope from
// the run id — nothing about what may be read is taken from this process.
//
// Hand-rolled rather than built on the MCP SDK because the protocol surface
// needed here is four tools over JSON Lines, and a dependency inside the
// sandbox is a dependency the agent could reach.
import readline from 'node:readline';
import net from 'node:net';

const runtimeUrl = process.env.JCODE_RUNTIME_URL;
const capabilitySocket = process.env.JCODE_RUN_CAPABILITY_SOCKET;
const runId = process.env.JCODE_RUN_ID;

async function readCapability(socketPath) {
  if (!socketPath) return process.env.JCODE_RUN_CAPABILITY_TOKEN;
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      raw += chunk;
      const newline = raw.indexOf('\n');
      if (newline >= 0) {
        socket.destroy();
        resolve(raw.slice(0, newline));
      }
    });
    socket.on('error', reject);
  });
}

// The token is delivered over a runner-owned Unix socket rather than through
// `.jcode/mcp.json`, which is readable by the model's structured file tools.
const capability = await readCapability(capabilitySocket);

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
    name: 'platform_repo_history',
    description:
      "Recent commits for this product's repository, optionally for one path. The working tree in this workspace has no git history — this is how you read it.",
    inputSchema: {
      type: 'object',
      properties: {
        path: {type: 'string', maxLength: 400},
        limit: {type: 'integer', minimum: 1, maximum: 100},
      },
      additionalProperties: false,
    },
  },
  {
    name: 'platform_file_at_ref',
    description:
      "Read one text file from this product's repository at a given ref. Use this to compare the working tree against another branch or an older commit.",
    inputSchema: {
      type: 'object',
      properties: {
        path: {type: 'string', minLength: 1, maxLength: 400},
        ref: {type: 'string', maxLength: 200},
      },
      required: ['path'],
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
