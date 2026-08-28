-- Files attached in a channel land in the knowledge base.
--
-- The request was "attach files in channels, and those files are stored by
-- default to the knowledge section". The tempting build is a message_attachments
-- table that owns the file, plus a mirror into knowledge_items. That is the
-- shape 20260803120000_sync-artifacts-into-knowledge.sql had to adopt for
-- lifecycle artifacts, and only because phase_artifacts already existed and
-- already owned those rows.
--
-- Nothing owns a channel attachment yet, so there is no second table to
-- reconcile. The knowledge item IS the attachment: one row, kind='source',
-- origin='channel', pointing back at the message it arrived on. A message
-- renders its files by selecting the knowledge items that name it. There is no
-- mirror to keep in step and no second copy of the bytes, because there is no
-- second row.
--
-- Uploads go to the existing 'knowledge-files' bucket rather than a new one, so
-- the signed-URL reader that already serves knowledge sources serves these
-- unchanged — a channel attachment is a knowledge source that happens to have
-- arrived through a conversation.

-- ============================================================
-- Provenance
-- ============================================================

-- ON DELETE CASCADE, matching source_artifact_id. Deleting a message in this
-- product is soft (messages.deleted_at), so this never fires on an ordinary
-- delete — the tombstone keeps its files. It fires when the channel itself is
-- removed, and at that point an orphaned knowledge item pointing at a message
-- that no longer exists would be worse than losing it.
ALTER TABLE public.knowledge_items
  ADD COLUMN source_message_id UUID
    REFERENCES public.messages(id) ON DELETE CASCADE;

-- Not UNIQUE, unlike source_artifact_id: one message can carry several files,
-- and each is its own source item.
CREATE INDEX knowledge_items_source_message_idx
ON public.knowledge_items (source_message_id)
WHERE source_message_id IS NOT NULL;

-- Widening a CHECK means dropping and recreating it. Looked up rather than
-- named, for the reason 20260826140000 gives: a constraint created inline with
-- the table carries whatever name PostgreSQL chose, and DROP CONSTRAINT on a
-- guessed name is a migration that fails on someone else's database.
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
      AND rel.relname = 'knowledge_items'
      AND con.contype = 'c'
      AND (
        pg_get_constraintdef(con.oid) LIKE '%source_artifact_id%'
        OR pg_get_constraintdef(con.oid) LIKE '%''lifecycle''%'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE public.knowledge_items DROP CONSTRAINT %I',
      target.constraint_name
    );
  END LOOP;
END;
$$;

ALTER TABLE public.knowledge_items
  ADD CONSTRAINT knowledge_items_origin_check
  CHECK (origin IN ('manual', 'lifecycle', 'channel'));

-- Each origin is exactly identified by which provenance column is set. Without
-- this an item could claim origin='channel' while naming an artifact, and every
-- consumer would have to decide which column to believe.
ALTER TABLE public.knowledge_items
  ADD CONSTRAINT knowledge_items_origin_matches_source
  CHECK (
    (origin = 'lifecycle') = (source_artifact_id IS NOT NULL)
    AND (origin = 'channel') = (source_message_id IS NOT NULL)
  );

-- ============================================================
-- Immutability
-- ============================================================
-- Same rule the lifecycle branch already enforces: once an item records where
-- it came from, that record does not move. Retitling and restatusing stay open,
-- because triaging an incoming file is the entire point of status='to_review'.

