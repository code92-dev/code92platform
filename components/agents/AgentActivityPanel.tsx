import {Activity, CircleAlert, Clock3, Wrench} from 'lucide-react';
import {getTranslations} from 'next-intl/server';

import type {Agent, AgentRun} from '@/lib/agents';

// What the harness is doing, and what it cost.
//
// A run on the OpenRouter path takes seconds and either worked or did not. A
// harness run takes minutes, and without a surface like this the only thing an
// admin can see is that nothing has happened yet — which is indistinguishable
// from a runner that is down. The phase is the useful column: it is the
// difference between "queued behind a full runner" and "four minutes into a
// tool call".
//
// Read-only on purpose. Stopping a process without a durable cancellation
// protocol would be a button that lies; agent_runs.cancel_requested_at exists
// for that and nothing honours it yet.
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
            const active = run.status === 'running' || run.status === 'pending';
            const tokens = (run.prompt_tokens ?? 0) + (run.completion_tokens ?? 0);

            return (
              <li
                key={run.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline px-4 py-3 last:border-b-0"
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded border ${
                    active
                      ? 'border-accent/30 bg-accent/10 text-accent'
                      : 'border-hairline bg-raised text-faint'
                  }`}
                >
                  {run.status === 'failed' ? (
                    <CircleAlert className="h-3.5 w-3.5" strokeWidth={1.75} />
                  ) : run.runtime === 'jcode' ? (
                    <Wrench className="h-3.5 w-3.5" strokeWidth={1.75} />
                  ) : (
                    <Activity className="h-3.5 w-3.5" strokeWidth={1.75} />
                  )}
                </span>

                <div className="min-w-40 flex-1">
                  <p className="text-sm text-ink">
                    <span dir="ltr" className="font-mono">
                      {agent ? `@${agent.handle}` : t('runs.unknownAgent')}
                    </span>
                    {/* A real separator, not just the margin below. `ms-2` is
                        CSS, so it is invisible to copy-paste and to a screen
                        reader: the two spans ran together as
                        "@system_architectjcode harness". */}
                    <span className="mx-2 text-[11px] text-faint">·</span>
                    <span className="text-[11px] text-faint">
                      {t(`runtimes.${run.runtime}`)}
                    </span>
                  </p>
                  <p className="mt-0.5 font-mono text-[10px] text-faint">
                    {[
                      t(`runs.status.${run.status}`),
                      // Only the harness has phases worth reporting; on the
                      // OpenRouter path every run is 'queued' then done, and
                      // showing that would be noise pretending to be detail.
                      run.runtime === 'jcode' ? t(`runs.phase.${run.execution_phase}`) : null,
                      tokens > 0 ? `${t('runs.tokens')}: ${tokens}` : null,
                      run.cost_usd !== null
                        ? `${t('runs.cost')}: $${Number(run.cost_usd).toFixed(4)}`
                        : null
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {run.error ? (
                    <p dir="auto" className="mt-1 text-xs text-danger">
                      {run.error}
                    </p>
                  ) : null}
                </div>

                <time
                  className="inline-flex items-center gap-1 text-[11px] text-faint"
                  dateTime={run.created_at}
                >
                  <Clock3 className="h-3 w-3" strokeWidth={1.75} />
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short'
                  }).format(new Date(run.created_at))}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
