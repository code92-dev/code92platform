import {ShieldCheck} from 'lucide-react';
import {getTranslations} from 'next-intl/server';

import AgentActivityPanel from '@/components/agents/AgentActivityPanel';
import AgentRosterPanel from '@/components/agents/AgentRosterPanel';
import OpenRouterPanel from '@/components/agents/OpenRouterPanel';
import GithubSettingsPanel from '@/components/admin/GithubSettingsPanel';
import MembersTable, {type MemberRow} from '@/components/admin/MembersTable';
import NotificationPreferencesPanel from '@/components/settings/NotificationPreferencesPanel';
import SettingsPreferences from '@/components/settings/SettingsPreferences';
import {
  getAgentRunsAction,
  getAgentsAction,
  getOpenRouterStatusAction
} from '@/lib/actions/agents';
import {getNotificationPreferencesAction} from '@/lib/actions/notifications';
import {requireActiveMember} from '@/lib/auth';
import type {Agent, AgentRun, OpenRouterStatus} from '@/lib/agents';
import type {GithubConnectionStatus} from '@/lib/github';
import {createInsForgeServerClient} from '@/lib/insforge/server';

// The control panel's full surface. Everyone gets language, appearance and
// their account; admins additionally get the panels that used to live at
// /admin, which now redirects here.
//
// Admin data is fetched only for admins — not fetched-then-hidden. The RPC and
// RLS would return nothing to a member anyway, but not asking is the honest
// version and saves two round trips on every member's visit.
export default async function SettingsPage() {
  const {user, member} = await requireActiveMember();
  const [t, tc] = await Promise.all([
    getTranslations('settings'),
    getTranslations('common')
  ]);

  const isAdmin = member.role === 'admin';
  const notificationPreferences = await getNotificationPreferencesAction();

  let members: MemberRow[] = [];
  let githubStatus: GithubConnectionStatus | null = null;
  let openRouterStatus: OpenRouterStatus | null = null;
  let agents: Agent[] = [];
  let runs: AgentRun[] = [];

  if (isAdmin) {
    const insforge = await createInsForgeServerClient();
    const [{data: memberRows}, {data: status}] = await Promise.all([
      insforge.database
        .from('team_members')
        .select('user_id, display_name, role, is_active, created_at')
        .order('created_at', {ascending: true}),
      insforge.database.rpc('github_connection_status')
    ]);
    [openRouterStatus, agents, runs] = await Promise.all([
      getOpenRouterStatusAction(),
      getAgentsAction(),
      // The last few runs only. This panel answers "is the harness alive and
      // what did the last run cost", not "what has it ever done" — and the
      // limit is passed to the query so the rows are never fetched and hidden.
      getAgentRunsAction(5)
    ]);

    members = (memberRows ?? []) as unknown as MemberRow[];
    githubStatus =
      ((Array.isArray(status) ? status[0] : status) as
        | GithubConnectionStatus
        | undefined) ?? null;
  }

  return (
    <section className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('subtitle')}</p>
      </header>

      <SettingsPreferences />

      <NotificationPreferencesPanel preferences={notificationPreferences} />

      <section className="space-y-3">
        <h2 className="text-sm font-medium">{t('account.title')}</h2>
        <dl className="grid gap-4 rounded-lg border border-hairline bg-panel p-4 sm:grid-cols-3">
          <div>
            <dt className="text-[10px] uppercase tracking-widest text-faint">
              {t('account.name')}
            </dt>
            <dd className="mt-1 text-sm">{member.display_name ?? '—'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[10px] uppercase tracking-widest text-faint">
              {t('account.email')}
            </dt>
            <dd dir="ltr" className="mt-1 truncate text-start text-sm">
              {user.email ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-widest text-faint">
              {t('account.role')}
            </dt>
            <dd className="mt-1 text-sm">
              {isAdmin ? t('account.roleAdmin') : t('account.roleMember')}
            </dd>
          </div>
        </dl>
      </section>

      {isAdmin ? (
        <>
          <div className="flex items-center gap-2 border-t border-hairline pt-6">
            <ShieldCheck className="h-4 w-4 text-muted" strokeWidth={1.75} />
            <h2 className="text-sm font-medium">{tc('nav.admin')}</h2>
            <span className="text-xs text-faint">{t('admin.hint')}</span>
          </div>

          <MembersTable members={members} currentUserId={user.id} />
          <GithubSettingsPanel status={githubStatus} />
          <OpenRouterPanel status={openRouterStatus} />
          <AgentRosterPanel agents={agents} />
          <AgentActivityPanel agents={agents} runs={runs} />
        </>
      ) : null}
    </section>
  );
}
