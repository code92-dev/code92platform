-- The jcode operator harness.
--
-- This adds the run lifecycle a long-running out-of-process harness needs —
-- leases, capabilities, progress events, sessions, background jobs — and
-- nothing that can execute. No agent reaches this path until an admin sets
-- agents.runtime = 'jcode', and no UI offers that until the runner is healthy.
-- Applied alone, this migration is inert: every existing agent keeps
-- runtime = 'direct_openrouter' and the OpenRouter path is untouched.
--
-- Why a second runtime at all, rather than growing thread-agent: the existing
-- path is one completion inside a Deno edge function, which is the right shape
-- for a channel reply and cannot be the shape for an agent that reads a repo
-- for four minutes. The two are kept as separate runtimes rather than one
-- runtime with a flag, so that a failure in the harness cannot regress the
-- conversational agents the team already relies on.
--
-- Supersedes the reverted fx harness (20260826100000 / 20260826120000). The
-- lifecycle below is that design; what changed is the execution engine and,
-- decisively, the credential: jcode reads OPENROUTER_API_KEY, so the harness
-- runs on the key already held in public.openrouter_connection under the
-- existing spend cap. There is no second gateway and no second bill.

-- ---------------------------------------------------------------------------
-- Runtime configuration
-- ---------------------------------------------------------------------------

ALTER TABLE public.agents
  ADD COLUMN runtime TEXT NOT NULL DEFAULT 'direct_openrouter'
    CHECK (runtime IN ('direct_openrouter', 'jcode')),

  -- Which tools the harness exposes. 'chat' and 'research' stay on the
  -- OpenRouter path; only 'operator' is meaningful under jcode, and it is the
  -- profile that gets a workspace. Kept as a stored column rather than derived
  -- from runtime because the profile is what the roster UI explains to an
  -- admin, and because a future runtime should not silently change it.
  ADD COLUMN tool_profile TEXT NOT NULL DEFAULT 'chat'
    CHECK (tool_profile IN ('chat', 'research', 'operator')),

  -- Two independent ceilings, because they fail differently. A model that
  -- loops over the same tool burns budget without wall-clock; a model waiting
  -- on a slow command burns wall-clock without tokens. Bounding only one
  -- leaves the other unbounded.
  ADD COLUMN max_tool_steps INTEGER NOT NULL DEFAULT 12
    CHECK (max_tool_steps BETWEEN 0 AND 100),
  ADD COLUMN max_run_seconds INTEGER NOT NULL DEFAULT 240
    CHECK (max_run_seconds BETWEEN 30 AND 1800);

-- The existing column-level grants on public.agents enumerate every editable
-- setting. A table-level grant would have covered these implicitly; a
-- column-scoped one does not, and forgetting to extend it has already caused
-- one real bug in this schema. Extend it explicitly.
GRANT INSERT (runtime, tool_profile, max_tool_steps, max_run_seconds)
ON public.agents TO authenticated;
GRANT UPDATE (runtime, tool_profile, max_tool_steps, max_run_seconds)
ON public.agents TO authenticated;

-- ---------------------------------------------------------------------------
-- Run lifecycle
-- ---------------------------------------------------------------------------

