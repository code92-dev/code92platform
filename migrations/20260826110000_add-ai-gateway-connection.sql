-- Admin-managed Vercel AI Gateway access for the native fx harness.
--
-- This is deliberately a Gateway access key, not a model-provider key. Vercel
-- owns BYOK provider configuration; Code92 stores only the account-scoped key
-- that allows fx to reach that gateway. The key is encrypted in the same
-- server-only pattern as openrouter_connection and is released only to an
-- authenticated runner while it holds a live run lease.

CREATE TABLE public.ai_gateway_connection (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  key_ciphertext TEXT,
  key_iv TEXT,
  key_last_four TEXT
    CHECK (key_last_four IS NULL OR char_length(key_last_four) = 4),
  validated_at TIMESTAMPTZ,
  validation_error TEXT,
  connected_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ai_gateway_connection_key_complete CHECK (
    num_nonnulls(key_ciphertext, key_iv) IN (0, 2)
  )
);

CREATE TRIGGER ai_gateway_connection_updated_at
BEFORE UPDATE ON public.ai_gateway_connection
FOR EACH ROW EXECUTE FUNCTION system.update_updated_at();

ALTER TABLE public.ai_gateway_connection ENABLE ROW LEVEL SECURITY;

-- No client role can select this table. The status RPC below is the only
-- browser-readable path and structurally omits ciphertext and IV.
REVOKE ALL ON public.ai_gateway_connection FROM anon, authenticated;

INSERT INTO public.ai_gateway_connection (id) VALUES (TRUE)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.ai_gateway_connection_status()
RETURNS TABLE (
  is_configured BOOLEAN,
  key_last_four TEXT,
  validated_at TIMESTAMPTZ,
  validation_error TEXT,
  connected_by UUID,
  updated_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT
    c.key_ciphertext IS NOT NULL,
    c.key_last_four,
    c.validated_at,
    c.validation_error,
    c.connected_by,
    c.updated_at
  FROM public.ai_gateway_connection c
  WHERE public.is_admin();
$$;

GRANT EXECUTE ON FUNCTION public.ai_gateway_connection_status() TO authenticated;
