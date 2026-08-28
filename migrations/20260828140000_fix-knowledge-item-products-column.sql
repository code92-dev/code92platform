-- Three functions insert into knowledge_item_products naming a column that does
-- not exist.
--
-- The table's columns are (item_id, product_id). All three wrote
-- (knowledge_item_id, product_id) and failed at runtime with
-- `column "knowledge_item_id" of relation "knowledge_item_products" does not exist`.
--
-- PL/pgSQL resolves column names when a statement first executes, not when the
-- function is created, so nothing caught this at migration time and all three
-- sat in the database looking healthy.
--
--   * decide_agent_proposal — pre-existing, since 20260825091000. The branch
--     only runs for a proposal carrying a product_id, so approving a
--     knowledge_note in a product-bound channel has always been broken. Every
--     other action, and any proposal in an unbound channel, took a different
--     path, which is why it went unnoticed for three days.
--   * apply_agent_proposal_autonomously — 20260827110000, same branch copied.
--   * attach_files_to_message — 20260827100000, the same mistake copied into
--     the code that files a channel attachment under its product. This is the
--     one that surfaced it: attaching a file in a product-bound channel is the
--     first thing to reach that INSERT in normal use.
--
-- Repaired by rewriting each live definition rather than restating it.
-- Retyping decide_agent_proposal — two hundred lines whose whole job is
-- re-deriving an approver's authority — to change one identifier would risk a
-- transcription error in security-critical code for no benefit.
-- pg_get_functiondef returns what is actually installed, so what is
-- re-executed is exactly that, apart from the column name.
--
-- Written to be safe to re-run: a function that already reads item_id is left
-- alone rather than treated as an error, so this converges whether it meets a
-- database that was repaired by hand first or one that never was.

DO $$
DECLARE
  target RECORD;
  original TEXT;
  patched TEXT;
BEGIN
  FOR target IN
    SELECT p.oid, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.proname IN (
        'decide_agent_proposal',
        'apply_agent_proposal_autonomously',
        'attach_files_to_message'
      )
  LOOP
    original := pg_get_functiondef(target.oid);
    patched := replace(
      original,
      'knowledge_item_products (knowledge_item_id, product_id)',
      'knowledge_item_products (item_id, product_id)'
    );

    IF patched <> original THEN
      EXECUTE patched;
      RAISE NOTICE 'repaired knowledge_item_products insert in %', target.proname;
    END IF;
  END LOOP;
END;
$$;

-- Prove it.
--
-- prokind = 'f' is load-bearing, not tidiness. public contains aggregate
-- entries (avg, sum), and pg_get_functiondef() raises
-- `"array_agg" is an aggregate function` rather than returning text for one —
-- so a scan of every proc in the schema fails before it can check anything.
-- Only plain functions are describable, and only plain functions can contain
-- the INSERT this is looking for.
DO $$
DECLARE
  broken BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) LIKE '%knowledge_item_products (knowledge_item_id%'
  ) INTO broken;

  IF broken THEN
    RAISE EXCEPTION 'a function still inserts knowledge_item_products.knowledge_item_id';
  END IF;
END;
$$;
