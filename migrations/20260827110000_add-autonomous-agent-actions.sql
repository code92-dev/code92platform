-- An agent may be trusted to perform some of its actions without asking.
--
-- DESIGN.md D2 says "agents propose, humans commit — always". This migration
-- narrows that "always", at the operator's explicit instruction, and the shape
-- of the narrowing is the whole point of the file.
--
-- What is NOT changed:
--
--   * The agent still emits a proposal. Nothing about the model's output format
--     moves, and every autonomous action leaves an agent_proposals row behind —
--     so the channel still shows what happened and why, and the audit trail is
--     the same table it was before.
--   * The runner still holds no InsForge credential. Execution happens in the
--     control plane, exactly where decide_agent_proposal already ran it. An
--     agent that could write directly from inside the sandbox would be a much
--     larger change than the one that was asked for.
--   * allowed_actions still bounds everything. autonomous_actions is a SUBSET of
--     it, enforced by CHECK, so an action the agent may not propose cannot
--     become one it performs unattended.
--
-- What IS changed: for actions in autonomous_actions, the human click is gone.
--
-- The vocabulary is deliberately narrower than allowed_actions. lifecycle_advance
-- is excluded because advancing a high-risk phase can require a waiver, and a
-- waiver is a person accepting responsibility — there is nobody to accept it if
-- no one is asked. repo_patch is excluded because it commits to a repository
-- under the org PAT. Both remain propose-only however they are configured.

-- ============================================================
-- agents.autonomous_actions
-- ============================================================

ALTER TABLE public.agents
  ADD COLUMN autonomous_actions TEXT[] NOT NULL DEFAULT '{}'
    CHECK (autonomous_actions <@ ARRAY[
      'knowledge_note', 'task_create', 'task_update', 'status_update'
    ]::TEXT[]);

-- Written as a separate constraint rather than folded into the one above
-- because it says something different: the first bounds which actions can ever
-- be unattended, this one ties an individual agent's unattended set to what it
-- was permitted to propose in the first place. Revoking an action from
-- allowed_actions must not silently leave it running unattended, so the two
-- columns are kept consistent by the database rather than by the form that
-- edits them.
ALTER TABLE public.agents
  ADD CONSTRAINT agents_autonomous_within_allowed
  CHECK (autonomous_actions <@ allowed_actions);

-- ============================================================
-- agent_proposals.status gains 'auto_applied'
-- ============================================================
-- A distinct status rather than reusing 'approved' with a null decided_by.
-- "Approved by nobody" is exactly the kind of record that reads as a bug three
-- months later, and the card needs to say which of the two happened.

DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT con.conname AS constraint_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'agent_proposals'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%superseded%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.agent_proposals DROP CONSTRAINT %I',
      target.constraint_name
    );
  END LOOP;
END;
$$;

ALTER TABLE public.agent_proposals
  ADD CONSTRAINT agent_proposals_status_check
  CHECK (status IN (
    'pending', 'approved', 'rejected', 'superseded', 'expired', 'auto_applied'
  ));

-- ============================================================
-- apply_agent_proposal_autonomously
-- ============================================================
-- The execute branches mirror decide_agent_proposal's, with one substitution:
-- the actor is the agent's own user_id rather than an approver's. That is the
-- honest attribution — a task nobody approved was created by the agent, and
-- recording a human as its author would put a name on work they never saw.
--
-- Not granted to `authenticated`. The only caller is the edge function holding
-- the service key, at finalisation, immediately after the reply is posted. A
-- member reaching this directly could apply a proposal the database has no
-- reason to think anyone reviewed.

CREATE OR REPLACE FUNCTION public.apply_agent_proposal_autonomously(
  p_proposal_id UUID
)
RETURNS public.agent_proposals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  prop public.agent_proposals;
  ag public.agents;
  payload JSONB;
  target_task public.product_tasks;
  new_id UUID;
  new_type TEXT;
  actor UUID;
  result public.agent_proposals;
