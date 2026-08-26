// thread-agent: runs one agent turn against OpenRouter and writes back a message
// plus, at most, proposals.
//
// Invoked three ways:
//   - by the Next.js Server Action immediately after a message mentioning an
//     agent is inserted (Authorization: the poster's JWT),
//   - by functions/agent-tick.ts draining pending agent_runs (service key),
//   - by an admin saving or testing the OpenRouter credential.
//
// The single rule this file exists to honour: an agent NEVER mutates the record.
// It writes a message and rows in agent_proposals. Everything else happens later,
// in decide_agent_proposal, under an approving human's own authority.
//
// The SDK arrives through Deno's npm: specifier and this directory is excluded
// from tsconfig.json, so no local types exist for these clients. `any` is an
// accurate description of what is knowable here, not a shortcut — the same
// justification as functions/github-sync.ts and functions/trend-scan.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminClient } from 'npm:@insforge/sdk';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// KILL SWITCH. While this is false no agent run does any work: no OpenRouter
// call, no spend. Queued runs are marked 'skipped' rather than left pending, so
// the queue does not silently grow behind a switched-off pipeline. Re-enabling is
// this constant plus a redeploy:
//
//   npx @insforge/cli functions deploy thread-agent --file functions/thread-agent.ts
const PIPELINE_ENABLED = true;

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
const OPENROUTER_TIMEOUT_MS = 45000;

// How much conversation the agent sees. Enough to follow a discussion, bounded so
// a long-running channel cannot grow the prompt without limit.
const MAX_THREAD_MESSAGES = 40;
const MAX_BODY_CHARS = 4000;
const MAX_PROPOSALS_PER_RUN = 3;

// How much of the product's knowledge base an agent is given.
//
// Everything linked to the product would be both slow and expensive — the
// context is rebuilt on every single run, and it is billed every time. These
// bounds are what keeps "the agent knows the product's documents" from becoming
// "every run re-reads the whole library".
const MAX_KNOWLEDGE_ITEMS = 6;
const MAX_KNOWLEDGE_CHARS = 4000;
const MAX_KNOWLEDGE_FILE_BYTES = 200_000;

// Only formats that are text on disk. A PDF or a .docx downloaded and decoded as
// UTF-8 is binary noise that would burn tokens and teach the agent nothing, so
// those are listed by title alone.
const READABLE_FILE_TYPES = [
  'text/markdown',
  'text/x-markdown',
  'text/plain',
  'text/csv',
  'application/json',
  'application/x-yaml',
  'text/yaml',
];

const READABLE_FILE_EXTENSIONS = ['.md', '.markdown', '.txt', '.csv', '.json', '.yml', '.yaml'];

function isReadableFile(mimeType: string | null, fileName: string | null): boolean {
  if (mimeType && READABLE_FILE_TYPES.includes(mimeType.toLowerCase())) return true;
  const name = (fileName ?? '').toLowerCase();
  // A .md uploaded by a browser that declared no type is the common case, so the
  // extension is checked too rather than trusting the mime alone.
  return READABLE_FILE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

const PROPOSAL_ACTIONS = [
  'knowledge_note',
  'task_create',
  'task_update',
  'status_update',
  'lifecycle_advance',
] as const;

// ============================================================
// Errors and responses
// ============================================================

class ActionError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function errorResponse(code: string, message: string, status = 400): Response {
  return jsonResponse({ error: { code, message } }, status);
}

// ============================================================
// Credential storage
// ============================================================
// Same shape as github-sync: AES-GCM under a secret that lives in this function's
// environment and never in the database. openrouter_connection has no grants to
// any client role, so this function is the only reader.

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
}

async function aesKey(): Promise<CryptoKey> {
  const raw = Deno.env.get('OPENROUTER_KEY_SECRET');
  if (!raw) {
    throw new ActionError('not_configured', 'OPENROUTER_KEY_SECRET secret is not set', 500);
  }
  const bytes = base64ToBytes(raw);
  if (bytes.length !== 32) {
    throw new ActionError(
      'not_configured',
      'OPENROUTER_KEY_SECRET must be 32 bytes, base64-encoded',
      500,
    );
  }
  return await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

async function encryptSecret(plain: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await aesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plain),
  );
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

async function decryptSecret(ciphertext: string, iv: string): Promise<string> {
  const key = await aesKey();
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(decrypted);
}

