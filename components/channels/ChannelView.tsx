import {notFound} from 'next/navigation';
import {Hash, MessageSquare, Package} from 'lucide-react';
import {getTranslations} from 'next-intl/server';

import MessageStream, {
  type MessageAuthor
} from '@/components/channels/MessageStream';
import {requireActiveMember} from '@/lib/auth';
import {getChannelViewAction} from '@/lib/actions/channels';
import {channelLabel} from '@/lib/channels';
import {createInsForgeServerClient} from '@/lib/insforge/server';

// One channel, rendered. Extracted from the /channels/[id] page so that
// /channels can show General without redirecting to it.
//
// The redirect it replaces was not a style preference. A redirect thrown while
// a Server Component renders comes back to the client as a bare URL string
// rather than flight data, and Next answers that by forcing a full-page
// navigation (navigate-reducer.js:222 -> handleExternalUrl). That sets
// pushRef.mpaNavigation, and app-router's Router throws out of its own render
// before reaching its remaining hooks — a documented rules-of-hooks violation
// in Next's own code. The next render has more hooks than the last and React
// tears the tree down with "Rendered more hooks than during the previous
// render". Rendering the channel here instead means the RSC response is an
// ordinary tree and none of that machinery is involved.
export default async function ChannelView({
  channelId,
  locale
}: {
  channelId: string;
  locale: string;
}) {
  const {user, member} = await requireActiveMember();
  const t = await getTranslations('channels');

  const view = await getChannelViewAction(channelId);
  if (!view.channel) notFound();

  // Everyone who appears in this channel — humans for their names, agents for
  // their handles. One query rather than a lookup per message.
  const insforge = await createInsForgeServerClient();
  // Everyone, including archived agents and deactivated members: this list also
  // resolves the author of every historical message, and a name that stops
  // resolving turns their past messages into "unknown".
  //
  // Who can be *reached* is a narrower question, answered by `mentionable`.
  // messages_queue_agent_runs() wakes an agent only when it is enabled and not
  // archived, so offering any other agent in autocomplete inserts a mention
  // that silently resolves to nobody.
  const [{data: members}, {data: agents}] = await Promise.all([
    insforge.database.from('team_members').select('user_id, display_name, kind, is_active'),
    insforge.database.from('agents').select('user_id, handle, enabled, archived_at')
  ]);

  const agentByUser = new Map(
    (
      (agents ?? []) as Array<{
        user_id: string;
        handle: string;
        enabled: boolean;
        archived_at: string | null;
      }>
    ).map((a) => [a.user_id, a])
  );

  const authors: MessageAuthor[] = (
    (members ?? []) as Array<{
      user_id: string;
      display_name: string;
      kind: 'human' | 'agent';
      is_active: boolean;
    }>
  ).map((m) => {
    const agent = agentByUser.get(m.user_id);
    return {
      user_id: m.user_id,
      display_name: m.display_name,
      kind: m.kind,
      handle: agent?.handle ?? null,
      mentionable: agent
        ? m.is_active && agent.enabled && agent.archived_at === null
        : m.is_active
    };
  });

  const isProduct = view.channel.kind === 'product';
  const isDm = view.channel.kind === 'dm';
  // The stored name of a DM is both participants; each reader is shown the
  // other one, resolved from the same team_members list already loaded above.
  const nameByUser = new Map(authors.map((a) => [a.user_id, a.display_name]));
  const title = channelLabel(view.channel, locale, {
    userId: user.id,
    nameFor: (userId: string) => nameByUser.get(userId)
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2.5 border-b border-hairline px-4 py-3 md:px-6">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-hairline bg-raised text-faint">
          {isProduct ? (
            <Package className="h-3.5 w-3.5" strokeWidth={1.75} />
          ) : isDm ? (
            <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.75} />
          ) : (
            <Hash className="h-3.5 w-3.5" strokeWidth={1.75} />
          )}
        </span>
        <div className="min-w-0">
          <h1 dir="auto" className="truncate text-sm font-semibold text-ink">
            {title}
          </h1>
          {view.channel.topic ? (
            <p dir="auto" className="truncate text-xs text-faint">
              {view.channel.topic}
            </p>
          ) : null}
        </div>
        {view.channel.archived_at ? (
          <span className="ms-auto shrink-0 rounded border border-hairline bg-raised px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-faint">
            {t('channel.archived')}
          </span>
        ) : null}
      </header>

      <MessageStream
        channelId={view.channel.id}
        initialMessages={view.messages}
        initialProposals={view.proposals}
        initialAttachments={view.attachments}
        authors={authors}
        currentUserId={member.user_id}
        isAdmin={member.role === 'admin'}
      />
    </div>
  );
}
