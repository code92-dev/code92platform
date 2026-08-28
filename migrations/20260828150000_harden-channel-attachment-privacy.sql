-- A channel attachment is a knowledge item, but its visibility must follow the
-- message that owns it. In particular, putting a file in a direct message must
-- not make that file searchable or signable by every active team member.
--
-- SECURITY DEFINER is intentional: the knowledge_items SELECT policy calls
-- this helper for the row currently under evaluation, so reading that row again
-- with invoker rights would recurse through the same policy.

CREATE OR REPLACE FUNCTION public.can_read_knowledge_item(p_item_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.is_active_member()
     AND EXISTS (
       SELECT 1
       FROM public.knowledge_items ki
       LEFT JOIN public.messages m ON m.id = ki.source_message_id
       WHERE ki.id = p_item_id
         AND (
           ki.origin <> 'channel'
           OR (
             m.id IS NOT NULL
             AND public.can_read_channel(m.channel_id)
           )
         )
     );
$$;

REVOKE ALL ON FUNCTION public.can_read_knowledge_item(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_read_knowledge_item(UUID) TO authenticated;

DROP POLICY "active members read knowledge items" ON public.knowledge_items;
CREATE POLICY "active members read knowledge items"
ON public.knowledge_items FOR SELECT TO authenticated
USING (public.can_read_knowledge_item(id));

-- The link tables otherwise reveal that a private attachment exists and which
-- product/tag it is associated with even when the knowledge item itself is
-- hidden. They follow the same item-level visibility rule.
DROP POLICY "active members read knowledge item tags" ON public.knowledge_item_tags;
CREATE POLICY "active members read knowledge item tags"
ON public.knowledge_item_tags FOR SELECT TO authenticated
USING (public.can_read_knowledge_item(item_id));

DROP POLICY "active members read knowledge item products" ON public.knowledge_item_products;
CREATE POLICY "active members read knowledge item products"
ON public.knowledge_item_products FOR SELECT TO authenticated
USING (public.can_read_knowledge_item(item_id));
