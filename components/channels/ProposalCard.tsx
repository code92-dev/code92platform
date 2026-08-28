'use client';

import {useState, useTransition} from 'react';
import {Check, ChevronDown, ChevronRight, Sparkles, X} from 'lucide-react';
import {useTranslations} from 'next-intl';

import RelativeTime from '@/components/RelativeTime';
import {
  decideProposalAction,
  retryApprovedPatchAction
} from '@/lib/actions/agents';
import {
  ADMIN_ONLY_ACTIONS,
  DEFERRED_ACTIONS,
  WAIVER_ACTIONS,
  type AgentProposal
} from '@/lib/agents';

// The card a human decides on. Two rules are visible in this file and enforced
// again in SQL, which is where they actually hold:
//
//   1. The payload is shown IN FULL, never summarised. An approver deciding from
//      a one-line précis of what an agent wants to change is the failure mode the
//      whole propose-only design exists to prevent.
//   2. The waiver reason is an empty box the approver types into. It is never
//      pre-filled from the proposal — decide_agent_proposal ignores any waiver in
//      the payload, and thread-agent strips it before writing the row.

export default function ProposalCard({
  proposal,
  agentHandle,
  deciderName,
  isAdmin
}: {
  proposal: AgentProposal;
  agentHandle: string;
  deciderName: string | null;
  isAdmin: boolean;
}) {
  const t = useTranslations('agents');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [showPayload, setShowPayload] = useState(false);
  const [waiver, setWaiver] = useState('');
  const [note, setNote] = useState('');

  const needsAdmin = ADMIN_ONLY_ACTIONS.has(proposal.action);
  const takesWaiver = WAIVER_ACTIONS.has(proposal.action);
  // A patch is approved in the database and committed afterwards, so 'approved'
  // is not the end of its story and the card must not pretend otherwise.
  const isDeferred = DEFERRED_ACTIONS.has(proposal.action);
  const patchFiles =
    proposal.action === 'repo_patch' &&
    Array.isArray((proposal.payload as {files?: unknown}).files)
      ? ((proposal.payload as {files: Array<{path?: string; remove?: boolean}>}).files ?? [])
      : [];
  const blocked = needsAdmin && !isAdmin;
  const decided = proposal.status !== 'pending';

  function decide(decision: 'approve' | 'reject') {
    setError(null);
    startTransition(async () => {
      const result = await decideProposalAction({
        proposalId: proposal.id,
        decision,
        note: note.trim() || undefined,
        waiverReason: waiver.trim() || undefined
      });
      if (!result.ok) setError(result.error);
    });
  }

  function retryCommit() {
    setError(null);
    startTransition(async () => {
      const result = await retryApprovedPatchAction({proposalId: proposal.id});
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="rounded-lg border border-accent/30 bg-accent/5 p-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent/30 bg-accent/10 text-accent">
          <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">
            {t('proposal.heading', {agent: `@${agentHandle}`})}
          </p>
          <p className="mt-0.5 font-mono text-[11px] uppercase tracking-widest text-faint">
            {t(`actions.${proposal.action}`)}
          </p>
        </div>
        {decided ? (
          <span className="shrink-0 rounded border border-hairline bg-raised px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted">
            {proposal.status === 'approved'
              ? t('proposal.approved', {who: deciderName ?? '—'})
              : proposal.status === 'rejected'
                ? t('proposal.rejected', {who: deciderName ?? '—'})
                : t(`proposal.${proposal.status}`)}
          </span>
        ) : null}
      </div>

      <div className="mt-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-faint">
          {t('proposal.reasoning')}
        </p>
        {/* dir="auto" — the documented DESIGN.md exception. Agent output follows
            the language of the thread, so a bilingual channel mixes both. */}
        <p dir="auto" className="mt-1 whitespace-pre-wrap text-sm text-muted">
          {proposal.reasoning}
        </p>
      </div>

      {patchFiles.length ? (
        <div className="mt-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-faint">
            {t('proposal.patchFiles', {count: patchFiles.length})}
          </p>
          <ul className="mt-1 space-y-0.5">
            {patchFiles.map((file, index) => (
              <li
                key={`${file.path ?? index}`}
                dir="ltr"
                className="flex items-center gap-2 font-mono text-[11px] text-muted"
              >
                <span
                  className={file.remove ? 'text-danger' : 'text-accent'}
                  aria-hidden="true"
                >
                  {file.remove ? '−' : '+'}
                </span>
                <span className="truncate">{file.path}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setShowPayload((v) => !v)}
        className="mt-3 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-faint transition-colors hover:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        aria-expanded={showPayload}
      >
        {showPayload ? (
          <ChevronDown className="h-3 w-3" strokeWidth={1.75} />
        ) : (
          <ChevronRight className="h-3 w-3 rtl:rotate-180" strokeWidth={1.75} />
        )}
        {t('proposal.payload')}
      </button>

      {showPayload ? (
        <pre className="mt-2 overflow-x-auto rounded border border-hairline bg-bg p-3 font-mono text-[11px] leading-relaxed text-muted">
          {JSON.stringify(proposal.payload, null, 2)}
        </pre>
      ) : null}

      {decided && isDeferred && proposal.status === 'approved' ? (
        proposal.commit_sha ? (
          <p className="mt-3 font-mono text-[11px] text-muted">
            {t('proposal.committed', {sha: proposal.commit_sha.slice(0, 7)})}
          </p>
        ) : (
          <div>
            <p dir="auto" className="mt-3 text-sm text-danger">
              {proposal.commit_error
                ? t('proposal.commitFailedWith', {reason: proposal.commit_error})
                : t('proposal.commitPending')}
            </p>
            {proposal.commit_error ? (
              <button
                type="button"
                onClick={retryCommit}
                disabled={pending}
                className="mt-2 rounded border border-hairline bg-raised px-3 py-1.5 text-sm text-muted transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
              >
                {pending ? t('proposal.retryingCommit') : t('proposal.retryCommit')}
              </button>
            ) : null}
          </div>
        )
      ) : null}

      {decided ? (
        proposal.decision_note ? (
          <p dir="auto" className="mt-3 text-sm text-muted">
            {proposal.decision_note}
          </p>
        ) : null
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {takesWaiver ? (
            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-widest text-amber">
                {t('proposal.waiverLabel')}
              </span>
              <textarea
                value={waiver}
                onChange={(e) => setWaiver(e.target.value)}
                rows={2}
                dir="auto"
                disabled={blocked || pending}
                className="rounded border border-amber/30 bg-bg px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-amber focus:outline-none disabled:opacity-50"
              />
              <span className="text-xs text-faint">{t('proposal.waiverHint')}</span>
            </label>
          ) : null}

          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-widest text-faint">
              {t('proposal.noteLabel')}
            </span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              dir="auto"
              disabled={pending}
              className="rounded border border-hairline bg-bg px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-50"
            />
          </label>

          {blocked ? (
            <p className="text-xs text-amber">{t('proposal.adminOnly')}</p>
          ) : null}

          {error ? (
            <p className="text-xs text-danger">{t(`errors.${error}`)}</p>
          ) : null}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => decide('approve')}
              disabled={blocked || pending}
              className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-sm font-semibold text-bg transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5" strokeWidth={2} />
              {pending ? t('proposal.deciding') : t('proposal.approve')}
            </button>
            <button
              type="button"
              onClick={() => decide('reject')}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded border border-hairline bg-raised px-3 py-1.5 text-sm text-muted transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
              {t('proposal.reject')}
            </button>
          </div>
        </div>
      )}

      {proposal.decided_at ? (
        <p className="mt-3 font-mono text-[10px] text-faint">
          <RelativeTime date={proposal.decided_at} />
        </p>
      ) : null}
    </div>
  );
}
