'use client';

import {useMemo, useState, useTransition} from 'react';
import {Hash, MessageSquare, Package, Plus, X} from 'lucide-react';
import {useTranslations} from 'next-intl';

import {Link, usePathname, useRouter} from '@/i18n/navigation';
import {
  createChannelAction,
  type DmPeer,
  openDirectMessageAction,
  removeChannelAction
} from '@/lib/actions/channels';
import {
  channelLabel,
  dmPeerId,
  toChannelSlug,
  type Channel
} from '@/lib/channels';

// The channel tree.
//
// parent_id is a plain adjacency list in the database, so the shape lives here:
// group once by parent, then walk. Depth is whatever the team has created —
// there is no fixed limit — and indentation is capped so a deep branch does not
// walk off the edge of a 256px rail.

const INDENT_STEP = 12;
const MAX_INDENT = 48;

export default function ChannelRail({
  channels,
  peers,
  viewerId,
  locale,
  defaultChannelId
}: {
  channels: Channel[];
  peers: DmPeer[];
  viewerId: string;
  locale: string;
  // The channel /channels renders when no id is in the path. Needed here
  // because that route shows General without the URL naming it, so an exact
  // pathname match would leave nothing highlighted.
  defaultChannelId: string | null;
}) {
  const t = useTranslations('channels');
  const router = useRouter();
  const pathname = usePathname();

  // Both spellings of "this channel is open": /channels/<id>, and bare
  // /channels when this is the one that route renders.
  const isActive = (channelId: string) =>
    pathname === `/channels/${channelId}` ||
    (pathname === '/channels' && channelId === defaultChannelId);

  // undefined: not adding. null: adding a top-level channel. string: adding
  // under that channel id.
  const [addingUnder, setAddingUnder] = useState<string | null | undefined>(
    undefined
  );
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<'deleted' | 'archived' | null>(null);
  const [pickingPerson, setPickingPerson] = useState(false);
  const [pending, startTransition] = useTransition();

  const nameByUser = useMemo(
    () => new Map(peers.map((peer) => [peer.userId, peer.displayName])),
    [peers]
  );
  const viewer = {
    userId: viewerId,
    nameFor: (id: string) => nameByUser.get(id)
  };

  const byParent = new Map<string, Channel[]>();
  for (const channel of channels) {
    const key = channel.parent_id ?? '';
    const list = byParent.get(key);
    if (list) list.push(channel);
    else byParent.set(key, [channel]);
  }

  // A product's own room leads its group; everything else goes alphabetically.
  const order = (a: Channel, b: Channel) => {
    if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
    if (a.product_id !== b.product_id) {
      return (a.product_id ?? '').localeCompare(b.product_id ?? '');
    }
    return a.slug.localeCompare(b.slug);
  };

  const roots = (byParent.get('') ?? []).slice().sort(order);
  const standingRoots = roots.filter((c) => c.kind === 'standing');
  const productRoots = roots.filter((c) => c.kind === 'product');
  // Sorted by the name actually on screen — the other person's — rather than by
  // the slug, which is a pair of ids and sorts meaninglessly.
  const dmRoots = roots
    .filter((c) => c.kind === 'dm')
    .sort((a, b) =>
      channelLabel(a, locale, viewer).localeCompare(
        channelLabel(b, locale, viewer),
        locale
      )
    );

  // Someone you already have a conversation with is not offered again: the
  // existing row in the list is the way back to it.
  const openWith = new Set(
    dmRoots.map((c) => dmPeerId(c, viewerId)).filter(Boolean) as string[]
  );
  const available = peers.filter(
    (peer) => peer.userId !== viewerId && !openWith.has(peer.userId)
  );

  function startDm(userId: string) {
    setError(null);
    setPickingPerson(false);
    startTransition(async () => {
      const result = await openDirectMessageAction(userId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/channels/${result.channelId}`);
    });
  }

  function submit(parentId: string | null) {
    const trimmed = name.trim();
    if (!toChannelSlug(trimmed)) {
      setError('invalid_slug');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createChannelAction({
        name: trimmed,
        parentId: parentId ?? undefined
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName('');
      setAddingUnder(undefined);
      if (result.channelId) router.push(`/channels/${result.channelId}`);
      else router.refresh();
    });
  }

  function remove(channel: Channel) {
    // The confirm cannot promise which of the two will happen — only the server
    // knows whether the channel is empty — so it states the rule instead of
    // guessing, and the outcome is reported afterwards.
    if (!window.confirm(t('remove.confirm', {name: channelLabel(channel, locale)}))) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await removeChannelAction(channel.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(result.deleted ? 'deleted' : 'archived');
      // Standing in a room that has just gone is a dead end. When it was being
      // shown at bare /channels there is nowhere to push to, so re-render in
      // place and let that route fall through to the next default.
      if (!isActive(channel.id)) router.refresh();
      else if (pathname === '/channels') router.refresh();
      else router.push('/channels');
    });
  }

  function AddForm({parentId}: {parentId: string | null}) {
    return (
      <div className="px-2 py-1.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit(parentId);
            }
            if (e.key === 'Escape') {
              setAddingUnder(undefined);
              setError(null);
            }
          }}
          onBlur={() => {
            // Losing focus with nothing typed just closes it; a half-typed name
            // is kept so a mis-click does not throw the text away.
            if (!name.trim()) {
              setAddingUnder(undefined);
              setError(null);
            }
          }}
          autoFocus
          dir="auto"
          placeholder={t('create.namePlaceholder')}
          disabled={pending}
          className="w-full rounded border border-accent/40 bg-bg px-2 py-1 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-50"
        />
        {error ? (
          <p className="mt-1 text-[11px] text-danger">{t(`errors.${error}`)}</p>
        ) : null}
      </div>
    );
  }

  // Deliberately not the Row above: a DM has no + (nothing nests under one) and
  // no x (removing it is refused for both people), so it would be a row of
  // controls that only ever say no.
  function DmRow({channel}: {channel: Channel}) {
    const active = isActive(channel.id);
    return (
      <li>
        <Link
          href={`/channels/${channel.id}`}
          className={`flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors ${
            active ? 'bg-raised text-ink' : 'text-muted hover:bg-raised hover:text-ink'
          }`}
        >
          <MessageSquare className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          <span className="truncate" dir="auto">
            {channelLabel(channel, locale, viewer)}
          </span>
        </Link>
      </li>
    );
  }

  function Row({channel, depth}: {channel: Channel; depth: number}) {
    const children = (byParent.get(channel.id) ?? []).slice().sort(order);
    const active = isActive(channel.id);
    const indent = Math.min(depth * INDENT_STEP, MAX_INDENT);

    return (
      <li>
        <div
          className={`group flex items-center gap-1 rounded transition-colors ${
            active ? 'bg-raised' : 'hover:bg-raised'
          }`}
          style={{paddingInlineStart: indent}}
        >
          <Link
            href={`/channels/${channel.id}`}
            className={`flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm transition-colors ${
              active ? 'text-ink' : 'text-muted group-hover:text-ink'
            }`}
          >
            {channel.kind === 'product' && channel.is_primary ? (
              <Package className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            ) : (
              <Hash className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            )}
            <span className="truncate">{channelLabel(channel, locale)}</span>
          </Link>

          {/* Appears on hover, and on keyboard focus — otherwise the only way to
              nest a channel would be with a mouse. */}
          <button
            type="button"
            onClick={() => {
              setName('');
              setError(null);
              setAddingUnder(channel.id);
            }}
            aria-label={t('create.subchannelOf', {
              name: channelLabel(channel, locale)
            })}
            title={t('create.subchannel')}
            className="me-1 shrink-0 rounded p-1 text-faint opacity-0 transition-opacity hover:text-accent focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent group-hover:opacity-100"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
          </button>

          {/* A product's own room is maintained by the product and closes with
              it, so it has no remove control at all rather than one that only
              ever refuses. */}
          {channel.is_primary ? null : (
            <button
              type="button"
              onClick={() => remove(channel)}
              disabled={pending}
              aria-label={t('remove.of', {name: channelLabel(channel, locale)})}
              title={t('remove.label')}
              className="me-1 shrink-0 rounded p-1 text-faint opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent group-hover:opacity-100 disabled:opacity-40"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          )}
        </div>

        {addingUnder === channel.id ? (
          <div style={{paddingInlineStart: Math.min(indent + INDENT_STEP, MAX_INDENT)}}>
            <AddForm parentId={channel.id} />
          </div>
        ) : null}

        {children.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {children.map((child) => (
              <Row key={child.id} channel={child} depth={depth + 1} />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <nav
      aria-label={t('title')}
      className="max-h-56 overflow-y-auto px-3 py-4 md:max-h-none"
    >
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-faint">
          {t('sections.standing')}
        </p>
        <button
          type="button"
          onClick={() => {
            setName('');
            setError(null);
            setAddingUnder(null);
          }}
          aria-label={t('create.button')}
          title={t('create.button')}
          className="rounded p-1 text-faint transition-colors hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      {addingUnder === null ? <AddForm parentId={null} /> : null}

      {notice ? (
        <p className="px-2 pb-2 text-[11px] text-faint">
          {t(`remove.${notice}`)}
        </p>
      ) : null}

      {error && addingUnder === undefined ? (
        <p className="px-2 pb-2 text-[11px] text-danger">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      {standingRoots.length > 0 ? (
        <ul className="flex flex-col gap-0.5 pb-4">
          {standingRoots.map((channel) => (
            <Row key={channel.id} channel={channel} depth={0} />
          ))}
        </ul>
      ) : null}

      {productRoots.length > 0 ? (
        <>
          <p className="px-2 pb-2 font-mono text-[10px] uppercase tracking-widest text-faint">
            {t('sections.products')}
          </p>
          <ul className="flex flex-col gap-0.5">
            {productRoots.map((channel) => (
              <Row key={channel.id} channel={channel} depth={0} />
            ))}
          </ul>
        </>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-2 px-2 pb-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-faint">
          {t('sections.direct')}
        </p>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setPickingPerson((open) => !open);
          }}
          aria-label={t('dm.start')}
          title={t('dm.start')}
          aria-expanded={pickingPerson}
          className="rounded p-1 text-faint transition-colors hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      {pickingPerson ? (
        <div className="pb-2">
          {available.length === 0 ? (
            <p className="px-2 py-1.5 text-[11px] text-faint">
              {t('dm.nobodyLeft')}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {available.map((peer) => (
                <li key={peer.userId}>
                  <button
                    type="button"
                    onClick={() => startDm(peer.userId)}
                    disabled={pending}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm text-muted transition-colors hover:bg-raised hover:text-ink disabled:opacity-50"
                  >
                    <MessageSquare
                      className="h-3.5 w-3.5 shrink-0 text-faint"
                      strokeWidth={1.75}
                    />
                    <span className="truncate" dir="auto">
                      {peer.displayName}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {dmRoots.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {dmRoots.map((channel) => (
            <DmRow key={channel.id} channel={channel} />
          ))}
        </ul>
      ) : pickingPerson ? null : (
        <p className="px-2 pb-2 text-[11px] text-faint">{t('dm.none')}</p>
      )}

      {channels.length === 0 ? (
        <p className="px-2 py-6 text-sm text-faint">{t('empty.noChannels')}</p>
      ) : null}
    </nav>
  );
}
