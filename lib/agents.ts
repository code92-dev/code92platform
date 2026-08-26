// Shared agent vocabulary. No 'use server', so client components can import the
// constants and types directly.
//
// Mirrors migrations/20260825091000_add-agents.sql and
// migrations/20260825092000_add-agent-schedules.sql.

export const PROPOSAL_ACTIONS = [
  'knowledge_note',
  'task_create',
  'task_update',
  'status_update',
  'lifecycle_advance'
] as const;
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

export const PROPOSAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'superseded',
  'expired'
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const RUN_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped'
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// Which actions need an admin to approve them. The database is the authority —
// decide_agent_proposal delegates to advance_lifecycle_phase, which re-derives
// the approver's rights itself. This mirror exists so the card can disable the
// button and say why, rather than letting a member click into an exception.
//
// Both must change together, exactly as the lifecycle gate matrix does.
export const ADMIN_ONLY_ACTIONS: ReadonlySet<ProposalAction> = new Set([
  'lifecycle_advance'
]);

// Actions that take a waiver reason typed by the approver at decision time.
// Never pre-filled from the proposal payload: an AI-drafted justification for
// waiving a security gate, recorded as an admin's own words, would make the
// waiver register worthless.
export const WAIVER_ACTIONS: ReadonlySet<ProposalAction> = new Set([
  'lifecycle_advance'
]);

export type Agent = {
  user_id: string;
  handle: string;
  display_name: string;
  description: string | null;
  system_prompt: string;
  // An OpenRouter model slug, pasted verbatim from openrouter.ai/models —
  // 'anthropic/claude-sonnet-4.5', 'perplexity/sonar'. Sent to OpenRouter
  // exactly as stored.
  model: string;
  allowed_actions: ProposalAction[];
  temperature: number;
  max_output_tokens: number;
  enabled: boolean;
  budget_usd_month: number;
  created_at: string;
};

export type AgentProposal = {
  id: string;
  message_id: string;
  channel_id: string;
  agent_id: string;
  run_id: string | null;
  product_id: string | null;
  action: ProposalAction;
  payload: Record<string, unknown>;
  reasoning: string;
  status: ProposalStatus;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  result_type: string | null;
  result_id: string | null;
  created_at: string;
};

export type AgentSchedule = {
  id: string;
  agent_id: string;
  channel_id: string;
  product_id: string | null;
  name: string;
  prompt: string;
  cron: string;
  min_interval_minutes: number;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string;
  last_error: string | null;
};

export type AgentRun = {
  id: string;
  agent_id: string | null;
  trigger_message_id: string | null;
  schedule_id: string | null;
  model: string | null;
  status: RunStatus;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  error: string | null;
  created_at: string;
};

// What openrouter_connection_status() returns. The ciphertext is structurally
// absent from that function, so there is no shape here that could carry it.
export type OpenRouterStatus = {
  is_configured: boolean;
  key_last_four: string | null;
  key_label: string | null;
  key_limit_usd: number | null;
  key_usage_usd: number | null;
  key_is_free_tier: boolean | null;
  // A key with no spend limit is uncapped. The settings panel warns on this:
  // an unattended schedule holding an uncapped production key is the thing
  // "use a test key" is trying to prevent.
  key_is_capped: boolean;
  validated_at: string | null;
  validation_error: string | null;
};

// Shape-only check of an OpenRouter model slug, matching the CHECK on
// agents.model. Deliberately not a list of known models: that namespace belongs
// to OpenRouter and changes without us, so an unknown slug should fail at call
// time with OpenRouter's own error rather than be rejected by a list we forgot
// to update.
export const MODEL_SLUG_PATTERN = /^[a-z0-9._-]+\/[A-Za-z0-9._-]+(:[A-Za-z0-9-]+)?$/;

export function isValidModelSlug(slug: string): boolean {
  return MODEL_SLUG_PATTERN.test(slug.trim());
}

// OpenRouter keys are 'sk-or-v1-…'. Checked before the key leaves the browser so
// an obvious paste error does not become a round trip.
export function looksLikeOpenRouterKey(key: string): boolean {
  return key.trim().startsWith('sk-or-');
}
