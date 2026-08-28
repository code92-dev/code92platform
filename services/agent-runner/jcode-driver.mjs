// Drives one jcode turn for one claimed run.
//
// Everything jcode-specific lives here so that server.mjs stays a claim/lease
// loop against the platform. Swapping the harness again should mean replacing
// this file and nothing else — the lesson of the fx attempt, which spread its
// harness assumptions through the control plane and made the revert a 22-file
// commit.
//
// Three properties of the SDK drive the shape of this file, all verified
// against @1jehuang/jcode-sdk@1.1.0 rather than its documentation:
//
//   1. `launch()` inherits the host user's provider logins by default. Here
//      that would mean an agent run silently spending whoever's credentials
//      happen to be on the runner image. `inheritLogins: false` is mandatory,
//      not a hardening option.
//   2. The bridge does not always advertise the `permissions` capability. A
//      client that waits for a permission prompt on a server that never issues
//      one waits forever, so containment cannot rest on prompts. It rests on
//      the tool allow-list and the working-directory bound, with prompts
//      handled only if the server says it has them.
//   3. `TurnResult.usage` carries tokens but no price. Cost is reconciled by
//      the control plane against OpenRouter's own key ledger.
//   4. `launch()` spawns the bridge with `{...process.env, ...options.env}` and
//      offers no uid/gid. Since the operator has no shell, the control plane
//      credential is scrubbed as defence in depth while structured file tools
//      remain the only workspace capability; see scrubbedHostEnv().
import {JcodeClient} from '@1jehuang/jcode-sdk';
import {chown, chmod, mkdir, readdir, unlink, writeFile} from 'node:fs/promises';
import {createServer as createNetServer} from 'node:net';
import {join} from 'node:path';

// The operator toolset. An explicit allow-list rather than a profile name:
// profiles are jcode's vocabulary and can gain a tool in a release, and a
// harness that quietly grows a capability inside someone else's sandbox is
// the failure mode this whole runtime is arranged to prevent.
//
// Note what is absent. No shell or network fetch tool: an agent that has read a
// private repo must not also hold the means to post it somewhere. Web research
// stays on the OpenRouter runtime, where the agent has no workspace.
// There is deliberately no shell. The runner still materialises private source
// and carries the model credential; giving an untrusted turn `bash` would make
// `/proc`, the network stack and every mounted workspace an exfiltration API.
// Repository changes use the structured file tools and become proposals.
const OPERATOR_TOOLS = ['read', 'write', 'edit', 'apply_patch', 'grep', 'glob', 'ls'];

// Never available, whatever the profile resolves to. Belt and braces against
// the allow-list being interpreted more loosely than intended by a future
// release.
const DENIED_TOOLS = ['web_search', 'web_fetch', 'browser', 'integration', 'swarm'];

function toolsFor(profile) {
  return profile === 'operator' ? OPERATOR_TOOLS : ['read', 'grep', 'glob', 'ls'];
}

// jcode reads `.jcode/mcp.json` from the project root. The config therefore
// lives in the workspace, but it must not contain the bearer token: the model
// can read every regular file there. The MCP child receives a socket path and
// obtains the token over a runner-owned Unix socket instead.
async function writeMcpConfig(workspace, {runtimeUrl, runId, capabilitySocket, moduleDir}) {
  const dir = join(workspace, '.jcode');
  await mkdir(dir, {recursive: true});
  const config = {
    mcpServers: {
      code92_platform: {
        command: ['node', join(moduleDir, 'platform-mcp.mjs')],
        enabled: true,
        // Not shared: this server carries a token scoped to one run, and a
        // connection reused across sessions would outlive the lease that
        // makes the token valid.
        shared: false,
        env: {
          JCODE_RUNTIME_URL: runtimeUrl,
          JCODE_RUN_CAPABILITY_SOCKET: capabilitySocket,
          JCODE_RUN_ID: runId,
        },
      },
    },
  };
  await writeFile(join(dir, 'mcp.json'), JSON.stringify(config, null, 2), {mode: 0o600});
  return join(dir, 'mcp.json');
}

