import {MessagesSquare} from 'lucide-react';
import {getTranslations} from 'next-intl/server';

import ChannelView from '@/components/channels/ChannelView';
import {getChannelsAction} from '@/lib/actions/channels';
import {DEFAULT_CHANNEL_SLUG} from '@/lib/channels';

export default async function ChannelsIndexPage({
  params
}: {
  params: Promise<{locale: string}>;
}) {
  const {locale} = await params;
  const t = await getTranslations('channels');

  // Opening /channels with no channel named used to land on an empty state
  // telling the reader to pick one, which is a question the product can answer
  // itself: General is the room that exists for everything without a home, and
  // it is seeded by the channels migration.
  //
  // Rendered here rather than redirected to. See ChannelView's header for why a
  // render-time redirect is the wrong tool — in short, it makes Next force a
  // full-page navigation and crash its own Router in development.
  //
  // The list is already filtered to unarchived channels this reader may see, so
  // finding the slug in it is also the permission check. If General has been
  // archived, or a deployment somehow has none, the empty state below is still
  // the right answer.
  const channels = await getChannelsAction();
  const general = channels.find(
    (channel) => channel.slug === DEFAULT_CHANNEL_SLUG
  );
  if (general) return <ChannelView channelId={general.id} locale={locale} />;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-raised text-faint">
        <MessagesSquare className="h-5 w-5" strokeWidth={1.75} />
      </span>
      <p className="text-sm text-muted">{t('empty.pickOne')}</p>
      <p className="max-w-sm text-xs text-faint">{t('subtitle')}</p>
    </div>
  );
}
