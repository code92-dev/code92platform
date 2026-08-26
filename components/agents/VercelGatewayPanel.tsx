'use client';

import {useState, useTransition} from 'react';
import {CircleCheck, ExternalLink, KeyRound, Trash2} from 'lucide-react';
import {useTranslations} from 'next-intl';

import RelativeTime from '@/components/RelativeTime';
import {
  clearAiGatewayKeyAction,
  saveAiGatewayKeyAction,
  testAiGatewayKeyAction
} from '@/lib/actions/agents';
import {looksLikeAiGatewayKey, type AiGatewayStatus} from '@/lib/agents';

// Provider keys are intentionally not collected here. Vercel's BYOK controls
// validate and retain those credentials; this panel manages only the Gateway
// access key that the fx runner needs to authenticate its requests.
export default function VercelGatewayPanel({
  status
}: {
  status: AiGatewayStatus | null;
}) {
  const t = useTranslations('agents');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const configured = status?.is_configured ?? false;

  function errorText(code: string) {
    return code === 'not_configured'
      ? t('aiGateway.notConfigured')
      : t(`errors.${code}`);
  }

  function save() {
    const trimmed = key.trim();
    if (!looksLikeAiGatewayKey(trimmed)) {
      setError('invalid');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await saveAiGatewayKeyAction({apiKey: trimmed});
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setKey('');
    });
  }

  function run(action: () => Promise<{ok: boolean; error?: string}>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? 'generic');
    });
  }

  return (
    <section className="space-y-3">
      <header>
        <h2 className="text-sm font-medium text-ink">{t('aiGateway.title')}</h2>
        <p className="mt-0.5 text-xs text-muted">{t('aiGateway.subtitle')}</p>
      </header>

      <div className="rounded-lg border border-hairline bg-panel p-4">
        {configured ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded border border-accent/30 bg-accent/10 px-2 py-0.5 font-mono text-[11px] text-accent">
                <CircleCheck className="h-3 w-3" strokeWidth={2} />
                {t('aiGateway.configured', {lastFour: status?.key_last_four ?? '····'})}
              </span>
            </div>

            {status?.validation_error ? (
              <p className="text-xs text-danger">
                {t('aiGateway.checkFailed', {error: status.validation_error})}
              </p>
            ) : status?.validated_at ? (
              <p className="font-mono text-[11px] text-faint">
                <RelativeTime date={status.validated_at} />
              </p>
            ) : null}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => run(testAiGatewayKeyAction)}
                disabled={pending}
                className="rounded border border-hairline bg-raised px-3 py-1.5 text-sm text-muted transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
              >
                {t('aiGateway.test')}
              </button>
              <button
                type="button"
                onClick={() => run(clearAiGatewayKeyAction)}
                disabled={pending}
                className="inline-flex items-center gap-1.5 rounded border border-danger/30 bg-danger/10 px-3 py-1.5 text-sm text-danger transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                {t('aiGateway.clear')}
              </button>
            </div>
          </div>
        ) : (
          <p className="mb-3 text-sm text-muted">{t('aiGateway.notConfigured')}</p>
        )}

        <div className="mt-4 flex flex-col gap-2 border-t border-hairline pt-4">
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-widest text-faint">
              {t('aiGateway.apiKey')}
            </span>
            <input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              dir="ltr"
              autoComplete="off"
              placeholder="…"
              disabled={pending}
              className="rounded border border-hairline bg-bg px-3 py-2 font-mono text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-50"
            />
            <span className="text-xs text-faint">{t('aiGateway.apiKeyHint')}</span>
          </label>

          <a
            href="https://vercel.com/docs/ai-gateway/authentication-and-byok/byok"
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1 text-xs text-accent underline underline-offset-2"
          >
            {t('aiGateway.byokLink')}
            <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
          </a>

          {error ? <p className="text-xs text-danger">{errorText(error)}</p> : null}

          <button
            type="button"
            onClick={save}
            disabled={pending || !key.trim()}
            className="inline-flex w-fit items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-sm font-semibold text-bg transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
          >
            <KeyRound className="h-3.5 w-3.5" strokeWidth={2} />
            {pending ? t('aiGateway.saving') : t('aiGateway.save')}
          </button>
        </div>
      </div>
    </section>
  );
}
