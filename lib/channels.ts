// Shared channel vocabulary. No 'use server', so client components can import
// the constants and types directly.
//
// Mirrors migrations/20260825090000_add-channels.sql.

export const CHANNEL_KINDS = ['standing', 'product', 'dm'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const MESSAGE_KINDS = ['human', 'agent', 'system'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const NOTIFICATION_LEVELS = ['all', 'mentions', 'none'] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export const PROMOTION_TYPES = [
  'status_update',
  'product_task',
  'knowledge_item',
  'lifecycle_phase'
] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];

export const MESSAGE_PAGE_SIZE = 60;
export const MAX_MESSAGE_LENGTH = 20000;

// The channel /channels lands on when no channel is named. Seeded by
// 20260825090000_add-channels.sql; the slug is UNIQUE, so this identifies
// exactly one row.
export const DEFAULT_CHANNEL_SLUG = 'general';

// Attaching files to a message. Same ceilings as every other upload surface —
// mirrored in attach_files_to_message(), which is what actually enforces them.
export const MAX_MESSAGE_ATTACHMENTS = 8;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type Channel = {
  id: string;
  slug: string;
  name: string;
  name_ar: string | null;
  topic: string | null;
  kind: ChannelKind;
  product_id: string | null;
  // True only for the room created with the product, which follows its name.
  is_primary: boolean;
  // The channel this one sits under. Fixed at creation.
  parent_id: string | null;
  // The two participants of a direct message, in id order, and NULL on every
  // other kind. These are the access control list: see
  // migrations/20260825098000_add-direct-messages.sql.
  dm_user_a: string | null;
  dm_user_b: string | null;
  archived_at: string | null;
  created_by: string | null;
  created_at: string;
};

export type ChannelMembership = {
  channel_id: string;
  user_id: string;
  notification_level: NotificationLevel;
  last_read_at: string;
};

export type Message = {
  id: string;
  channel_id: string;
  parent_id: string | null;
  author_id: string | null;
  body: string;
  kind: MessageKind;
  promoted_to_type: PromotionType | null;
  promoted_to_id: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
};

// A file attached to a message. This is a knowledge_items row, not a copy of
// one: a channel attachment IS a knowledge source that arrived through a
// conversation, so there is one record and one object in storage. `id` is the
// knowledge item's id and links straight to its page.
export type MessageAttachment = {
  id: string;
  source_message_id: string;
  title: string;
  file_name: string;
  file_key: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  created_at: string;
};

// The channel name shown to a reader. Bound channels take the product's name,
// which the trigger keeps in sync, so there is nothing locale-specific to do
// for them; standing channels may carry a translated name.
//
// A direct message is the exception: its name is the pair, but what each of the
// two people should see is the OTHER one. That cannot be a stored column, so
// pass the viewer and a name lookup and the label is resolved per reader.
export function channelLabel(
  channel: Channel,
  locale: string,
  viewer?: {userId: string; nameFor: (userId: string) => string | undefined}
): string {
  if (channel.kind === 'dm' && viewer) {
    const other = dmPeerId(channel, viewer.userId);
    const name = other ? viewer.nameFor(other) : undefined;
    if (name) return name;
  }
  if (locale === 'ar' && channel.name_ar) return channel.name_ar;
  return channel.name;
}

// The participant who is not the viewer. Null when the channel is not a DM, or
// when the viewer is not in it — which the database makes unreachable, since
// such a channel is not selectable in the first place.
export function dmPeerId(channel: Channel, viewerId: string): string | null {
  if (channel.kind !== 'dm') return null;
  if (channel.dm_user_a === viewerId) return channel.dm_user_b;
  if (channel.dm_user_b === viewerId) return channel.dm_user_a;
  return null;
}

// Slug proposed for a new standing channel. The database CHECK is the
// authority; this exists so the form can show what will be saved.
export function toChannelSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

// What a person must actually type after @ for the server to resolve them.
//
// Two different rules, both living in the triggers: messages_fan_out() matches a
// human by lower(replace(display_name, ' ', '')), and messages_queue_agent_runs()
// matches an agent by its handle. Autocomplete has to reproduce both or it will
// helpfully insert a mention that silently resolves to nobody.
//
// Returns null when the name cannot produce a token the extraction regexp will
// even see — an Arabic display name has no ASCII to match, so those members are
// not offered rather than being offered uselessly.
export const MENTION_TOKEN_PATTERN = /^[A-Za-z0-9._-]{2,40}$/;

export function mentionToken(author: {
  kind: 'human' | 'agent';
  display_name: string;
  handle: string | null;
}): string | null {
  const token =
    author.kind === 'agent'
      ? (author.handle ?? '')
      : author.display_name.toLowerCase().replace(/ /g, '');
  return MENTION_TOKEN_PATTERN.test(token) ? token : null;
}

// @handle tokens in a message body. Mirrors the regexp in messages_fan_out()
// and messages_queue_agent_runs() — the server extraction is authoritative, and
// this is only used to highlight mentions as you type.
export function extractHandles(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/@([A-Za-z0-9._-]{2,40})/g)) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

// The handle a display name resolves to, matching
// lower(replace(display_name, ' ', '')) in the fan-out trigger.
export function memberHandle(displayName: string): string {
  return displayName.toLowerCase().replace(/\s+/g, '');
}