BEGIN
  -- FOR UPDATE for the same reason the human path takes it: a retried
  -- finalisation must not apply the same proposal twice.
  SELECT * INTO prop FROM public.agent_proposals
  WHERE id = p_proposal_id FOR UPDATE;

  IF prop.id IS NULL THEN
    RAISE EXCEPTION 'proposal not found';
  END IF;

  IF prop.status <> 'pending' THEN
    RAISE EXCEPTION 'proposal has already been %', prop.status;
  END IF;

  SELECT * INTO ag FROM public.agents WHERE user_id = prop.agent_id;

  IF ag.user_id IS NULL THEN
    RAISE EXCEPTION 'proposing agent no longer exists';
  END IF;

  IF NOT ag.enabled THEN
    RAISE EXCEPTION 'agent % is disabled', ag.handle;
  END IF;

  -- Both lists, in order. allowed_actions is the containment that survives
  -- prompt injection; autonomous_actions is the operator's separate decision
  -- that this particular action needs no witness.
  IF NOT (prop.action = ANY (ag.allowed_actions)) THEN
    RAISE EXCEPTION 'agent % is not permitted to propose %', ag.handle, prop.action;
  END IF;

  IF NOT (prop.action = ANY (ag.autonomous_actions)) THEN
    RAISE EXCEPTION 'agent % must have % approved by a person', ag.handle, prop.action;
  END IF;

  actor := ag.user_id;
  payload := prop.payload;

  IF prop.action = 'knowledge_note' THEN
    INSERT INTO public.knowledge_items (kind, title, content, status, author_id)
    VALUES (
      'note',
      payload ->> 'title',
      payload ->> 'content',
      'draft',
      actor
    )
    RETURNING id INTO new_id;
    new_type := 'knowledge_item';

    IF prop.product_id IS NOT NULL THEN
      INSERT INTO public.knowledge_item_products (knowledge_item_id, product_id)
      VALUES (new_id, prop.product_id)
      ON CONFLICT DO NOTHING;
    END IF;

  ELSIF prop.action = 'task_create' THEN
    INSERT INTO public.product_tasks (
      product_id, parent_task_id, title, notes, due_date, assignee_id, created_by
    )
    VALUES (
      coalesce((payload ->> 'product_id')::UUID, prop.product_id),
      (payload ->> 'parent_task_id')::UUID,
      payload ->> 'title',
      payload ->> 'notes',
      (payload ->> 'due_date')::DATE,
      (payload ->> 'assignee_id')::UUID,
      actor
    )
    RETURNING id INTO new_id;
    new_type := 'product_task';

  ELSIF prop.action = 'task_update' THEN
    SELECT * INTO target_task FROM public.product_tasks
    WHERE id = (payload ->> 'task_id')::UUID;

    IF target_task.id IS NULL THEN
      RAISE EXCEPTION 'task in proposal no longer exists';
    END IF;

    UPDATE public.product_tasks
    SET title       = coalesce(payload ->> 'title', title),
        notes       = coalesce(payload ->> 'notes', notes),
        due_date    = coalesce((payload ->> 'due_date')::DATE, due_date),
        assignee_id = coalesce((payload ->> 'assignee_id')::UUID, assignee_id),
        status      = coalesce(payload ->> 'status', status)
    WHERE id = target_task.id
    RETURNING id INTO new_id;
    new_type := 'product_task';

  ELSIF prop.action = 'status_update' THEN
    INSERT INTO public.status_updates (
      product_id, author_id, source_type, source_ref, health, stage, summary, details
    )
    VALUES (
      coalesce((payload ->> 'product_id')::UUID, prop.product_id),
      actor,
      'manual',
      jsonb_build_object(
        'via', 'agent',
        'autonomous', true,
        'agent', ag.handle,
        'model', ag.model,
        'proposal_id', prop.id,
        'message_id', prop.message_id,
        'run_id', prop.run_id
      ),
      payload ->> 'health',
      payload ->> 'stage',
      payload ->> 'summary',
      payload ->> 'details'
    )
    RETURNING id INTO new_id;
    new_type := 'status_update';

  ELSE
    -- Reached only if autonomous_actions is widened without widening this body.
    RAISE EXCEPTION '% cannot be applied without approval', prop.action;
  END IF;

  UPDATE public.agent_proposals
  SET status = 'auto_applied',
      decided_at = now(),
      result_type = new_type,
      result_id = new_id
  WHERE id = prop.id
  RETURNING * INTO result;

  -- Only if the message has not already been promoted. The human path can set
  -- this freely because approving one proposal supersedes its siblings, so at
  -- most one ever executes. Several autonomous actions can land from a single
  -- run, and first-write-wins is a rule someone reading the row can predict.
  UPDATE public.messages
  SET promoted_to_type = new_type,
      promoted_to_id = new_id
  WHERE id = prop.message_id
    AND promoted_to_type IS NULL;

  -- Deliberately no supersede pass. The human path treats sibling proposals as
  -- alternatives because a person chose one of them. Nobody chose here, and an
  -- agent that emitted a note and a task meant to do both — cancelling the
  -- second because the first ran would silently drop half the work.

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_agent_proposal_autonomously(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_agent_proposal_autonomously(UUID) FROM authenticated;
