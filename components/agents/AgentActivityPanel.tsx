import {Activity, CircleAlert, Clock3, Wrench} from 'lucide-react';
import {getTranslations} from 'next-intl/server';

import type {Agent, AgentRun} from '@/lib/agents';

// The runner records progress in the database so an operator can distinguish a
// queued run from one genuinely doing tool work. This is deliberately read-only:
// stopping a process without a durable cancellation protocol would be a false
// control, so cancellation remains a runner-side operational action for now.
export default async function AgentActivityPanel({
  agents,
  runs
}: {
  agents: Agent[];
  runs: AgentRun[];
}) {
  const t = await getTranslations('agents');
  const agentById = new Map(agents.map((agent) => [agent.user_id, agent]));

  return (
    <section className="space-y-3">
      <header>
        <h2 className="text-sm font-medium text-ink">{t('runs.title')}</h2>
        <p className="mt-0.5 text-xs text-muted">{t('runs.subtitle')}</p>
      </header>

      {runs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-hairline bg-panel px-4 py-8 text-center text-sm text-faint">
          {t('runs.empty')}
        </p>
      ) : (
        <ol className="overflow-hidden rounded-lg border border-hairline bg-panel">
          {runs.map((run) => {
            const agent = run.agent_id ? agentById.get(run.agent_id) : undefined;
            const running = run.status === 'running' || run.status === 'pending';
            return (
              <li key={run.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline px-4 py-3 last:border-b-0">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded border ${running ? 'border-accent/30 bg-accent/10 text-accent' : 'border-hairline bg-raised text-faint'}`}>
                  {run.status === 'failed' ? <CircleAlert className="h-3.5 w-3.5" /> : run.runtime === 'fx' ? <Wrench className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-40 flex-1">
                  <p className="text-sm text-ink">
                    {agent ? `@${agent.handle}` : t('runs.unknownAgent')}
                    <span className="ms-2 font-mono text-[10px] text-faint">{t(`runtime.${run.runtime}`)}</span>
                  </p>
                  <p className="mt-0.5 font-mono text-[10px] text-faint">
                    {t(`runs.status.${run.status}`)} · {t(`runs.phase.${run.execution_phase}`)}
                    {run.prompt_tokens !== null || run.completion_tokens !== null
                      ? ` · ${t('runs.tokens')}: ${(run.prompt_tokens ?? 0) + (run.completion_tokens ?? 0)}`
                      : ''}
                    {run.cost_usd !== null ? ` · ${t('runs.cost')}: $${Number(run.cost_usd).toFixed(4)}` : ''}
                  </p>
                  {run.error ? <p className="mt-1 text-xs text-danger">{run.error}</p> : null}
                </div>
                <time className="inline-flex items-center gap-1 text-[11px] text-faint" dateTime={run.created_at}>
                  <Clock3 className="h-3 w-3" />
                  {new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(new Date(run.created_at))}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