ALTER TABLE public.agent_runs
  -- Copied from the agent at queue time, never read back through the FK.
  -- Editing an agent's runtime between the mention and the drain must not move
  -- an already-queued request into a different execution environment.
  ADD COLUMN runtime TEXT NOT NULL DEFAULT 'direct_openrouter'
    CHECK (runtime IN ('direct_openrouter', 'jcode')),

  -- Finer-grained than agent_runs.status, which stays the column everything
  -- else in the app already reads. status answers "did it work"; this answers
  -- "what is it doing", which is the only useful thing to show a human during
  -- the four minutes a run is alive.
  ADD COLUMN execution_phase TEXT NOT NULL DEFAULT 'queued'
    CHECK (execution_phase IN (
      'queued', 'preparing', 'researching', 'executing', 'waiting',
      'finalizing', 'completed', 'failed', 'cancelled', 'skipped'
    )),

  ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),

  -- Lease, not lock. A runner that is killed mid-run cannot release anything,
  -- so the claim has to expire on its own or the run is stuck forever.
  ADD COLUMN lease_owner TEXT,
  ADD COLUMN lease_expires_at TIMESTAMPTZ,
  ADD COLUMN heartbeat_at TIMESTAMPTZ,

  -- The runner's bearer for the run-scoped API. Hashed at rest: this table is
  -- readable by admins, and a live capability sitting in a readable column
  -- would be a credential handed to anyone who can open the cost panel.
  ADD COLUMN capability_token_hash TEXT,
  ADD COLUMN capability_token_expires_at TIMESTAMPTZ,

  ADD COLUMN jcode_session_id TEXT,

  -- OpenRouter's lifetime spend on the key, read at claim time.
  --
  -- The harness reports tokens but not cost, so without this cost_usd would be
  -- null on every operator run and agents.budget_usd_month would quietly stop
  -- being enforced for exactly the agents that can spend the most. The run's
  -- cost is the difference between this and the same reading at finalisation.
  -- Accurate while one run holds the key at a time, which is why the runner
  -- ships with MAX_CONCURRENT_RUNS=1; above that it apportions and the number
  -- becomes an estimate, recorded as such in the finalising event.
  ADD COLUMN openrouter_usage_at_claim NUMERIC(14,6),

  -- What the model actually did, flattened for display. The full trace lives
  -- in agent_run_events; this is the one-line summary the run list needs
  -- without joining a table that grows by hundreds of rows per run.
  ADD COLUMN tool_summary JSONB NOT NULL DEFAULT '[]'::jsonb,

  ADD COLUMN cancel_requested_at TIMESTAMPTZ;

-- Partial indexes: the harness queue is a small minority of agent_runs and
-- always will be, so both of these stay tiny regardless of conversational
-- volume.
CREATE INDEX agent_runs_jcode_queue_idx
ON public.agent_runs (created_at)
WHERE runtime = 'jcode' AND status = 'pending';

CREATE INDEX agent_runs_jcode_lease_idx
ON public.agent_runs (lease_expires_at)
WHERE runtime = 'jcode' AND status = 'running';

-- ---------------------------------------------------------------------------
-- Progress events
-- ---------------------------------------------------------------------------
-- One row per meaningful thing the harness did. This is what makes a run that
-- takes minutes legible instead of a spinner, and it is the audit trail for a
-- run that touched a repo.

CREATE TABLE public.agent_run_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN (
    'queued', 'preparing', 'researching', 'executing', 'waiting',
    'finalizing', 'completed', 'failed', 'cancelled', 'skipped'
  )),
  event_type TEXT NOT NULL CHECK (char_length(btrim(event_type)) BETWEEN 1 AND 80),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agent_run_events_run_idx
ON public.agent_run_events (run_id, created_at);

ALTER TABLE public.agent_run_events ENABLE ROW LEVEL SECURITY;

-- Admin AND channel-readable, not admin alone. An event detail can carry a
-- command, a file path, or a redacted error drawn from the originating
-- channel, so being an admin is not on its own a licence to read the contents
-- of a private room. This is the same predicate the DM hardening established.
CREATE POLICY "admins read agent run events"
ON public.agent_run_events FOR SELECT TO authenticated
USING (
  public.is_admin()
  AND EXISTS (
    SELECT 1 FROM public.agent_runs r
    WHERE r.id = run_id
      AND (r.channel_id IS NULL OR public.can_read_channel(r.channel_id))
  )
);

REVOKE ALL ON public.agent_run_events FROM anon, authenticated;
GRANT SELECT ON public.agent_run_events TO authenticated;

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
-- jcode persists conversation state on the runner's disk; this table is the
-- platform's index into it, so a follow-up mention in the same thread resumes
-- rather than restarting cold.
--
-- A session is scoped to one agent in one conversation root and is never
-- reused across channels. Resuming a session in a different room would make
-- one room's context available in another purely because the same agent
-- answered both — the exact leak the DM privacy work closed on the human side.

