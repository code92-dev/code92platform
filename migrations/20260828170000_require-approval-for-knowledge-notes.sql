-- Knowledge notes contain model-authored, potentially proprietary content.
-- Keep them proposal-only so a person reviews the content before it becomes a
-- durable knowledge item. This is forward-only: the original migration has
-- already been applied and is intentionally left immutable.

UPDATE public.agents
SET autonomous_actions = array_remove(autonomous_actions, 'knowledge_note')
WHERE 'knowledge_note' = ANY (autonomous_actions);

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
      AND rel.relname = 'agents'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%autonomous_actions <@ ARRAY%'
  LOOP
    EXECUTE format('ALTER TABLE public.agents DROP CONSTRAINT %I', target.constraint_name);
  END LOOP;
END;
$$;

ALTER TABLE public.agents
  ADD CONSTRAINT agents_autonomous_actions_check
  CHECK (autonomous_actions <@ ARRAY[
    'task_create', 'task_update', 'status_update'
  ]::TEXT[]);

-- The function remains callable for human-approved knowledge_note proposals;
-- it simply cannot be reached through autonomous_actions anymore.