CREATE OR REPLACE FUNCTION public.validate_knowledge_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.title := btrim(NEW.title);

  IF TG_OP = 'UPDATE' THEN
    IF NEW.author_id IS DISTINCT FROM OLD.author_id THEN
      RAISE EXCEPTION 'knowledge item author is immutable';
    END IF;
    IF NEW.kind IS DISTINCT FROM OLD.kind
       AND 'source' IN (NEW.kind, OLD.kind) THEN
      RAISE EXCEPTION 'a source cannot be converted to another kind';
    END IF;

    IF OLD.origin = 'lifecycle' AND (
      NEW.origin IS DISTINCT FROM OLD.origin
      OR NEW.source_artifact_id IS DISTINCT FROM OLD.source_artifact_id
      OR NEW.file_key IS DISTINCT FROM OLD.file_key
      OR NEW.file_bucket IS DISTINCT FROM OLD.file_bucket
      OR NEW.url IS DISTINCT FROM OLD.url
    ) THEN
      RAISE EXCEPTION 'the source of a lifecycle-derived knowledge item is immutable';
    END IF;

    IF OLD.origin = 'channel' AND (
      NEW.origin IS DISTINCT FROM OLD.origin
      OR NEW.source_message_id IS DISTINCT FROM OLD.source_message_id
      OR NEW.file_key IS DISTINCT FROM OLD.file_key
      OR NEW.file_bucket IS DISTINCT FROM OLD.file_bucket
    ) THEN
      RAISE EXCEPTION 'the source of a channel attachment is immutable';
    END IF;

    -- Covers manual -> lifecycle and manual -> channel alike.
    IF OLD.origin = 'manual' AND NEW.origin IS DISTINCT FROM OLD.origin THEN
      RAISE EXCEPTION 'a knowledge item cannot be reassigned an origin';
    END IF;
  END IF;

  IF NEW.status IS NULL THEN
    NEW.status := CASE WHEN NEW.kind = 'source' THEN 'to_review' ELSE 'draft' END;
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================================
-- The write path
-- ============================================================
-- source_message_id and origin are not in the column-level INSERT grant, which
-- is deliberate and is the same omission 20260803120000 made: a member who
-- could set them by hand could forge an item claiming to have come from a
-- conversation it was never in. Attaching therefore goes through this function,
-- which derives both from the message id it is given.
--
-- SECURITY DEFINER, and it re-derives the caller's authority rather than
-- assuming it: only the message's own author may attach to it, and only while
-- they are an active member. That is narrower than "any active member", because
-- attaching to someone else's message puts a file in the knowledge base under
-- their name.

CREATE OR REPLACE FUNCTION public.attach_files_to_message(
  p_message_id UUID,
  p_files JSONB
)
RETURNS SETOF public.knowledge_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor UUID := (SELECT auth.uid());
  msg public.messages;
  file JSONB;
  created public.knowledge_items;
  seen INTEGER := 0;
BEGIN
  IF NOT public.is_active_member() THEN
    RAISE EXCEPTION 'only active members can attach files';
  END IF;

  SELECT * INTO msg FROM public.messages WHERE id = p_message_id;

  IF msg.id IS NULL THEN
    RAISE EXCEPTION 'message does not exist';
  END IF;

  IF msg.author_id IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'only the author of a message can attach files to it';
  END IF;

  IF msg.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'cannot attach files to a deleted message';
  END IF;

  IF jsonb_typeof(p_files) <> 'array' THEN
    RAISE EXCEPTION 'files must be an array';
  END IF;

  FOR file IN SELECT * FROM jsonb_array_elements(p_files)
  LOOP
    seen := seen + 1;
    -- The same ceiling every other upload surface uses. Enforced here as well
    -- as in the client because the client is not what this function trusts.
    IF seen > 8 THEN
      RAISE EXCEPTION 'at most 8 files can be attached at once';
    END IF;

    IF NOT public.is_allowed_attachment_type(file ->> 'mime_type') THEN
      RAISE EXCEPTION 'unsupported file type %', file ->> 'mime_type';
    END IF;

    INSERT INTO public.knowledge_items (
      kind, title, status, author_id,
      file_url, file_key, file_name, mime_type, size_bytes,
      file_bucket, origin, source_message_id
    )
    VALUES (
      'source',
      -- The file name is the title. A source needs one, and asking for a title
      -- per file in a chat composer is friction nobody would pay; the knowledge
      -- page can rename it afterwards, which is what 'to_review' is for.
      left(coalesce(nullif(btrim(file ->> 'file_name'), ''), 'attachment'), 200),
      'to_review',
      actor,
      file ->> 'file_url',
      file ->> 'file_key',
      file ->> 'file_name',
      file ->> 'mime_type',
      (file ->> 'size_bytes')::BIGINT,
      'knowledge-files',
      'channel',
      msg.id
    )
    RETURNING * INTO created;

    -- A product channel's files belong to that product, so they surface under
    -- it in the knowledge base without anyone tagging them by hand.
    INSERT INTO public.knowledge_item_products (knowledge_item_id, product_id)
    SELECT created.id, c.product_id
    FROM public.channels c
    WHERE c.id = msg.channel_id AND c.product_id IS NOT NULL
    ON CONFLICT DO NOTHING;

    RETURN NEXT created;
  END LOOP;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.attach_files_to_message(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attach_files_to_message(UUID, JSONB) TO authenticated;
