'use server';

import {revalidatePath} from 'next/cache';
import {z} from 'zod';

import {getOwnMembership, getSessionUser} from '@/lib/auth';
import {createInsForgeServerClient} from '@/lib/insforge/server';
import {
  MODEL_SLUG_PATTERN,
  PROPOSAL_ACTIONS,
  type Agent,
  type AgentProposal,
  type AgentRun,
  type AgentSchedule,
  type OpenRouterStatus
} from '@/lib/agents';

export type AgentActionResult = {ok: true} | {ok: false; error: string};

const uuid = z.string().uuid();

async function requireActiveCaller() {
  const [user, member] = await Promise.all([
    getSessionUser(),
    getOwnMembership()
  ]);
  if (!user || !member?.is_active) return null;
  return {user, member};
}

async function requireAdmin() {
  const caller = await requireActiveCaller();
  if (!caller || caller.member.role !== 'admin') return null;
  return caller;
}

// Edge-function errors arrive as {error: {code, message}} in the body rather
// than as a transport error, exactly as in lib/actions/github.ts.
//
// Only the codes thread-agent actually raises are passed through; anything else
// collapses to 'generic'. The panels render these through t(`errors.${code}`),
// so returning the function's prose message here would render as a missing
// translation key rather than as the message.
const KNOWN_ERROR_CODES = new Set([
  'generic',
  'forbidden',
  'invalid',
  'not_configured',
  'unreachable'
]);

function extractError(data: unknown, error: unknown): string | null {
  const body = data as {error?: {code?: string; message?: string}} | null;

  if (body?.error) {
    const code = body.error.code;
    if (code && KNOWN_ERROR_CODES.has(code)) return code;
    // The client only ever sees a code, so the function's own explanation would
    // be lost here. It is the only thing that says what actually broke.
    console.error('[thread-agent] unmapped error', body.error);
    return 'generic';
  }

  if (error) {
    const status = (error as {statusCode?: number}).statusCode;
    if (status === 401 || status === 403) return 'forbidden';
    // An undeployed function is a 404 from the invoke endpoint, and it is the
    // one failure here with a concrete fix, so it gets its own message rather
    // than the catch-all. Note InsForgeError carries an empty `message`, which
    // is why this branch reads statusCode and never the text.
    if (status === 404) return 'unreachable';
    console.error('[thread-agent] transport error', error);
    return 'generic';
  }

  // Every thread-agent action returns a JSON object, so an empty body means the
  // call never reached the function at all — an undeployed function 404s and the
  // SDK reports that as {data: null, error: null}. Falling through to success
  // here had provision_agent claim an agent was created when nothing happened,
  // and had the save_key branch below dereference null.
  if (!body || typeof body !== 'object') return 'unreachable';

  return null;
}

// Database errors reach the client as codes, not prose, for the same reason as
// in lib/actions/releases.ts: the panels render them through t(`errors.${code}`).
// The strings matched here are the RAISE EXCEPTION texts in the agent
// migrations, plus the ones advance_lifecycle_phase raises through
// decide_agent_proposal.
function mapDatabaseError(error: unknown): string {
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as {message: unknown}).message)
      : String(error ?? '');

  if (message.includes('has already been')) return 'alreadyDecided';
  if (message.includes('is not permitted to propose')) return 'notPermitted';
  if (message.includes('is disabled')) return 'agentDisabled';
  if (message.includes('only active members')) return 'forbidden';
  if (message.includes('require an admin')) return 'adminRequired';
  if (message.includes('waiver reason is required')) return 'waiverRequired';
  if (message.includes('not found') || message.includes('no longer exists')) {
    return 'notFound';
  }
  return 'generic';
}

const AGENT_COLUMNS =
  'user_id, handle, display_name, description, system_prompt, model, allowed_actions, temperature, max_output_tokens, enabled, budget_usd_month, created_at';

export async function getAgentsAction(): Promise<Agent[]> {
  const caller = await requireActiveCaller();
  if (!caller) return [];

  const insforge = await createInsForgeServerClient();
  const {data} = await insforge.database
    .from('agents')
    .select(AGENT_COLUMNS)
    .is('archived_at', null)
    .order('handle', {ascending: true});

  return (data ?? []) as unknown as Agent[];
}

// ============================================================
// The OpenRouter credential
// ============================================================
// The key itself never passes through this file in either direction on read:
// openrouter_connection_status() cannot return the ciphertext, and the table has
// no client grants at all. Saving sends the key straight to the edge function,
// which validates it against OpenRouter and stores it encrypted.

export async function getOpenRouterStatusAction(): Promise<OpenRouterStatus | null> {
  const caller = await requireAdmin();
  if (!caller) return null;

  const insforge = await createInsForgeServerClient();
  const {data, error} = await insforge.database.rpc('openrouter_connection_status');
  if (error) return null;

  const row = (Array.isArray(data) ? data[0] : data) as OpenRouterStatus | undefined;
  return row ?? null;
}

