'use client';

import {useState, useTransition} from 'react';
import {Bot, Pencil, Plus, Trash2} from 'lucide-react';
import {useTranslations} from 'next-intl';

import {
  archiveAgentAction,
  createAgentAction,
  updateAgentAction
} from '@/lib/actions/agents';
import {
  AGENT_RUNTIMES,
  PROPOSAL_ACTIONS,
  TOOL_PROFILES,
  isValidModelSlug,
  type Agent,
  type AgentRuntime,
  type ProposalAction,
  type ToolProfile
} from '@/lib/agents';

// Provisioning and editing agents. Admin-only, enforced by RLS on public.agents
// and by requireAdmin() in the actions — this component is the third layer and
// the least important of the three.

export default function AgentRosterPanel({agents}: {agents: Agent[]}) {
  const t = useTranslations('agents');
  // null = closed, 'create' = new agent, otherwise the user_id being edited.
  const [mode, setMode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [allowed, setAllowed] = useState<ProposalAction[]>([]);
  const [budget, setBudget] = useState('5');
  const [runtime, setRuntime] = useState<AgentRuntime>('direct_openrouter');
  const [toolProfile, setToolProfile] = useState<ToolProfile>('chat');
  const [maxToolSteps, setMaxToolSteps] = useState('12');
  const [maxRunSeconds, setMaxRunSeconds] = useState('240');

  const editing = mode !== null && mode !== 'create';

  function reset() {
    setHandle('');
    setDisplayName('');
    setDescription('');
    setModel('');
    setSystemPrompt('');
    setAllowed([]);
    setBudget('5');
    setRuntime('direct_openrouter');
    setToolProfile('chat');
    setMaxToolSteps('12');
    setMaxRunSeconds('240');
    setError(null);
  }

  function openCreate() {
    reset();
    setMode('create');
  }

  // The edit form is the create form with the fields filled in. handle is shown
  // but not editable: it is the address people type after @, and every message
  // already posted mentioning this agent used it.
  function openEdit(agent: Agent) {
    setHandle(agent.handle);
    setDisplayName(agent.display_name);
    setDescription(agent.description ?? '');
    setModel(agent.model);
    setSystemPrompt(agent.system_prompt);
    setAllowed([...agent.allowed_actions]);
    setBudget(String(agent.budget_usd_month ?? 5));
    setRuntime(agent.runtime ?? 'direct_openrouter');
    setToolProfile(agent.tool_profile ?? 'chat');
    setMaxToolSteps(String(agent.max_tool_steps ?? 12));
    setMaxRunSeconds(String(agent.max_run_seconds ?? 240));
    setError(null);
    setMode(agent.user_id);
  }

  function toggle(action: ProposalAction) {
    setAllowed((prev) =>
      prev.includes(action) ? prev.filter((a) => a !== action) : [...prev, action]
    );
  }

  // `error` holds a code, never prose, so that the action and the client-side
  // check can both feed it. Translated at render, as in ReleaseForm.
  function errorText(code: string) {
    return code === 'modelInvalid'
      ? t('create.modelInvalid')
      : t(`errors.${code}`);
  }

  function submit() {
    if (!isValidModelSlug(model)) {
      setError('modelInvalid');
      return;
    }
    setError(null);

    startTransition(async () => {
      // Same fields either way; only handle is create-only, because identity is
      // not editable once messages have been addressed to it.
      const result = editing
        ? await updateAgentAction({
            userId: mode as string,
            displayName: displayName.trim(),
            description: description.trim() || null,
            systemPrompt: systemPrompt.trim(),
            model: model.trim(),
            allowedActions: allowed,
            budgetUsdMonth: Number(budget) || 5,
            runtime,
            toolProfile,
            maxToolSteps: Number(maxToolSteps) || 12,
            maxRunSeconds: Number(maxRunSeconds) || 240
          })
        : await createAgentAction({
            handle: handle.trim().toLowerCase(),
            displayName: displayName.trim(),
            description: description.trim() || undefined,
            systemPrompt: systemPrompt.trim(),
            model: model.trim(),
            allowedActions: allowed,
            budgetUsdMonth: Number(budget) || 5
          });

      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMode(null);
      reset();
    });
  }

  function setEnabled(agent: Agent, enabled: boolean) {
    startTransition(async () => {
      await updateAgentAction({userId: agent.user_id, enabled});
    });
  }

  // Removal keeps the row and sets archived_at, so everything the agent ever
  // proposed stays attributable. The confirm says so rather than implying a
  // delete that is not happening.
  function remove(agent: Agent) {
    if (!window.confirm(t('roster.removeConfirm', {name: agent.display_name}))) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await archiveAgentAction({userId: agent.user_id});
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (mode === agent.user_id) {
        setMode(null);
        reset();
      }
    });
  }

  return (
    <section className="space-y-3">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium text-ink">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted">{t('subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => (mode === 'create' ? setMode(null) : openCreate())}
          className="inline-flex shrink-0 items-center gap-1.5 rounded border border-hairline bg-raised px-3 py-1.5 text-sm text-muted transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          {t('create.button')}
        </button>
      </header>

      {mode !== null ? (
        <div className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t('create.handle')}
              hint={editing ? t('create.handleLocked') : t('create.handleHint')}
            >
              <input
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                dir="ltr"
                placeholder="warden"
                readOnly={editing}
                aria-readonly={editing}
                className={`rounded border border-hairline px-3 py-2 font-mono text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none ${
                  editing ? 'cursor-not-allowed bg-raised text-muted' : 'bg-bg'
                }`}
              />
            </Field>
            <Field label={t('create.displayName')}>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                dir="auto"
                className="rounded border border-hairline bg-bg px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
              />
            </Field>
          </div>

          <Field label={t('create.description')}>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              dir="auto"
              className="rounded border border-hairline bg-bg px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </Field>

          {/* Pasted verbatim from openrouter.ai/models. Deliberately a free text
              field rather than a select: OpenRouter adds models constantly, and a
              dropdown we maintain would be out of date the week after it ships. */}
          <Field label={t('create.model')} hint={t('create.modelHint')}>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              dir="ltr"
              spellCheck={false}
              placeholder="anthropic/claude-sonnet-4.5"
              className="rounded border border-hairline bg-bg px-3 py-2 font-mono text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
            />
          </Field>

          <Field label={t('create.systemPrompt')} hint={t('create.systemPromptHint')}>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={5}
              dir="auto"
              className="rounded border border-hairline bg-bg px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </Field>

          <Field label={t('create.allowedActions')} hint={t('create.allowedHint')}>
            <div className="flex flex-wrap gap-2">
              {PROPOSAL_ACTIONS.map((action) => {
                const on = allowed.includes(action);
                return (
                  <button
                    key={action}
                    type="button"
                    onClick={() => toggle(action)}
                    aria-pressed={on}
                    className={`rounded border px-2.5 py-1 font-mono text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                      on
                        ? 'border-accent/30 bg-accent/10 text-accent'
                        : 'border-hairline bg-raised text-faint hover:text-muted'
                    }`}
                  >
                    {t(`actions.${action}`)}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label={t('create.budget')}>
            <input
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              dir="ltr"
              inputMode="decimal"
              className="w-32 rounded border border-hairline bg-bg px-3 py-2 font-mono text-sm text-ink focus:border-accent focus:outline-none"
            />
          </Field>

          {/* Runtime is edit-only on purpose. An agent is created on the
              OpenRouter path and promoted to the harness afterwards, as a
              separate decision taken once the runner is known to be healthy.
              Offering it in the create form would make the riskiest setting the
              easiest one to pick by accident. */}
          {editing ? (
            <div className="flex flex-col gap-3 rounded border border-hairline bg-raised/40 p-3">
              <Field label={t('create.runtime')} hint={t('create.runtimeHint')}>
                <select
                  value={runtime}
                  onChange={(e) => setRuntime(e.target.value as AgentRuntime)}
                  className="w-full rounded border border-hairline bg-bg px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
                >
                  {AGENT_RUNTIMES.map((value) => (
                    <option key={value} value={value}>
                      {t(`runtimes.${value}`)}
                    </option>
                  ))}
                </select>
              </Field>

              {runtime === 'jcode' ? (
                <>
                  <p className="text-xs text-amber">{t('create.runtimeWarning')}</p>

                  <Field label={t('create.toolProfile')} hint={t('create.toolProfileHint')}>
                    <select
                      value={toolProfile}
                      onChange={(e) => setToolProfile(e.target.value as ToolProfile)}
                      className="w-full rounded border border-hairline bg-bg px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
                    >
                      {TOOL_PROFILES.map((value) => (
                        <option key={value} value={value}>
                          {t(`toolProfiles.${value}`)}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t('create.maxToolSteps')} hint={t('create.maxToolStepsHint')}>
                      <input
                        value={maxToolSteps}
                        onChange={(e) => setMaxToolSteps(e.target.value)}
                        dir="ltr"
                        inputMode="numeric"
                        className="w-full rounded border border-hairline bg-bg px-3 py-2 font-mono text-sm text-ink focus:border-accent focus:outline-none"
                      />
                    </Field>
                    <Field label={t('create.maxRunSeconds')} hint={t('create.maxRunSecondsHint')}>
                      <input
                        value={maxRunSeconds}
                        onChange={(e) => setMaxRunSeconds(e.target.value)}
                        dir="ltr"
                        inputMode="numeric"
                        className="w-full rounded border border-hairline bg-bg px-3 py-2 font-mono text-sm text-ink focus:border-accent focus:outline-none"
                      />
                    </Field>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p className="text-xs text-danger">{errorText(error)}</p>
          ) : null}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              className="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-bg transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            >
              {editing ? t('create.save') : t('create.submit')}
            </button>
            <button
              type="button"
              onClick={() => {
                setMode(null);
                reset();
              }}
              className="rounded border border-hairline bg-raised px-3 py-1.5 text-sm text-muted transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('create.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {mode === null && error ? (
        <p className="text-xs text-danger">{errorText(error)}</p>
      ) : null}

      {agents.length === 0 ? (
        <p className="rounded-lg border border-dashed border-hairline bg-panel px-4 py-8 text-center text-sm text-faint">
          {t('roster.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {agents.map((agent) => (
            <li
              key={agent.user_id}
              className="rounded-lg border border-hairline bg-panel p-4"
            >
              <div className="flex flex-wrap items-start gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent/10 text-accent">
                  <Bot className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">
                    {agent.display_name}{' '}
                    <span className="font-mono text-[11px] text-accent">
                      @{agent.handle}
                    </span>
                  </p>
                  {agent.description ? (
                    <p dir="auto" className="mt-0.5 text-xs text-muted">
                      {agent.description}
                    </p>
                  ) : null}
                  <p className="mt-1.5 font-mono text-[11px] text-faint" dir="ltr">
                    {t('roster.model')}: {agent.model}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {agent.allowed_actions.length === 0 ? (
                      <span className="font-mono text-[10px] uppercase tracking-widest text-faint">
                        {t('roster.nothing')}
                      </span>
                    ) : (
                      agent.allowed_actions.map((a) => (
                        <span
                          key={a}
                          className="rounded border border-hairline bg-raised px-2 py-0.5 font-mono text-[10px] text-muted"
                        >
                          {t(`actions.${a}`)}
                        </span>
                      ))
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setEnabled(agent, !agent.enabled)}
                    disabled={pending}
                    className={`rounded border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40 ${
                      agent.enabled
                        ? 'border-accent/30 bg-accent/10 text-accent'
                        : 'border-hairline bg-raised text-faint'
                    }`}
                  >
                    {agent.enabled ? t('roster.enabled') : t('roster.disabled')}
                  </button>
                  <button
                    type="button"
                    onClick={() => openEdit(agent)}
                    disabled={pending}
                    aria-label={t('roster.edit')}
                    title={t('roster.edit')}
                    className="rounded border border-hairline bg-raised p-1.5 text-muted transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
                  >
                    <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(agent)}
                    disabled={pending}
                    aria-label={t('roster.remove')}
                    title={t('roster.remove')}
                    className="rounded border border-hairline bg-raised p-1.5 text-muted transition-colors hover:border-danger/30 hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-widest text-faint">
        {label}
      </span>
      {children}
      {hint ? <span className="text-xs text-faint">{hint}</span> : null}
    </label>
  );
}