async function createCapabilityBroker(jcodeHome, capabilityToken) {
  const runDir = join(jcodeHome, 'run');
  await mkdir(runDir, {recursive: true, mode: 0o700});
  const socketPath = join(runDir, 'capability.sock');
  await unlink(socketPath).catch(() => {});
  const server = createNetServer((socket) => {
    socket.end(`${capabilityToken}\n`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  return {socketPath, close: () => new Promise((resolve) => server.close(() => resolve()))};
}

async function handOver(paths, uid, gid) {
  if (!(process.getuid?.() === 0 && Number.isInteger(uid) && uid > 0)) return;
  await Promise.all(paths.map((path) => chown(path, uid, gid || uid).catch(() => {})));
}

// A repository is thousands of files, so this recurses rather than listing
// paths. The harness runs as a different user and cannot read a tree the
// control plane unpacked as root.
async function handOverTree(root, uid, gid) {
  if (!(process.getuid?.() === 0 && Number.isInteger(uid) && uid > 0)) return;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    await chown(current, uid, gid || uid).catch(() => {});
    const entries = await readdir(current, {withFileTypes: true}).catch(() => []);
    for (const entry of entries) {
      const path = join(current, entry.name);
      // Never follow a symlink out of the tree: an archive is untrusted input.
      if (entry.isSymbolicLink()) {
        await chown(path, uid, gid || uid).catch(() => {});
        continue;
      }
      if (entry.isDirectory()) stack.push(path);
      else await chown(path, uid, gid || uid).catch(() => {});
    }
  }
}

// Collapses the event stream into the two things the platform stores: a
// per-tool tally for agent_runs.tool_summary, and background work for
// agent_jobs. The full stream is far too chatty to persist — a single run
// emits thousands of text_delta events — so what is kept is what a human
// reviewing the run afterwards actually needs.
function createCollector() {
  const tools = new Map();
  const jobs = new Map();
  // The bridge reports a refused model call, a bad credential or an exhausted
  // budget as an `error` event and then ends the turn with no text. Discarding
  // these turns "empty turn" — true, useless, and the reason a real cause takes
  // an afternoon to find.
  const errors = [];
  let usage = null;

  return {
    observe(event) {
      switch (event.ev) {
        case 'tool_start': {
          const entry = tools.get(event.name) ?? {tool: event.name, calls: 0, failed: 0};
          entry.calls += 1;
          tools.set(event.name, entry);
          break;
        }
        case 'tool_done': {
          if (event.error) {
            const entry = tools.get(event.name) ?? {tool: event.name, calls: 1, failed: 0};
            entry.failed += 1;
            tools.set(event.name, entry);
          }
          break;
        }
        case 'error':
          errors.push(
            [event.code, event.message].filter(Boolean).join(': ').slice(0, 500) ||
              'unspecified error',
          );
          break;
        case 'token_usage':
          usage = {input: event.input, output: event.output, cacheReadInput: event.cache_read_input};
          break;
        case 'background_progress':
          jobs.set(event.task_id, {
            id: event.task_id,
            state: event.done ? 'succeeded' : 'running',
            command_summary: String(event.label ?? event.summary ?? 'background task').slice(0, 500),
          });
          break;
        default:
          break;
      }
    },
    result() {
      return {
        // Drop the zero-failure noise so the stored summary reads as a tally
        // rather than a schema dump.
        toolSummary: [...tools.values()].map(({tool, calls, failed}) =>
          failed ? {tool, calls, failed} : {tool, calls},
        ),
        jobs: [...jobs.values()],
        errors,
        usage,
      };
    },
  };
}

// What the model is told about its own workspace. Without this it has a
// directory full of source and no reason to believe it is the product under
// discussion, and it cannot know that `git log` will fail — the tree is
// unpacked from an archive and has no history in it.
function workspaceBriefing(repoInfo) {
  if (!repoInfo) return '';
  return [
    '',
    '--- WORKSPACE ---',
    `The repository ${repoInfo.repo} is checked out at ./${repoInfo.path.split('/').pop()} (ref ${repoInfo.ref}).`,
    'It is an unpacked archive, not a clone: there is no .git directory and git commands will not work.',
    'For history use the platform_repo_history tool, and platform_file_at_ref to read a file at another ref.',
    'You cannot push, and you have no credential that could. To change the repository, end your turn with a proposal describing the change; a person approves it and the platform commits it.',
  ].join('\n');
}

// Names whose value must never reach the harness. The runner secret is the
// sharp one: with it the model could claim runs, finalize other agents' turns
// and impersonate this runner to the control plane. The pattern is deliberately
// broad because the risk is a variable added later that nobody re-audits — a
// harmless variable being blanked costs nothing, the reverse is a breach.
const SENSITIVE_ENV = /(SECRET|TOKEN|PASSWORD|CREDENTIAL|_KEY$|APIKEY|API_KEY)/i;

// jcode needs a real OPENROUTER_API_KEY, supplied per run from the claim, so it
// is set explicitly by the caller *after* this spread and must not be scrubbed
// back out here.
const ENV_SCRUB_EXEMPT = new Set(['OPENROUTER_API_KEY']);

// Blank rather than delete: the SDK spreads process.env first, so a key we omit
// simply survives from the parent. Only an explicit empty value overrides it.
export function scrubbedHostEnv(source = process.env) {
  const scrubbed = {};
  for (const name of Object.keys(source)) {
    if (ENV_SCRUB_EXEMPT.has(name)) continue;
    if (SENSITIVE_ENV.test(name)) scrubbed[name] = '';
  }
  return scrubbed;
}

export async function runJcodeTurn({claim, workspace, jcodeHome, moduleDir, runtimeUrl, agentUid, agentGid, repoInfo, onProgress}) {
  const allowedTools = toolsFor(claim.tool_profile);
  await mkdir(jcodeHome, {recursive: true, mode: 0o700});
  const capabilityBroker = await createCapabilityBroker(jcodeHome, claim.capability_token);
  const mcpPath = await writeMcpConfig(workspace, {
    runtimeUrl,
    runId: claim.run_id,
    capabilitySocket: capabilityBroker.socketPath,
    moduleDir,
  });
  await handOver([
    workspace,
    join(workspace, '.jcode'),
    mcpPath,
    jcodeHome,
    join(jcodeHome, 'run'),
    capabilityBroker.socketPath,
  ], agentUid, agentGid);
  if (repoInfo?.path) await handOverTree(repoInfo.path, agentUid, agentGid);

  let client;
  try {
    client = await JcodeClient.launch({
    // Stable per agent, so a follow-up mention in the same thread resumes a
    // session rather than paying to rebuild context from nothing.
    jcodeHome,
    workingDir: workspace,
    // See note 1 in the header. Without this the instance symlinks whatever
    // provider credentials exist on the image and bills them.
    inheritLogins: false,
    clientName: 'code92-agent-runner/1.0',
    env: {
      // Must come first: everything after it is an intentional grant.
      ...scrubbedHostEnv(),
      // The only credential the harness gets, supplied per run by the
      // authenticated control plane and never written to disk.
      OPENROUTER_API_KEY: claim.openrouter_api_key,
      JCODE_TOOLS: allowedTools.join(','),
      JCODE_DISABLED_TOOLS: DENIED_TOOLS.join(','),
      // A harness that updates itself mid-run is a harness whose behaviour is
      // not the one that was reviewed.
      JCODE_NO_UPDATE: '1',
      JCODE_AUTO_UPDATE: '0',
      // On by default. jcode's own notice says it reports session activity,
      // tool counts and exit reasons — no prompts or code. That is still an
      // outbound stream about an internal command centre's private work,
      // leaving a container whose entire egress policy is two hosts.
      JCODE_NO_TELEMETRY: '1',
      JCODE_NO_COLOR: '1',
      HOME: jcodeHome,
      LANG: 'C.UTF-8',
    },
    startupTimeoutMs: 30_000,
    // Forward the daemon's stderr to the container log. When the bridge dies
    // mid-run the SDK reports only "harness connection closed" — the socket is
    // gone, and it never knew why. The reason is on the daemon's stderr, which
    // is otherwise piped into a buffer that is only read on a startup failure.
    // Noisy by design: a crash we cannot explain costs more than the noise.
    inheritStderr: true,
    });
  } catch (error) {
    await capabilityBroker.close().catch(() => {});
    await unlink(capabilityBroker.socketPath).catch(() => {});
    throw error;
  }

  const collector = createCollector();
  let sessionId = null;

  try {
    // Resume if the platform remembers a session for this thread and the
    // instance still has it. A session id that no longer resolves is not an
    // error worth failing a run over — the thread simply starts cold, which is
    // what would have happened anyway.
    if (claim.jcode_session_id) {
      try {
        const attached = await client.attachSession(claim.jcode_session_id);
        sessionId = attached.session_id;
      } catch {
        sessionId = null;
      }
    }
    if (!sessionId) {
      const created = await client.createSession(workspace);
      sessionId = created.session_id;
    }

    if (claim.model) {
      // Rejects rather than silently staying on the previous model, so a bad
      // slug surfaces as this run's error instead of an unnoticed substitution.
      await client.setModel(sessionId, claim.model);
    }

    // See note 2. Only meaningful if the bridge issues prompts at all.
    const gatesPermissions = client.supports('permissions');

    // Budgets, spent gracefully.
    //
    // Both of these used to end a run by killing it: the wall clock rejected the
    // race in server.mjs and four minutes of tool work went in the bin with
    // nothing to show the person who asked. A soft interrupt injects into the
    // running turn instead, so the model stops working and answers with what it
    // already found. An incomplete answer is worth more than a failed run.
    //
    // The hard timeout in server.mjs stays as the backstop for a harness that
    // has stopped listening altogether.
    const maxSteps = Number(claim.max_tool_steps) || 0;
    const runSeconds = Number(claim.max_run_seconds) || 0;
    let steps = 0;
    let wrappedUp = false;

    const wrapUp = (reason) => {
      if (wrappedUp) return;
      wrappedUp = true;
      onProgress?.('executing', 'wrap_up', {reason});
      void client
        .softInterrupt(
          sessionId,
          `You have reached this run's ${reason === 'tool_budget' ? 'tool-call' : 'time'} ` +
            'budget. Stop calling tools and reply now with what you have already ' +
            'established, saying plainly what you did not get to.',
          true,
        )
        .catch(() => {});
    };

    // Leave a quarter of the budget to actually compose the answer. Interrupting
    // at the limit itself would land while the wall clock is already expiring.
    const softDeadline = runSeconds
      ? setTimeout(() => wrapUp('time_budget'), runSeconds * 750).unref()
      : null;

    const result = await client.run(sessionId, `${claim.prompt}${workspaceBriefing(repoInfo)}`, {
      autoApprove: false,
      onEvent: (event) => {
        collector.observe(event);
        if (event.ev === 'permission_request' && gatesPermissions) {
          // Allow only what was already allow-listed. The decision is recorded
          // either way: a denied prompt is the most interesting line in the
          // audit trail of a run that touched a repo.
          const decision = allowedTools.includes(event.tool_name) ? 'allow' : 'deny';
          void client
            .respondToPermission(sessionId, event.request_id, decision)
            .catch(() => {});
          onProgress?.('executing', 'permission', {
            tool: event.tool_name,
            decision,
            description: String(event.description ?? '').slice(0, 300),
          });
          return;
        }
        if (event.ev === 'tool_start') {
          steps += 1;
          onProgress?.('executing', 'tool', {tool: event.name, step: steps});
          // max_tool_steps was stored, sent in the claim and then read by
          // nothing, so a 12-step agent could take 19. This is where it binds.
          if (maxSteps && steps >= maxSteps) wrapUp('tool_budget');
        }
        if (event.ev === 'background_progress') {
          onProgress?.('waiting', 'background', {
            task: event.task_id,
            label: String(event.label ?? '').slice(0, 200),
            done: Boolean(event.done),
          });
        }
      },
    });

    if (softDeadline) clearTimeout(softDeadline);
    const collected = collector.result();
    return {
      output: result.text,
      sessionId,
      // Prefer the turn's own accounting; the streamed token_usage event is a
      // fallback for a turn that ended without one.
      usage: result.usage ?? collected.usage,
      toolSummary: collected.toolSummary,
      jobs: collected.jobs,
      errors: collected.errors,
    };
  } finally {
    // Stops the private instance and removes an ephemeral home. A stable home
    // is kept, which is the point of resumable sessions.
    await client.close().catch(() => {});
    await capabilityBroker.close().catch(() => {});
    await unlink(capabilityBroker.socketPath).catch(() => {});
  }
}

export const __test__ = {
  OPERATOR_TOOLS,
  DENIED_TOOLS,
  toolsFor,
  createCollector,
  writeMcpConfig,
  createCapabilityBroker,
  workspaceBriefing,
};