export async function isOpenRouterConfiguredAction(): Promise<boolean> {
  const caller = await requireActiveCaller();
  if (!caller) return false;

  const insforge = await createInsForgeServerClient();
  const {data, error} = await insforge.database.rpc('openrouter_is_configured');
  if (error) return false;
  return Boolean(Array.isArray(data) ? data[0] : data);
}

const keySchema = z.object({
  apiKey: z.string().trim().min(20).max(200)
});

export type SaveKeyResult =
  | {
      ok: true;
      lastFour: string;
      label: string | null;
      limitUsd: number | null;
      // False means the key has no spend limit of its own. Reported rather than
      // refused — an org that caps spend at the account level is fine — but the
      // settings panel says so plainly, because an uncapped key held by an
      // unattended schedule is what "use a test key" is guarding against.
      isCapped: boolean;
    }
  | {ok: false; error: string};

export async function saveOpenRouterKeyAction(
  input: z.infer<typeof keySchema>
): Promise<SaveKeyResult> {
  const caller = await requireAdmin();
  if (!caller) return {ok: false, error: 'forbidden'};

  const parsed = keySchema.safeParse(input);
  if (!parsed.success) return {ok: false, error: 'invalid'};

  const insforge = await createInsForgeServerClient();
  const {data, error} = await insforge.functions.invoke('thread-agent', {
    method: 'POST',
    body: {action: 'save_key', api_key: parsed.data.apiKey}
  });

  const failure = extractError(data, error);
  if (failure) return {ok: false, error: failure};

  const body = (data ?? {}) as {
    last_four?: string;
    label?: string | null;
    limit_usd?: number | null;
    is_capped?: boolean;
  };

  revalidatePath('/settings');
  return {
    ok: true,
    lastFour: body.last_four ?? '····',
    label: body.label ?? null,
    limitUsd: body.limit_usd ?? null,
    // Absent reads as uncapped, which is the warning-side default.
    isCapped: body.is_capped === true
  };
}

export async function testOpenRouterKeyAction(): Promise<AgentActionResult> {
  const caller = await requireAdmin();
  if (!caller) return {ok: false, error: 'forbidden'};

  const insforge = await createInsForgeServerClient();
  const {data, error} = await insforge.functions.invoke('thread-agent', {
    method: 'POST',
    body: {action: 'test_key'}
  });

  const failure = extractError(data, error);
  if (failure) return {ok: false, error: failure};

  revalidatePath('/settings');
  return {ok: true};
}

export async function clearOpenRouterKeyAction(): Promise<AgentActionResult> {
  const caller = await requireAdmin();
  if (!caller) return {ok: false, error: 'forbidden'};

  const insforge = await createInsForgeServerClient();
  const {data, error} = await insforge.functions.invoke('thread-agent', {
    method: 'POST',
    body: {action: 'clear_key'}
  });

  const failure = extractError(data, error);
  if (failure) return {ok: false, error: failure};

  revalidatePath('/settings');
  return {ok: true};
}

// ============================================================
// Agent lifecycle
// ============================================================

const createAgentSchema = z.object({
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9_-]{1,29}$/),
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  systemPrompt: z.string().trim().min(1).max(20000),
  // Pasted verbatim from openrouter.ai/models. Shape-checked only: OpenRouter
  // owns this namespace, so an unknown slug should fail at call time with their
  // error rather than be refused here by a list we would have to maintain.
  model: z.string().trim().regex(MODEL_SLUG_PATTERN),
  allowedActions: z.array(z.enum(PROPOSAL_ACTIONS)).max(PROPOSAL_ACTIONS.length),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().min(256).max(32000).optional(),
  budgetUsdMonth: z.number().min(0).max(1000).optional()
});

// Provisioning needs an auth.users row, which needs the admin client, so this
// hands off to the edge function rather than writing the tables directly.
export async function createAgentAction(
  input: z.infer<typeof createAgentSchema>
): Promise<AgentActionResult> {
  const caller = await requireAdmin();
  if (!caller) return {ok: false, error: 'forbidden'};

  const parsed = createAgentSchema.safeParse(input);
  if (!parsed.success) return {ok: false, error: 'invalid'};

  const insforge = await createInsForgeServerClient();
  const {data, error} = await insforge.functions.invoke('thread-agent', {
    method: 'POST',
    body: {
      action: 'provision_agent',
      handle: parsed.data.handle,
      display_name: parsed.data.displayName,
      description: parsed.data.description ?? null,
      system_prompt: parsed.data.systemPrompt,
      model: parsed.data.model,
      allowed_actions: parsed.data.allowedActions,
      temperature: parsed.data.temperature ?? 0.3,
      max_output_tokens: parsed.data.maxOutputTokens ?? 1500,
      budget_usd_month: parsed.data.budgetUsdMonth ?? 5
    }
  });

  const failure = extractError(data, error);
  if (failure) return {ok: false, error: failure};

  revalidatePath('/settings');
  revalidatePath('/channels');
  return {ok: true};
}

