-- Native fx harness for the collaboration agents.
--
-- The existing OpenRouter execution path remains the default.  An agent is
-- explicitly switched to runtime='fx' only after the compute runner is healthy.
-- This keeps the queue, proposals, and approval boundary stable while adding
-- research tools and durable long-running work.

-- ---------------------------------------------------------------------------
-- Runtime configuration and run lifecycle
-- ---------------------------------------------------------------------------

ALTER TABLE public.agents
  ADD COLUMN runtime TEXT NOT NULL DEFAULT 'direct_openrouter'
    CHECK (runtime IN ('direct_openrouter', 'fx')),
  ADD COLUMN tool_profile TEXT NOT NULL DEFAULT 'chat'
    CHECK (tool_profile IN ('chat', 'research', 'operator')),
  ADD COLUMN max_tool_steps INTEGER NOT NULL DEFAULT 12
    CHECK (max_tool_steps BETWEEN 0 AND 100),
  ADD COLUMN max_run_seconds INTEGER NOT NULL DEFAULT 240
    CHECK (max_run_seconds BETWEEN 30 AND 1800);

ALTER TABLE public.agent_runs
  ADD COLUMN runtime TEXT NOT NULL DEFAULT 'direct_openrouter'
    CHECK (runtime IN ('direct_openrouter', 'fx')),
  ADD COLUMN execution_phase TEXT NOT NULL DEFAULT 'queued'
    CHECK (execution_phase IN (
      'queued', 'preparing', 'researching', 'executing', 'waiting',
      'finalizing', 'completed', 'failed', 'cancelled', 'skipped'
    )),
  ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  ADD COLUMN lease_owner TEXT,
  ADD COLUMN lease_expires_at TIMESTAMPTZ,
  ADD COLUMN heartbeat_at TIMESTAMPTZ,
  ADD COLUMN capability_token_hash TEXT,
  ADD COLUMN capability_token_expires_at TIMESTAMPTZ,
  ADD COLUMN fx_session_id TEXT,
  ADD COLUMN tool_summary JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN cancel_requested_at TIMESTAMPTZ;

CREATE INDEX agent_runs_fx_queue_idx
ON public.agent_runs (created_at)
WHERE runtime = 'fx' AND status = 'pending';

CREATE INDEX agent_runs_fx_lease_idx
ON public.agent_runs (lease_expires_at)
WHERE runtime = 'fx' AND status = 'running';

-- Existing column-level grants deliberately list every editable setting. Extend
-- them rather than relying on an implicit table-wide grant for the new knobs.
GRANT INSERT (runtime, tool_profile, max_tool_steps, max_run_seconds)
ON public.agents TO authenticated;
GRANT UPDATE (runtime, tool_profile, max_tool_steps, max_run_seconds)
ON public.agents TO authenticated;

-- The channel privacy predicate is intentional here. Event details can include
-- a command name, a research source, or a redacted error from the originating
-- channel, so the admin-only run view alone is not a sufficient boundary.
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

-- A session is scoped to one agent and one conversation root.  Never reuse a
-- session across channels: that would make one room's private context available
-- to another just because the same agent answered both.
CREATE TABLE public.agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES public.agents(user_id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
  thread_root_id UUID REFERENCES public.messages(id) ON DELETE CASCADE,
  fx_session_id TEXT NOT NULL,
  prompt_epoch INTEGER NOT NULL DEFAULT 1 CHECK (prompt_epoch > 0),
  last_run_id UUID REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- Background work is represented separately from the fx process handle. A
-- process can die during a compute restart; its audit trail and captured log
-- remain useful and make a retry an explicit action rather than a guess.
CREATE TABLE public.agent_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES public.agents(user_id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
  fx_background_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'running'
    CHECK (state IN ('running', 'succeeded', 'failed', 'cancelled', 'lost')),
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

-- Atomically claim a queued fx run. The one-time capability is intentionally
-- returned only to the runner that won the claim. It is hashed at rest and is
-- accepted only while the associated lease is live.
CREATE OR REPLACE FUNCTION public.claim_fx_agent_run(
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
  IF char_length(btrim(p_runner_id)) = 0 THEN
    RAISE EXCEPTION 'runner id is required';
  END IF;
  IF p_lease_seconds NOT BETWEEN 30 AND 1800 THEN
    RAISE EXCEPTION 'lease duration must be between 30 and 1800 seconds';
  END IF;

  -- gen_random_uuid() is already required by the core schema. Two UUIDs give
  -- this short-lived bearer enough entropy without introducing a new extension.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

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
    AND r.runtime = 'fx'
    AND (
      r.status = 'pending'
      OR (r.status = 'running' AND r.lease_expires_at IS NOT NULL AND r.lease_expires_at < now())
    );

  GET DIAGNOSTICS v_row_count = ROW_COUNT;
  v_claimed := v_row_count > 0;
  RETURN QUERY SELECT v_claimed, CASE WHEN v_claimed THEN v_token ELSE NULL END;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_fx_agent_run(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;

-- The runner proves possession of its lease for every event/finalization call.
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
      AND runtime = 'fx'
      AND status = 'running'
      AND lease_owner = p_runner_id
      AND lease_expires_at > now()
  );
$$;

REVOKE ALL ON FUNCTION public.agent_run_lease_is_valid(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- Capability checks are deliberately performed inside PostgreSQL so the runner
-- never needs to know which digest implementation the database uses.
CREATE OR REPLACE FUNCTION public.agent_fx_capability_is_valid(
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
      AND runtime = 'fx'
      AND status = 'running'
      AND capability_token_hash = md5(p_token)
      AND capability_token_expires_at > now()
  );
$$;

REVOKE ALL ON FUNCTION public.agent_fx_capability_is_valid(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- Preserve the runtime choice at queue time. A model/runtime edit after a
-- mention must not make an already queued request unexpectedly use a new
-- execution environment.
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