async function loadOpenRouterKey(admin: any): Promise<string> {
  const { data, error } = await admin.database
    .from('openrouter_connection')
    .select('key_ciphertext, key_iv')
    .eq('id', true)
    .limit(1);
  if (error) throw new ActionError('generic', `credential lookup failed: ${error.message}`, 500);

  const row = data?.[0];
  if (!row?.key_ciphertext || !row?.key_iv) {
    throw new ActionError(
      'not_configured',
      'no OpenRouter API key has been saved yet — an admin sets one in Settings',
    );
  }
  return await decryptSecret(row.key_ciphertext, row.key_iv);
}

// ============================================================
// OpenRouter
// ============================================================

type KeyInfo = {
  label: string | null;
  limit: number | null;
  usage: number | null;
  is_free_tier: boolean | null;
};

// GET /api/v1/key describes the key that made the request. This is how the saved
// credential is validated, and how "should be a test key" becomes something the
// UI can actually report: a null limit means the key is uncapped.
async function fetchKeyInfo(apiKey: string): Promise<KeyInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(OPENROUTER_KEY_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new ActionError('invalid', 'OpenRouter rejected this key');
    }
    if (!res.ok) {
      throw new ActionError('generic', `OpenRouter key check failed (${res.status})`, 502);
    }
    const body = await res.json();
    const d = body?.data ?? {};
    return {
      label: d.label ?? null,
      limit: typeof d.limit === 'number' ? d.limit : null,
      usage: typeof d.usage === 'number' ? d.usage : null,
      is_free_tier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : null,
    };
  } catch (e) {
    if (e instanceof ActionError) throw e;
    if ((e as Error).name === 'AbortError') {
      throw new ActionError('generic', 'OpenRouter key check timed out', 504);
    }
    throw new ActionError('generic', `OpenRouter key check failed: ${(e as Error).message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

type Completion = {
  text: string;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
};

// The model slug is passed through exactly as the admin pasted it from
// openrouter.ai/models. We do not validate it against a list of our own: that
// namespace belongs to OpenRouter and changes without us, so an unknown slug
// should fail with OpenRouter's error rather than ours.
async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  temperature: number,
  maxTokens: number,
): Promise<Completion> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Attribution headers OpenRouter uses for its dashboard rankings.
        'HTTP-Referer': 'https://5nteb3xb.insforge.site',
        'X-Title': 'Code 92 Command Center',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        // Asks OpenRouter to return what the call actually cost, so agent_runs
        // records real spend rather than an estimate from a price table we would
        // have to keep in sync.
        usage: { include: true },
      }),
      signal: controller.signal,
    });

    if (res.status === 401 || res.status === 403) {
      throw new ActionError('invalid', 'OpenRouter rejected the stored API key');
    }
    if (res.status === 402) {
      throw new ActionError('invalid', 'OpenRouter credit exhausted for this key');
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new ActionError('generic', `OpenRouter error ${res.status}: ${detail}`, 502);
    }

    const body = await res.json();

    // OpenRouter surfaces upstream provider failures in a 200 body.
    if (body?.error) {
      throw new ActionError('generic', `OpenRouter: ${body.error.message ?? 'unknown error'}`, 502);
    }

    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new ActionError('generic', 'OpenRouter returned an empty completion', 502);
    }

    const usage = body?.usage ?? {};
    return {
      text,
      promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null,
      completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null,
      costUsd: typeof usage.cost === 'number' ? usage.cost : null,
    };
  } catch (e) {
    if (e instanceof ActionError) throw e;
    if ((e as Error).name === 'AbortError') {
      throw new ActionError('generic', 'OpenRouter call timed out', 504);
    }
    throw new ActionError('generic', `OpenRouter call failed: ${(e as Error).message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// Authorization
// ============================================================

type Caller = { userId: string; role: string; isAgentTick: boolean };

// The tick and the schedule authenticate with a shared secret rather than a JWT,
// because there is no user behind a 03:00 run.
function isServiceCall(req: Request): boolean {
  const secret = Deno.env.get('AGENT_TICK_SECRET');
  if (!secret) return false;
  const header = req.headers.get('Authorization') || '';
  return header.replace(/^Bearer\s+/i, '').trim() === secret;
}

async function resolveCaller(req: Request, admin: any, baseUrl: string): Promise<Caller | null> {
  if (isServiceCall(req)) {
    return { userId: '', role: 'service', isAgentTick: true };
  }

  const header = req.headers.get('Authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  const res = await fetch(`${baseUrl}/api/auth/sessions/current`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;

  const body = await res.json();
  const userId = body?.user?.id ?? body?.data?.user?.id;
  if (!userId) return null;

  const { data } = await admin.database
    .from('team_members')
    .select('role, is_active')
    .eq('user_id', userId)
    .limit(1);

  const row = data?.[0];
  if (!row?.is_active) return null;

  return { userId, role: row.role, isAgentTick: false };
}

// ============================================================
// Context assembly
// ============================================================

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Everything the agent is told about the product its channel is bound to. Kept
// as compact prose rather than raw JSON: models follow a briefing better than
// they follow a dump, and it keeps the prompt cheap.
async function buildProductContext(admin: any, productId: string): Promise<string> {
  const [products, tasks, phases, updates] = await Promise.all([
    admin.database
      .from('products')
      .select('name, slug, stage, health, description, keywords, next_review_at, last_status_update_at')
      .eq('id', productId)
      .limit(1),
    admin.database
      .from('product_tasks')
      .select('id, title, status, due_date, assignee_id')
      .eq('product_id', productId)
      .eq('status', 'pending')
      .limit(25),
    admin.database
      .from('product_lifecycle_phases')
      .select('id, phase, state, entered_at')
      .eq('product_id', productId)
      .limit(12),
    admin.database
      .from('status_updates')
      .select('health, stage, summary, created_at')
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  const p = products.data?.[0];
  if (!p) return '';

  const lines: string[] = [];
  lines.push(`## Bound product: ${p.name} (${p.slug})`);
  lines.push(`Stage: ${p.stage} · Health: ${p.health}`);
  if (p.description) lines.push(`Description: ${truncate(p.description, 500)}`);
  if (p.keywords?.length) lines.push(`Keywords: ${p.keywords.join(', ')}`);
  if (p.next_review_at) lines.push(`Next review due: ${p.next_review_at}`);
  lines.push(`Last status update: ${p.last_status_update_at ?? 'never'}`);

  if (phases.data?.length) {
    lines.push('');
    lines.push('### Lifecycle phases');
    for (const ph of phases.data) {
      lines.push(`- ${ph.phase}: ${ph.state} (phase_id ${ph.id})`);
    }
  }

  if (tasks.data?.length) {
    lines.push('');
    lines.push('### Open work items');
    for (const t of tasks.data) {
      lines.push(`- ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''} — task_id ${t.id}`);
    }
  }

  if (updates.data?.length) {
    lines.push('');
    lines.push('### Recent status updates');
    for (const u of updates.data) {
      lines.push(`- ${u.created_at}: ${u.health}${u.stage ? `/${u.stage}` : ''} — ${truncate(u.summary, 300)}`);
    }
  }

  const knowledge = await buildProductKnowledge(admin, productId);
  if (knowledge) {
    lines.push('');
    lines.push(knowledge);
  }

  return lines.join('\n');
}

// Everything the team has filed against this product: notes and articles written
// in the knowledge base, and uploaded source documents. Markdown and other text
// formats are read out of storage so the agent works from what the document
// actually says rather than from its filename.
async function buildProductKnowledge(admin: any, productId: string): Promise<string> {
  const { data: links, error: linkError } = await admin.database
    .from('knowledge_item_products')
    .select('item_id')
    .eq('product_id', productId);

  // A failure here is the difference between "this product has no documents" and
  // "the lookup broke", and the prompt cannot tell them apart. Log it so the
  // second case is not silently served as the first.
  if (linkError) {
    console.error('[thread-agent] knowledge link lookup failed', linkError.message);
    return '';
  }

  const ids = (links ?? []).map((l: { item_id: string }) => l.item_id);
  if (ids.length === 0) return '';

  const { data: items } = await admin.database
    .from('knowledge_items')
    .select('id, kind, title, content, file_key, file_bucket, file_name, mime_type, size_bytes, status, updated_at')
    .in('id', ids)
    .is('archived_at', null)
    .order('updated_at', { ascending: false })
    .limit(MAX_KNOWLEDGE_ITEMS);

  if (!items?.length) return '';

  const lines: string[] = ['### Product knowledge'];

  for (const item of items) {
    const header = `- **${item.title}** (${item.kind}${item.status ? `, ${item.status}` : ''})`;

    // A written note carries its own text; a source document carries a file.
    let text: string = typeof item.content === 'string' ? item.content.trim() : '';

    if (!text && item.file_key) {
      if (isReadableFile(item.mime_type, item.file_name)) {
        text = await readKnowledgeFile(admin, item);
      } else {
        lines.push(`${header} — file ${item.file_name ?? 'attached'}, not a text format`);
        continue;
      }
    }

    if (!text) {
      lines.push(header);
      continue;
    }

    lines.push(header);
    lines.push(truncate(text, MAX_KNOWLEDGE_CHARS));
  }

  return lines.join('\n');
}

// Reading one document out of storage. Failures are swallowed to a note in the
// prompt: a document the agent cannot open should make it say so, not make the
// whole run fail and cost the reader their answer.
async function readKnowledgeFile(admin: any, item: any): Promise<string> {
  if (typeof item.size_bytes === 'number' && item.size_bytes > MAX_KNOWLEDGE_FILE_BYTES) {
    return '';
  }
  try {
    const bucket = item.file_bucket || 'knowledge';
    const { data, error } = await admin.storage.from(bucket).download(item.file_key);
    if (error || !data) return '';
    const text = await data.text();
    return text.trim();
  } catch {
    return '';
  }
}

async function buildConversation(
  admin: any,
  channelId: string,
  triggerMessageId: string,
): Promise<{ transcript: string; rootId: string }> {
  const { data: trigger } = await admin.database
    .from('messages')
    .select('id, parent_id, channel_id')
    .eq('id', triggerMessageId)
    .limit(1);

  const t = trigger?.[0];
  // A mention inside a thread gets that thread; a mention in the channel gets
  // recent channel history. Either way the agent replies into the same place.
  const rootId = t?.parent_id ?? t?.id ?? triggerMessageId;

  const { data: rows } = t?.parent_id
    ? await admin.database
        .from('messages')
        .select('id, author_id, body, kind, created_at')
        .or(`id.eq.${rootId},parent_id.eq.${rootId}`)
        .order('created_at', { ascending: true })
        .limit(MAX_THREAD_MESSAGES)
    : await admin.database
        .from('messages')
        .select('id, author_id, body, kind, created_at')
        .eq('channel_id', channelId)
        .is('parent_id', null)
        .order('created_at', { ascending: false })
        .limit(MAX_THREAD_MESSAGES);

  const ordered = t?.parent_id ? (rows ?? []) : (rows ?? []).slice().reverse();

  const authorIds = [...new Set(ordered.map((m: any) => m.author_id).filter(Boolean))];
  const names = new Map<string, string>();
  if (authorIds.length) {
    const { data: members } = await admin.database
      .from('team_members')
      .select('user_id, display_name')
      .in('user_id', authorIds);
    for (const m of members ?? []) names.set(m.user_id, m.display_name);
  }

  const transcript = ordered
    .filter((m: any) => !m.deleted_at)
    .map((m: any) => {
      const who = m.kind === 'system' ? 'system' : (names.get(m.author_id) ?? 'unknown');
      return `[${m.created_at}] ${who}: ${truncate(m.body, MAX_BODY_CHARS)}`;
    })
    .join('\n');

  return { transcript, rootId };
}

// ============================================================
// The prompt
// ============================================================
// The protocol is described to the model in the system message rather than
// enforced with response_format, because the model slug is whatever an admin
// pasted and structured-output support varies by provider. Parsing is defensive
// on the other side: unparseable output degrades to a plain reply with no
// proposals, which is a bad answer rather than a broken feature.

function buildSystemPrompt(agent: any, allowed: string[]): string {
  const schema: Record<string, string> = {
    knowledge_note:
      '{"action":"knowledge_note","reasoning":"why","payload":{"title":"...","content":"markdown"}}',
    task_create:
      '{"action":"task_create","reasoning":"why","payload":{"title":"...","notes":"...","due_date":"YYYY-MM-DD","assignee_id":"uuid-or-omit"}}',
    task_update:
      '{"action":"task_update","reasoning":"why","payload":{"task_id":"uuid","title":"...","status":"pending|completed","due_date":"YYYY-MM-DD"}}',
    status_update:
      '{"action":"status_update","reasoning":"why","payload":{"health":"green|yellow|red","stage":"idea|development|beta|live|paused|sunset","summary":"one line","details":"markdown"}}',
    lifecycle_advance:
      '{"action":"lifecycle_advance","reasoning":"why","payload":{"phase_id":"uuid","state":"in_progress|blocked|complete"}}',
  };

  return [
    agent.system_prompt.trim(),
    '',
    '---',
    '',
    `You are @${agent.handle}, an agent inside the Code 92 Command Center — an internal`,
    'bilingual (English/Arabic) console where a small team tracks its AI product portfolio.',
    'You are talking in a team chat channel alongside human colleagues.',
    '',
    '## How you answer',
    '',
    '- Reply in the language the thread is using. If the thread is in Arabic, answer in Arabic.',
    '- When the briefing includes product knowledge, answer from what those documents',
    '  actually say and name the one you used. If they do not cover the question, say so',
    '  rather than filling the gap from general knowledge.',
    '- Be brief. This is a chat message, not a report. No preamble, no sign-off.',
    '- You may be wrong. Say what you are unsure about rather than guessing confidently.',
    '',
    '## What you can and cannot do',
    '',
    'You CANNOT change anything. You have no write access to any record. What you can do is',
    'PROPOSE a change, which appears in the thread as a card a human colleague approves or',
    'rejects. If they approve it, the change is made under THEIR name and THEIR permissions,',
    'not yours.',
    '',
    allowed.length
      ? `You may propose only these actions: ${allowed.join(', ')}.`
      : 'You may not propose any actions. Answer in prose only.',
    '',
    allowed.includes('lifecycle_advance')
      ? 'For lifecycle_advance: never write a waiver or justification for skipping a required\nartifact. If a gate is missing evidence, say so plainly and let the admin decide. The\nwaiver wording must be theirs.'
      : '',
    '',
    '## Output format',
    '',
    'Reply with a single JSON object and nothing else — no code fence, no commentary:',
    '',
    '{',
    '  "reply": "your chat message, in markdown",',
    '  "proposals": []',
    '}',
    '',
    allowed.length
      ? [
          `Put at most ${MAX_PROPOSALS_PER_RUN} proposals in the array, and only when the conversation`,
          'genuinely calls for one. An empty array is the normal case — most messages deserve an',
          'answer, not a form to sign. Each proposal looks like:',
          '',
          ...allowed.map((a) => schema[a]).filter(Boolean),
        ].join('\n')
      : 'Always leave "proposals" as an empty array.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

// Models wrap JSON in fences, prefix it with prose, or return prose alone. All
// three are recoverable; only the last costs us the proposals.
function parseModelOutput(raw: string): { reply: string; proposals: any[] } {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  const candidates = [stripped];
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(stripped.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object' && typeof parsed.reply === 'string') {
        return {
          reply: parsed.reply,
          proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
        };
      }
    } catch {
      // try the next shape
    }
  }

  return { reply: raw.trim(), proposals: [] };
}

// ============================================================
// Running one agent turn
// ============================================================

async function finishRun(admin: any, runId: string, patch: Record<string, unknown>) {
  await admin.database
    .from('agent_runs')
    .update({ finished_at: new Date().toISOString(), ...patch })
    .eq('id', runId);
}

async function executeRun(admin: any, runId: string): Promise<Record<string, unknown>> {
  const { data: runs } = await admin.database
    .from('agent_runs')
    .select('id, agent_id, trigger_message_id, schedule_id, channel_id, status')
    .eq('id', runId)
    .limit(1);

  const run = runs?.[0];
  if (!run) throw new ActionError('invalid', 'run not found');

  // Claim it. A run already past 'pending' has been picked up by another
  // invocation — the ping and the tick race by design, and this is where the
  // race is settled.
  if (run.status !== 'pending') {
    return { run_id: runId, status: run.status, claimed: false };
  }

  const { data: claimed } = await admin.database
    .from('agent_runs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', runId)
    .eq('status', 'pending')
    .select('id');

  if (!claimed?.length) {
    return { run_id: runId, status: 'running', claimed: false };
  }

  if (!PIPELINE_ENABLED) {
    await finishRun(admin, runId, { status: 'skipped', error: 'pipeline disabled' });
    return { run_id: runId, status: 'skipped' };
  }

  try {
    const { data: agents } = await admin.database
      .from('agents')
      .select(
        'user_id, handle, display_name, system_prompt, model, allowed_actions, temperature, max_output_tokens, enabled, budget_usd_month',
      )
      .eq('user_id', run.agent_id)
      .limit(1);

    const agent = agents?.[0];
    if (!agent) throw new ActionError('invalid', 'agent no longer exists');
    if (!agent.enabled) throw new ActionError('invalid', `agent ${agent.handle} is disabled`);

    // Budget gate, before the call rather than after it. trend-scan is the
    // reason this is not a dashboard someone checks later.
    const { data: spent } = await admin.database.rpc('agent_spend_this_month', {
      p_agent_id: agent.user_id,
    });
    const spendToDate = Number(spent ?? 0);
    if (spendToDate >= Number(agent.budget_usd_month)) {
      await finishRun(admin, runId, {
        status: 'skipped',
        error: `monthly budget reached ($${spendToDate.toFixed(4)} of $${agent.budget_usd_month})`,
      });
      return { run_id: runId, status: 'skipped', reason: 'budget' };
    }

    const { data: channels } = await admin.database
      .from('channels')
      .select('id, name, slug, kind, product_id, topic, archived_at')
      .eq('id', run.channel_id)
      .limit(1);

    const channel = channels?.[0];
    if (!channel) throw new ActionError('invalid', 'channel no longer exists');
    if (channel.archived_at) throw new ActionError('invalid', 'channel is archived');

    const allowed: string[] = (agent.allowed_actions ?? []).filter((a: string) =>
      (PROPOSAL_ACTIONS as readonly string[]).includes(a),
    );

    // ---------- assemble ----------
    const productContext = channel.product_id
      ? await buildProductContext(admin, channel.product_id)
      : '';

    let transcript = '';
    let rootId: string | null = null;

    if (run.trigger_message_id) {
      const conv = await buildConversation(admin, channel.id, run.trigger_message_id);
      transcript = conv.transcript;
      rootId = conv.rootId;
    } else if (run.schedule_id) {
      const { data: scheds } = await admin.database
        .from('agent_schedules')
        .select('prompt, name')
        .eq('id', run.schedule_id)
        .limit(1);
      const sched = scheds?.[0];
      transcript = sched
        ? `[scheduled task: ${sched.name}]\n${sched.prompt}`
        : '[scheduled run with no task attached]';
    }

    const userContent = [
      channel.kind === 'product'
        ? `You are in #${channel.slug}, the channel bound to a product.`
        : `You are in #${channel.slug}.`,
      channel.topic ? `Channel topic: ${channel.topic}` : '',
      '',
      productContext,
      '',
      '## Conversation',
      '',
      transcript || '(no messages yet)',
    ]
      .filter(Boolean)
      .join('\n');

    // ---------- call ----------
    const apiKey = await loadOpenRouterKey(admin);
    const completion = await callOpenRouter(
      apiKey,
      agent.model,
      [
        { role: 'system', content: buildSystemPrompt(agent, allowed) },
        { role: 'user', content: userContent },
      ],
      Number(agent.temperature),
      agent.max_output_tokens,
    );

    const { reply, proposals } = parseModelOutput(completion.text);

    // ---------- write back ----------
    const { data: posted, error: postError } = await admin.database
      .from('messages')
      .insert([
        {
          channel_id: channel.id,
          parent_id: rootId,
          author_id: agent.user_id,
          body: reply.slice(0, 20000),
          kind: 'agent',
        },
      ])
      .select('id');

    if (postError) {
      throw new ActionError('generic', `could not post reply: ${postError.message}`, 500);
    }

    const messageId = posted?.[0]?.id;
    let written = 0;

    // Defence in depth. decide_agent_proposal checks the allowlist again at
    // approval time, and that check is the one that matters; this one keeps a
    // disallowed proposal from ever being rendered as a card in the first place.
    for (const p of proposals.slice(0, MAX_PROPOSALS_PER_RUN)) {
      if (!p || typeof p !== 'object') continue;
      if (!allowed.includes(p.action)) continue;
      if (typeof p.reasoning !== 'string' || !p.reasoning.trim()) continue;
      if (!p.payload || typeof p.payload !== 'object') continue;

      const payload = { ...p.payload };
      // The waiver wording belongs to the approving admin. Strip anything the
      // model put here so it cannot reach the register even by accident — the
      // SQL ignores it too, and neither layer relies on the other.
      delete payload.waiver_reason;
      delete payload.self_approved;

      const { error: propError } = await admin.database.from('agent_proposals').insert([
        {
          message_id: messageId,
          channel_id: channel.id,
          agent_id: agent.user_id,
          run_id: runId,
          product_id: channel.product_id ?? null,
          action: p.action,
          payload,
          reasoning: p.reasoning.slice(0, 5000),
        },
      ]);

      if (!propError) written += 1;
    }

    await finishRun(admin, runId, {
      status: 'succeeded',
      prompt_tokens: completion.promptTokens,
      completion_tokens: completion.completionTokens,
      cost_usd: completion.costUsd,
      model: agent.model,
    });

    return {
      run_id: runId,
      status: 'succeeded',
      message_id: messageId,
      proposals: written,
      cost_usd: completion.costUsd,
    };
  } catch (e) {
    const message = e instanceof ActionError ? e.message : (e as Error).message;
    await finishRun(admin, runId, { status: 'failed', error: message.slice(0, 500) });
    throw e;
  }
}

// ============================================================
// Actions
// ============================================================

function requireAdmin(caller: Caller) {
  if (caller.isAgentTick) return;
  if (caller.role !== 'admin') {
    throw new ActionError('forbidden', 'admins only', 403);
  }
}

// Validates the key against OpenRouter before storing it, so a typo is caught at
// save time rather than at 03:00 by a schedule. What comes back also tells the
// settings panel whether this is a capped (test) key.
async function actionSaveKey(admin: any, caller: Caller, body: any) {
  requireAdmin(caller);

  const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : '';
  if (!apiKey) throw new ActionError('invalid', 'api_key is required');
  if (!apiKey.startsWith('sk-or-')) {
    throw new ActionError(
      'invalid',
      'that does not look like an OpenRouter key — they begin with sk-or-',
    );
  }

  const info = await fetchKeyInfo(apiKey);
  const encrypted = await encryptSecret(apiKey);

  const { error } = await admin.database
    .from('openrouter_connection')
    .update({
      key_ciphertext: encrypted.ciphertext,
      key_iv: encrypted.iv,
      key_last_four: apiKey.slice(-4),
      key_label: info.label,
      key_limit_usd: info.limit,
      key_usage_usd: info.usage,
      key_is_free_tier: info.is_free_tier,
      validated_at: new Date().toISOString(),
      validation_error: null,
      connected_by: caller.userId || null,
    })
    .eq('id', true);

  if (error) throw new ActionError('generic', `could not save key: ${error.message}`, 500);

  return {
    saved: true,
    last_four: apiKey.slice(-4),
    label: info.label,
    limit_usd: info.limit,
    // The "should be a test key" signal, reported rather than enforced: an org
    // that caps spend at the account level is not doing anything wrong.
    is_capped: info.limit !== null,
    is_free_tier: info.is_free_tier,
  };
}

async function actionTestKey(admin: any, caller: Caller) {
  requireAdmin(caller);

  const apiKey = await loadOpenRouterKey(admin);
  try {
    const info = await fetchKeyInfo(apiKey);
    await admin.database
      .from('openrouter_connection')
      .update({
        key_label: info.label,
        key_limit_usd: info.limit,
        key_usage_usd: info.usage,
        key_is_free_tier: info.is_free_tier,
        validated_at: new Date().toISOString(),
        validation_error: null,
      })
      .eq('id', true);
    return { ok: true, label: info.label, limit_usd: info.limit, usage_usd: info.usage };
  } catch (e) {
    const message = e instanceof ActionError ? e.message : (e as Error).message;
    await admin.database
      .from('openrouter_connection')
      .update({ validation_error: message.slice(0, 500), validated_at: new Date().toISOString() })
      .eq('id', true);
    throw e;
  }
}

async function actionClearKey(admin: any, caller: Caller) {
  requireAdmin(caller);
  const { error } = await admin.database
    .from('openrouter_connection')
    .update({
      key_ciphertext: null,
      key_iv: null,
      key_last_four: null,
      key_label: null,
      key_limit_usd: null,
      key_usage_usd: null,
      key_is_free_tier: null,
      validated_at: null,
      validation_error: null,
    })
    .eq('id', true);
  if (error) throw new ActionError('generic', `could not clear key: ${error.message}`, 500);
  return { cleared: true };
}

async function actionRun(admin: any, body: any) {
  const runId = typeof body?.run_id === 'string' ? body.run_id : '';
  if (!runId) throw new ActionError('invalid', 'run_id is required');
  return await executeRun(admin, runId);
}

// Drains whatever the ping missed. Bounded per invocation so one call cannot run
// away with the function's wall clock.
async function actionDrain(admin: any, body: any) {
  const limit = Math.min(Math.max(Number(body?.limit ?? 5), 1), 20);

  const { data: pending } = await admin.database
    .from('agent_runs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  const results: unknown[] = [];
  for (const row of pending ?? []) {
    try {
      results.push(await executeRun(admin, row.id));
    } catch (e) {
      results.push({ run_id: row.id, status: 'failed', error: (e as Error).message });
    }
  }
  return { drained: results.length, results };
}

// ============================================================
// Agent provisioning
// ============================================================
// An agent is a real auth.users row, which is what lets notifications.actor_id,
// status_updates.author_id and phase_transitions.actor_id keep working with no
// special cases anywhere. Creating one therefore needs the admin client, so it
// lives here rather than in a Server Action.
//
// The account is given a random password that is generated, used to satisfy
// signUp, and then discarded — it is never returned, logged or stored. Nothing
// signs in as an agent: the edge function writes on its behalf through the admin
// client, and no JWT is ever minted for these accounts.

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `A1!${bytesToBase64(bytes).replace(/[+/=]/g, 'x')}`;
}

async function actionProvisionAgent(admin: any, caller: Caller, body: any) {
  requireAdmin(caller);

  const handle = String(body?.handle ?? '').trim().toLowerCase();
  const displayName = String(body?.display_name ?? '').trim();
  const model = String(body?.model ?? '').trim();
  const systemPrompt = String(body?.system_prompt ?? '').trim();
  const allowed: string[] = Array.isArray(body?.allowed_actions) ? body.allowed_actions : [];

  if (!/^[a-z0-9][a-z0-9_-]{1,29}$/.test(handle)) {
    throw new ActionError('invalid', 'handle must be lowercase letters, digits, - or _');
  }
  if (!displayName) throw new ActionError('invalid', 'display_name is required');
  if (!systemPrompt) throw new ActionError('invalid', 'system_prompt is required');
  if (!/^[a-z0-9._-]+\/[A-Za-z0-9._-]+(:[A-Za-z0-9-]+)?$/.test(model)) {
    throw new ActionError(
      'invalid',
      'model must be an OpenRouter slug such as anthropic/claude-sonnet-4.5',
    );
  }
  for (const a of allowed) {
    if (!(PROPOSAL_ACTIONS as readonly string[]).includes(a)) {
      throw new ActionError('invalid', `unknown action: ${a}`);
    }
  }

  const { data: existing } = await admin.database
    .from('agents')
    .select('user_id')
    .eq('handle', handle)
    .limit(1);
  if (existing?.length) {
    throw new ActionError('invalid', `@${handle} already exists`);
  }

  // The address is synthetic and unroutable on purpose: nothing should ever mail
  // an agent, and a real-looking address invites someone to try.
  const email = `agent+${handle}@agents.code92.invalid`;

  // signUp() calls saveSessionFromResponse on whichever client it is invoked on,
  // which REPLACES that client's auth header with the newly created user's
  // token. Calling it on `admin` would silently downgrade the project API key to
  // the freshly minted agent's own session, and every write below would then run
  // as that agent — an ordinary `authenticated` role with no INSERT on
  // team_members. A throwaway client absorbs the session change instead.
  const signUpClient = createAdminClient({
    baseUrl: Deno.env.get('INSFORGE_BASE_URL')!,
    apiKey: Deno.env.get('API_KEY')!,
  });

  const { data: created, error: signUpError } = await signUpClient.auth.signUp({
    email,
    password: randomPassword(),
    name: displayName,
  });

  if (signUpError) {
    throw new ActionError('generic', `could not create agent account: ${signUpError.message}`, 500);
  }

  const userId = created?.user?.id ?? created?.data?.user?.id;
  if (!userId) throw new ActionError('generic', 'agent account created without an id', 500);

  // The account now exists and there is no API to remove it, so anything that
  // fails past this point names it. Without the id in the message a retry hits
  // the duplicate-email wall with no way to find what to clean up.
  const orphan = `the account ${email} (${userId}) was already created and must be removed before retrying`;

  const { error: memberError } = await admin.database.from('team_members').insert([
    { user_id: userId, display_name: displayName, role: 'member', is_active: true, kind: 'agent' },
  ]);
  if (memberError) {
    throw new ActionError(
      'generic',
      `could not add agent to roster: ${memberError.message} — ${orphan}`,
      500,
    );
  }

  const { error: agentError } = await admin.database.from('agents').insert([
    {
      user_id: userId,
      handle,
      display_name: displayName,
      description: body?.description ?? null,
      system_prompt: systemPrompt,
      model,
      allowed_actions: allowed,
      temperature: body?.temperature ?? 0.3,
      max_output_tokens: body?.max_output_tokens ?? 1500,
      budget_usd_month: body?.budget_usd_month ?? 5,
      created_by: caller.userId || null,
    },
  ]);

  if (agentError) {
    throw new ActionError('generic', `could not create agent: ${agentError.message} — ${orphan}`, 500);
  }

  return { user_id: userId, handle, model };
}

// ============================================================
// Entry point
// ============================================================

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return errorResponse('invalid', 'POST only', 405);
  }

  const baseUrl = Deno.env.get('INSFORGE_BASE_URL')!;
  const admin = createAdminClient({ baseUrl, apiKey: Deno.env.get('API_KEY')! });

  const caller = await resolveCaller(req, admin, baseUrl);
  if (!caller) return errorResponse('forbidden', 'Unauthorized', 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return errorResponse('invalid', 'body must be JSON');
  }

  try {
    switch (body?.action) {
      case 'save_key':
        return jsonResponse(await actionSaveKey(admin, caller, body));
      case 'test_key':
        return jsonResponse(await actionTestKey(admin, caller));
      case 'clear_key':
        return jsonResponse(await actionClearKey(admin, caller));
      case 'provision_agent':
        return jsonResponse(await actionProvisionAgent(admin, caller, body));
      case 'run':
        return jsonResponse(await actionRun(admin, body));
      case 'drain':
        return jsonResponse(await actionDrain(admin, body));
      default:
        return errorResponse('invalid', `unknown action: ${body?.action}`);
    }
  } catch (e) {
    if (e instanceof ActionError) {
      return errorResponse(e.code, e.message, e.status);
    }
    return errorResponse('generic', (e as Error).message.slice(0, 500), 500);
  }
}