const updateAgentSchema = z.object({
  userId: uuid,
  displayName: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  systemPrompt: z.string().trim().min(1).max(20000).optional(),
  model: z.string().trim().regex(MODEL_SLUG_PATTERN).optional(),
  allowedActions: z.array(z.enum(PROPOSAL_ACTIONS)).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().min(256).max(32000).optional(),
  budgetUsdMonth: z.number().min(0).max(1000).optional(),
  enabled: z.boolean().optional()
});

// Edits go straight to the table: the UPDATE policy is admins-only and the
// column grant already excludes user_id and handle, so an agent cannot be
// re-pointed at a different account or renamed out from under its mentions.
export async function updateAgentAction(
  input: z.infer<typeof updateAgentSchema>
): Promise<AgentActionResult> {
  const caller = await requireAdmin();
  if (!caller) return {ok: false, error: 'forbidden'};

  const parsed = updateAgentSchema.safeParse(input);
  if (!parsed.success) return {ok: false, error: 'invalid'};

  const {userId, ...rest} = parsed.data;
  const patch: Record<string, unknown> = {};
  if (rest.displayName !== undefined) patch.display_name = rest.displayName;
  if (rest.description !== undefined) patch.description = rest.description;
  if (rest.systemPrompt !== undefined) patch.system_prompt = rest.systemPrompt;
  if (rest.model !== undefined) patch.model = rest.model;
  if (rest.allowedActions !== undefined) patch.allowed_actions = rest.allowedActions;
  if (rest.temperature !== undefined) patch.temperature = rest.temperature;
  if (rest.maxOutputTokens !== undefined) patch.max_output_tokens = rest.maxOutputTokens;
  if (rest.budgetUsdMonth !== undefined) patch.budget_usd_month = rest.budgetUsdMonth;
  if (rest.enabled !== undefined) patch.enabled = rest.enabled;

  if (Object.keys(patch).length === 0) return {ok: true};

  const insforge = await createInsForgeServerClient();
  const {error} = await insforge.database
    .from('agents')
    .update(patch)
    .eq('user_id', userId);

  if (error) return {ok: false, error: mapDatabaseError(error)};

  revalidatePath('/settings');
  return {ok: true};
}

const archiveAgentSchema = z.object({userId: uuid});

// Removing an agent from the roster.
//
// An UPDATE, not a DELETE, and the migration header explains why at length:
// agent_proposals cascades from agents, so deleting the row would erase the
// approved proposals that produced real records. Archiving keeps every one of
// them attributable.
//
// `enabled: false` goes along for the ride so that the two ways an agent can be
// woken — a mention and a schedule — are both shut off by this single call,
// rather than relying on the roster simply not rendering the toggle any more.
export async function archiveAgentAction(
  input: z.infer<typeof archiveAgentSchema>
): Promise<AgentActionResult> {
  const caller = await requireAdmin();
  if (!caller) return {ok: false, error: 'forbidden'};

  const parsed = archiveAgentSchema.safeParse(input);
  if (!parsed.success) return {ok: false, error: 'invalid'};

  const insforge = await createInsForgeServerClient();
  const {error} = await insforge.database
    .from('agents')
    .update({archived_at: new Date().toISOString(), enabled: false})
    .eq('user_id', parsed.data.userId);

  if (error) return {ok: false, error: mapDatabaseError(error)};

  revalidatePath('/settings');
  revalidatePath('/channels');
  return {ok: true};
}

// ============================================================
// Proposals
// ============================================================

const decisionSchema = z.object({
  proposalId: uuid,
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(2000).optional(),
  // Typed by the approving admin at decision time, never carried over from the
  // proposal payload. decide_agent_proposal ignores any waiver in the payload,
  // and thread-agent strips it before the row is written — neither layer relies
  // on the other.
  waiverReason: z.string().trim().max(2000).optional()
});

export async function decideProposalAction(
  input: z.infer<typeof decisionSchema>
): Promise<AgentActionResult> {
  const caller = await requireActiveCaller();
  if (!caller) return {ok: false, error: 'forbidden'};

  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return {ok: false, error: 'invalid'};

  const insforge = await createInsForgeServerClient();
  const {error} = await insforge.database.rpc('decide_agent_proposal', {
    p_proposal_id: parsed.data.proposalId,
    p_decision: parsed.data.decision,
    p_decision_note: parsed.data.note ?? null,
    p_waiver_reason: parsed.data.waiverReason ?? null
  });

  // The RPC raises for every refusal — not an active member, action outside the
  // agent's allowlist, approver not entitled to perform it themselves. The
  // message is the one the database wrote, which is more accurate than anything
  // this layer could infer.
  if (error) return {ok: false, error: mapDatabaseError(error)};

  revalidatePath('/channels');
  return {ok: true};
}

