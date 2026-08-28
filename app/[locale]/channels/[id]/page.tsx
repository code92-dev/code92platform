import ChannelView from '@/components/channels/ChannelView';

export default async function ChannelPage({
  params
}: {
  params: Promise<{locale: string; id: string}>;
}) {
  const {locale, id} = await params;
  return <ChannelView channelId={id} locale={locale} />;
}
