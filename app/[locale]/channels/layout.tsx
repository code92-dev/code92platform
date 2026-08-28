import {getTranslations} from 'next-intl/server';

import ChannelRail from '@/components/channels/ChannelRail';
import {requireActiveMember} from '@/lib/auth';
import {getChannelsAction, getDmPeersAction} from '@/lib/actions/channels';
import {DEFAULT_CHANNEL_SLUG} from '@/lib/channels';

// The channel rail is a layout rather than part of each page so that moving
// between channels does not re-fetch and re-render the list. The tree itself is
// a client component: hovering a channel to add one under it needs interaction,
// and the shape is cheap to build from the flat list the server already has.
export default async function ChannelsLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{locale: string}>;
}) {
  const {locale} = await params;
  const {user} = await requireActiveMember();
  const t = await getTranslations('channels');
  // The peer list is what labels a DM: its name column holds both participants,
  // and each reader needs to see the other one.
  const [channels, peers] = await Promise.all([
    getChannelsAction(),
    getDmPeersAction()
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside
        aria-label={t('title')}
        className="shrink-0 border-b border-hairline bg-panel md:w-64 md:border-b-0 md:border-e"
      >
        <ChannelRail
          channels={channels}
          peers={peers}
          viewerId={user.id}
          locale={locale}
          defaultChannelId={
            channels.find((c) => c.slug === DEFAULT_CHANNEL_SLUG)?.id ?? null
          }
        />
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
