-- Autonomous proposals execute model-authored JSON without a human reviewing
-- it first. The product boundary must therefore come from the channel-derived
-- agent_proposals.product_id, never from a model-supplied product_id/task_id.

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
      'note', payload ->> 'title', payload ->> 'content', 'draft', actor
    )
    RETURNING id INTO new_id;
    new_type := 'knowledge_item';

    IF prop.product_id IS NOT NULL THEN
      INSERT INTO public.knowledge_item_products (item_id, product_id)
      VALUES (new_id, prop.product_id)
      ON CONFLICT DO NOTHING;
    END IF;

  ELSIF prop.action IN ('task_create', 'task_update', 'status_update')
        AND prop.product_id IS NULL THEN
    -- A standing channel has no database-derived product boundary. Requiring a
    -- person to approve its product-scoped proposal is safer than trusting the
    -- model to choose which product unattended work may mutate.
    RAISE EXCEPTION '% requires a product-bound channel for autonomous execution', prop.action;

  ELSIF prop.action = 'task_create' THEN
    INSERT INTO public.product_tasks (
      product_id, parent_task_id, title, notes, due_date, assignee_id, created_by
    )
    VALUES (
      prop.product_id,
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
    WHERE id = (payload ->> 'task_id')::UUID
      AND product_id = prop.product_id;

    IF target_task.id IS NULL THEN
      RAISE EXCEPTION 'task in proposal is unavailable in this product';
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
      prop.product_id,
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
    RAISE EXCEPTION '% cannot be applied without approval', prop.action;
  END IF;

  UPDATE public.agent_proposals
  SET status = 'auto_applied',
      decided_at = now(),
      result_type = new_type,
      result_id = new_id
  WHERE id = prop.id
  RETURNING * INTO result;

  UPDATE public.messages
  SET promoted_to_type = new_type,
      promoted_to_id = new_id
  WHERE id = prop.message_id
    AND promoted_to_type IS NULL;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_agent_proposal_autonomously(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_agent_proposal_autonomously(UUID) FROM authenticated;
