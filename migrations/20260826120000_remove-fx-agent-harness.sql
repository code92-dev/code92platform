-- Remove the native fx/Vercel AI Gateway harness while preserving the original
-- direct OpenRouter agent workflow. Applied migrations are immutable, so this
-- forward-only rollback removes the harness's runtime data and schema.

-- FX runs and their run-event audit rows belong exclusively to the harness.
-- Neither run produced a proposal; deleting them leaves the direct OpenRouter
-- history and all existing agents intact.
DELETE FROM public.agent_runs
WHERE runtime = 'fx';

-- Restore the direct-agent mention queue, including the later DM exclusion.
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
      agent_id, trigger_message_id, channel_id, model, status
    )
    VALUES (ag.user_id, NEW.id, NEW.channel_id, ag.model, 'pending');
  END LOOP;

  RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS public.claim_fx_agent_run(UUID, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.agent_run_lease_is_valid(UUID, TEXT);
DROP FUNCTION IF EXISTS public.agent_fx_capability_is_valid(UUID, TEXT);

DROP TABLE IF EXISTS public.agent_jobs;
DROP TABLE IF EXISTS public.agent_sessions;
DROP TABLE IF EXISTS public.agent_run_events;

REVOKE INSERT (runtime, tool_profile, max_tool_steps, max_run_seconds)
ON public.agents FROM authenticated;
REVOKE UPDATE (runtime, tool_profile, max_tool_steps, max_run_seconds)
ON public.agents FROM authenticated;

DROP INDEX IF EXISTS public.agent_runs_fx_queue_idx;
DROP INDEX IF EXISTS public.agent_runs_fx_lease_idx;

ALTER TABLE public.agents
  DROP COLUMN IF EXISTS runtime,
  DROP COLUMN IF EXISTS tool_profile,
  DROP COLUMN IF EXISTS max_tool_steps,
  DROP COLUMN IF EXISTS max_run_seconds;

ALTER TABLE public.agent_runs
  DROP COLUMN IF EXISTS runtime,
  DROP COLUMN IF EXISTS execution_phase,
  DROP COLUMN IF EXISTS attempt,
  DROP COLUMN IF EXISTS lease_owner,
  DROP COLUMN IF EXISTS lease_expires_at,
  DROP COLUMN IF EXISTS heartbeat_at,
  DROP COLUMN IF EXISTS capability_token_hash,
  DROP COLUMN IF EXISTS capability_token_expires_at,
  DROP COLUMN IF EXISTS fx_session_id,
  DROP COLUMN IF EXISTS tool_summary,
  DROP COLUMN IF EXISTS cancel_requested_at;

DROP FUNCTION IF EXISTS public.ai_gateway_connection_status();
DROP TABLE IF EXISTS public.ai_gateway_connection;