CREATE TABLE public.agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.agents(user_id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
  thread_root_id UUID REFERENCES public.messages(id) ON DELETE CASCADE,
  jcode_session_id TEXT NOT NULL,

  -- Digest of the agent configuration this session was built under: system
  -- prompt, tool profile and model.
  --
  -- A resumed session still carries the old system prompt in its own
  -- transcript, so resuming across an edit would silently keep running the
  -- agent the admin thought they had just replaced. This is a fingerprint
  -- rather than a counter someone has to remember to bump, because the version
  -- that requires an explicit bump is the version that is eventually wrong:
  -- the control plane recomputes it at claim time and simply declines to
  -- resume when it does not match, starting a fresh session instead.
  prompt_fingerprint TEXT NOT NULL CHECK (char_length(prompt_fingerprint) BETWEEN 16 AND 128),

  last_run_id UUID REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- coalesce, because a channel-level session (no thread root) is a distinct
-- scope from any thread inside it, and NULL would not collide with itself.
CREATE UNIQUE INDEX agent_sessions_scope_key
ON public.agent_sessions (
  agent_id,
  channel_id,
  coalesce(thread_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

CREATE TRIGGER agent_sessions_updated_at
BEFORE UPDATE ON public.agent_sessions
FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();

ALTER TABLE public.agent_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "active members read agent sessions"
ON public.agent_sessions FOR SELECT TO authenticated
USING (public.can_read_channel(channel_id));

REVOKE ALL ON public.agent_sessions FROM anon, authenticated;
GRANT SELECT ON public.agent_sessions TO authenticated;

-- ---------------------------------------------------------------------------
-- Background jobs
-- ---------------------------------------------------------------------------
-- Tracked as rows rather than left inside the harness process, because the
-- process is the thing that dies. A compute restart loses every background
-- command jcode was supervising; the row survives, which turns "the run
-- vanished" into a job in state 'lost' that someone can retry deliberately.

CREATE TABLE public.agent_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES public.agents(user_id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
  jcode_background_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'running'
    CHECK (state IN ('running', 'succeeded', 'failed', 'cancelled', 'lost')),

  -- A summary, not the command. The full argv can contain a path or a value
  -- worth not copying into a table with a broader read policy than the run.
  command_summary TEXT NOT NULL CHECK (char_length(command_summary) <= 500),

  log_key TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error TEXT
);

CREATE INDEX agent_jobs_active_idx
ON public.agent_jobs (channel_id, started_at DESC)
WHERE state = 'running';

ALTER TABLE public.agent_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "channel readers read agent jobs"
ON public.agent_jobs FOR SELECT TO authenticated
USING (public.can_read_channel(channel_id));

REVOKE ALL ON public.agent_jobs FROM anon, authenticated;
GRANT SELECT ON public.agent_jobs TO authenticated;

-- ---------------------------------------------------------------------------
-- Claim, lease and capability
-- ---------------------------------------------------------------------------

-- Atomically claim a queued run. Two runners racing for the same run both
-- issue this UPDATE; the WHERE clause means exactly one matches a row and the
-- loser gets claimed = false. This is why the claim is a function and not a
-- SELECT followed by an UPDATE from the runner.
--
-- The second disjunct is lease reclamation: a run left 'running' by a runner
-- that died is claimable again once its lease expires, which is the only way
-- such a run ever moves.
CREATE OR REPLACE FUNCTION public.claim_jcode_agent_run(
  p_run_id UUID,
  p_runner_id TEXT,
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE(claimed BOOLEAN, capability_token TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_token TEXT;
  v_claimed BOOLEAN := false;
  v_row_count INTEGER := 0;
BEGIN
  IF char_length(btrim(coalesce(p_runner_id, ''))) = 0 THEN
    RAISE EXCEPTION 'runner id is required';
  END IF;
  IF p_lease_seconds NOT BETWEEN 30 AND 1800 THEN
    RAISE EXCEPTION 'lease duration must be between 30 and 1800 seconds';
  END IF;

  -- gen_random_uuid() is already required by the core schema. Two of them give
  -- this short-lived bearer 256 bits of entropy without pulling in pgcrypto
  -- for gen_random_bytes.
  v_token := replace(gen_random_uuid()::text, '-', '')
          || replace(gen_random_uuid()::text, '-', '');

  UPDATE public.agent_runs r
  SET
    status = 'running',
    execution_phase = 'preparing',
    started_at = coalesce(r.started_at, now()),
    heartbeat_at = now(),
    lease_owner = p_runner_id,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    capability_token_hash = md5(v_token),
    capability_token_expires_at = now() + make_interval(secs => p_lease_seconds),
    attempt = r.attempt + 1,
    error = NULL
  WHERE r.id = p_run_id
    AND r.runtime = 'jcode'
    AND (
      r.status = 'pending'
      OR (r.status = 'running' AND r.lease_expires_at IS NOT NULL AND r.lease_expires_at < now())
    );

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  v_claimed := v_row_count > 0;
  RETURN QUERY SELECT v_claimed, CASE WHEN v_claimed THEN v_token ELSE NULL END;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_jcode_agent_run(UUID, TEXT, INTEGER)
FROM PUBLIC, anon, authenticated;

-- Proof of lease, required on every progress and finalisation call. A runner
-- whose lease has lapsed — because it stalled and another runner reclaimed the
-- run — must not be able to write a result over the top of the runner that
-- actually did the work.
CREATE OR REPLACE FUNCTION public.agent_run_lease_is_valid(
  p_run_id UUID,
  p_runner_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.agent_runs
    WHERE id = p_run_id
      AND runtime = 'jcode'
      AND status = 'running'
      AND lease_owner = p_runner_id
      AND lease_expires_at > now()
  );
$$;

REVOKE ALL ON FUNCTION public.agent_run_lease_is_valid(UUID, TEXT)
FROM PUBLIC, anon, authenticated;

-- Verified inside PostgreSQL so the runner never learns which digest the
-- database uses, and so the comparison happens where the hash lives.
CREATE OR REPLACE FUNCTION public.agent_jcode_capability_is_valid(
  p_run_id UUID,
  p_token TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.agent_runs
    WHERE id = p_run_id
      AND runtime = 'jcode'
      AND status = 'running'
      AND capability_token_hash = md5(p_token)
      AND capability_token_expires_at > now()
  );
$$;

REVOKE ALL ON FUNCTION public.agent_jcode_capability_is_valid(UUID, TEXT)
FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Queue trigger
-- ---------------------------------------------------------------------------
-- Unchanged except that the run now records the runtime and phase it was
-- queued under. Everything else here — the DM exclusion, the enabled and
-- archived checks, the per-handle loop — is carried forward verbatim from
-- 20260825123000 and must stay that way.

CREATE OR REPLACE FUNCTION public.messages_queue_agent_runs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_handle TEXT;
  ag public.agents;
BEGIN
  IF NEW.kind <> 'human' OR EXISTS (
    SELECT 1 FROM public.channels
    WHERE id = NEW.channel_id AND kind = 'dm'
  ) THEN
    RETURN NEW;
  END IF;

  FOR v_handle IN
    SELECT DISTINCT lower(m[1])
    FROM regexp_matches(NEW.body, '@([A-Za-z0-9._-]{2,40})', 'g') AS m
  LOOP
    SELECT * INTO ag FROM public.agents
    WHERE agents.handle = v_handle AND enabled AND archived_at IS NULL;

    IF ag.user_id IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO public.agent_runs (
      agent_id, trigger_message_id, channel_id, model, runtime, status, execution_phase
    )
    VALUES (ag.user_id, NEW.id, NEW.channel_id, ag.model, ag.runtime, 'pending', 'queued');
  END LOOP;

  RETURN NEW;
END;
$$;