export async function getProposalsForChannelAction(
  channelId: string
): Promise<AgentProposal[]> {
  const caller = await requireActiveCaller();
  if (!caller || !uuid.safeParse(channelId).success) return [];

  const insforge = await createInsForgeServerClient();
  const {data} = await insforge.database
    .from('agent_proposals')
    .select(
      'id, message_id, channel_id, agent_id, run_id, product_id, action, payload, reasoning, status, decided_by, decided_at, decision_note, result_type, result_id, created_at'
    )
    .eq('channel_id', channelId)
    .order('created_at', {ascending: false});

  return (data ?? []) as unknown as AgentProposal[];
}

// ============================================================
// Schedules and cost
// ============================================================

const scheduleSchema = z.object({
  agentId: uuid,
  channelId: uuid,
  productId: uuid.nullable().optional(),
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(5000),
  cron: z
    .string()
    .trim()
    .regex(/^(\S+\s+){4}\S+$/, 'cron must have five fields'),
  minIntervalMinutes: z.number().int().min(15).max(10080).optional()
});

export async function createAgentScheduleAction(
  input: z.infer<typeof scheduleSchema>
): Promise<AgentActionResult> {
  const caller = await requireAdmin();
  if (!caller) return {ok: false, error: 'forbidden'};

  const parsed = scheduleSchema.safeParse(input);
  if (!parsed.success) return {ok: false, error: 'invalid'};

  const insforge = await createInsForgeServerClient();
  const {error} = await insforge.database.from('agent_schedules').insert([
    {
      agent_id: parsed.data.agentId,
      channel_id: parsed.data.channelId,
      product_id: parsed.data.productId ?? null,
      name: parsed.data.name,
      prompt: parsed.data.prompt,
      cron: parsed.data.cron,
      min_interval_minutes: parsed.data.minIntervalMinutes ?? 60,
      created_by: caller.user.id
    }
  ]);

  if (error) return {ok: false, error: mapDatabaseError(error)};

  revalidatePath('/settings');
  return {ok: true};
}

export async function setAgentScheduleEnabledAction(
  scheduleId: string,
  enabled: boolean
): Promise<AgentActionResult> {
  const caller = await requireAdmin();
  if (!caller || !uuid.safeParse(scheduleId).success) {
    return {ok: false, error: 'forbidden'};
  }

  const insforge = await createInsForgeServerClient();
  const {error} = await insforge.database
    .from('agent_schedules')
    .update({enabled})
    .eq('id', scheduleId);

  if (error) return {ok: false, error: mapDatabaseError(error)};
  revalidatePath('/settings');
  return {ok: true};
}

export async function deleteAgentScheduleAction(
  scheduleId: string
): Promise<AgentActionResult> {
  const caller = await requireAdmin();
  if (!caller || !uuid.safeParse(scheduleId).success) {
    return {ok: false, error: 'forbidden'};
  }

  const insforge = await createInsForgeServerClient();
  const {error} = await insforge.database
    .from('agent_schedules')
    .delete()
    .eq('id', scheduleId);

  if (error) return {ok: false, error: mapDatabaseError(error)};
  revalidatePath('/settings');
  return {ok: true};
}

export async function getAgentSchedulesAction(): Promise<AgentSchedule[]> {
  const caller = await requireActiveCaller();
  if (!caller) return [];

  const insforge = await createInsForgeServerClient();
  const {data} = await insforge.database
    .from('agent_schedules')
    .select(
      'id, agent_id, channel_id, product_id, name, prompt, cron, min_interval_minutes, enabled, last_run_at, next_run_at, last_error'
    )
    .order('next_run_at', {ascending: true});

  return (data ?? []) as unknown as AgentSchedule[];
}

// Admin-only by RLS on agent_runs: spend is an admin concern, and the table
// would otherwise be a per-message activity log visible to everyone.
export async function getAgentRunsAction(limit = 50): Promise<AgentRun[]> {
  const caller = await requireAdmin();
  if (!caller) return [];

  const insforge = await createInsForgeServerClient();
  const {data} = await insforge.database
    .from('agent_runs')
    .select(
      'id, agent_id, trigger_message_id, schedule_id, model, status, prompt_tokens, completion_tokens, cost_usd, error, created_at'
    )
    .order('created_at', {ascending: false})
    .limit(limit);

  return (data ?? []) as unknown as AgentRun[];
}
