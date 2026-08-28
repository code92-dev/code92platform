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
  'lifecycle_advance',
  // The harness's only route into a repository. Approving it does not write
  // anything by itself: decide_agent_proposal records the decision, and
  // github-sync commits under the approver's own authority afterwards.
  'repo_patch'
] as const;
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

// Actions an agent may be trusted to perform without a human approving them.
//
// A strict subset of PROPOSAL_ACTIONS. Knowledge notes remain proposal-only
// because their model-authored content needs a human confidentiality review.
// The other omissions are the point too:
// lifecycle_advance can require a waiver, and a waiver is a person accepting
// responsibility — there is nobody to accept it when nobody is asked.
// repo_patch commits to a repository under the org PAT. Both stay
// propose-only however an agent is configured, which the CHECK on
// agents.autonomous_actions enforces rather than this constant.
//
// Mirrors migrations/20260827110000_add-autonomous-agent-actions.sql.
export const AUTONOMOUS_ACTIONS = [
  'task_create',
  'task_update',
  'status_update'
] as const;
export type AutonomousAction = (typeof AUTONOMOUS_ACTIONS)[number];

export function canRunUnattended(action: string): action is AutonomousAction {
  return (AUTONOMOUS_ACTIONS as readonly string[]).includes(action);
}

export const PROPOSAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'superseded',
  'expired',
  // Performed by the agent with no human decision, because the operator put
  // this action in the agent's autonomous_actions. A distinct status rather
  // than 'approved' with a null decider: "approved by nobody" is the kind of
  // record that reads as a bug months later.
  'auto_applied'
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

// Which execution environment answers a mention.
//
// 'direct_openrouter' is one completion inside functions/thread-agent.ts — the
// right shape for a channel reply and the default for every agent.
// 'jcode' hands the run to the operator harness, which claims it under a lease
// and can spend minutes with tools before it answers.
//
// Mirrors migrations/20260826130000_add-jcode-agent-harness.sql.
export const AGENT_RUNTIMES = ['direct_openrouter', 'jcode'] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

// Which tools an agent gets. Only 'operator' is meaningful under the jcode
// runtime — it is the profile that is given a workspace.
export const TOOL_PROFILES = ['chat', 'research', 'operator'] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

// Finer-grained than RunStatus, which stays what the rest of the app reads.
// status answers "did it work"; this answers "what is it doing", which is the
// only useful thing to show during the minutes a harness run is alive.
export const EXECUTION_PHASES = [
  'queued',
  'preparing',
  'researching',
  'executing',
  'waiting',
  'finalizing',
  'completed',
  'failed',
  'cancelled',
  'skipped'
] as const;
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

// Phases that mean the run is over, whatever the outcome. Used by the activity
// panel to stop polling and by the roster to stop showing a spinner.
export const TERMINAL_PHASES: ReadonlySet<ExecutionPhase> = new Set([
  'completed',
  'failed',
  'cancelled',
  'skipped'
]);

// Which actions need an admin to approve them. The database is the authority —
// decide_agent_proposal delegates to advance_lifecycle_phase, which re-derives
// the approver's rights itself. This mirror exists so the card can disable the
// button and say why, rather than letting a member click into an exception.
//
// Both must change together, exactly as the lifecycle gate matrix does.
export const ADMIN_ONLY_ACTIONS: ReadonlySet<ProposalAction> = new Set([
  'lifecycle_advance'
]);

// Actions whose approval is not finished when decide_agent_proposal returns.
// A repo_patch still has to be committed through github-sync, so the card has
// to keep showing it until commit_sha lands or commit_error explains why not.
export const DEFERRED_ACTIONS: ReadonlySet<ProposalAction> = new Set(['repo_patch']);

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
  // A subset of allowed_actions, enforced by CHECK: these run the moment the
  // agent proposes them, with no approval card to click.
  autonomous_actions: AutonomousAction[];
  temperature: number;
  max_output_tokens: number;
  enabled: boolean;
  budget_usd_month: number;
  runtime: AgentRuntime;
  tool_profile: ToolProfile;
  // Two independent ceilings, because they fail differently: a model looping
  // over one tool burns budget without wall-clock, a model waiting on a slow
  // command burns wall-clock without tokens.
  max_tool_steps: number;
  max_run_seconds: number;
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
  // repo_patch only. Null while a patch is approved but not yet committed —
  // a state the card surfaces rather than hides, because the alternative is a
  // platform that says "approved" about a repository that never changed.
  commit_sha: string | null;
  commit_error: string | null;
  created_at: string;
};

// The payload shape of a repo_patch proposal.
export type RepoPatchPayload = {
  message: string;
  files: Array<{path: string; content?: string; remove?: boolean}>;
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
  channel_id: string | null;
  model: string | null;
  status: RunStatus;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  error: string | null;
  // Copied from the agent when the run was queued, never read back through the
  // FK: editing an agent between the mention and the drain must not move an
  // already-queued request into a different execution environment.
  runtime: AgentRuntime;
  execution_phase: ExecutionPhase;
  attempt: number;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  jcode_session_id: string | null;
  tool_summary: ToolSummaryEntry[];
  cancel_requested_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

// The flattened trace on agent_runs.tool_summary. The full event stream lives
// in agent_run_events; this is what the run list can show without joining a
// table that grows by hundreds of rows per run.
export type ToolSummaryEntry = {
  tool: string;
  calls: number;
  failed?: number;
};

// One row per meaningful thing the harness did — what makes a run that takes
// minutes legible instead of a spinner.
export type AgentRunEvent = {
  id: string;
  run_id: string;
  phase: ExecutionPhase;
  event_type: string;
  detail: Record<string, unknown>;
  created_at: string;
};

// The platform's index into the harness's own on-disk session state, so a
// follow-up mention in the same thread resumes rather than restarting cold.
// Scoped per channel and never reused across them.
export type AgentSession = {
  id: string;
  agent_id: string;
  channel_id: string;
  thread_root_id: string | null;
  jcode_session_id: string;
  // Digest of the system prompt, tool profile and model this session was built
  // under. The control plane recomputes it at claim time and declines to
  // resume a session whose fingerprint no longer matches, so an edited agent
  // starts fresh instead of quietly continuing under its old instructions.
  prompt_fingerprint: string;
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
};

export const JOB_STATES = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'lost'
] as const;
export type JobState = (typeof JOB_STATES)[number];

// Background commands, tracked as rows rather than left inside the harness
// process — the process is the thing that dies. 'lost' is what a compute
// restart leaves behind, and it is a retry someone can make deliberately.
export type AgentJob = {
  id: string;
  run_id: string;
  agent_id: string;
  channel_id: string;
  jcode_background_id: string;
  state: JobState;
  command_summary: string;
  log_key: string | null;
  started_at: string;
  heartbeat_at: string | null;
  finished_at: string | null;
  error: string | null;
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
