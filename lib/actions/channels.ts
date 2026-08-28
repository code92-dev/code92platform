'use server';

import {revalidatePath} from 'next/cache';
import {z} from 'zod';

import {getOwnMembership, getSessionUser} from '@/lib/auth';
import {createInsForgeServerClient} from '@/lib/insforge/server';
import {
  MAX_MESSAGE_ATTACHMENTS,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  MAX_MESSAGE_LENGTH,
  MESSAGE_PAGE_SIZE,
  NOTIFICATION_LEVELS,
  toChannelSlug,
  type Channel,
  type Message,
  type MessageAttachment
} from '@/lib/channels';
import {isAllowedAttachmentType} from '@/lib/attachments';
import type {AgentProposal} from '@/lib/agents';

export type ChannelActionResult =
  | {ok: true; channelId?: string; messageId?: string}
  | {ok: false; error: string};

const uuid = z.string().uuid();

async function requireActiveCaller() {
  const [user, member] = await Promise.all([
    getSessionUser(),
    getOwnMembership()
  ]);
  if (!user || !member?.is_active) return null;
  return {user, member};
}

const CHANNEL_COLUMNS =
  'id, slug, name, name_ar, topic, kind, product_id, is_primary, parent_id, dm_user_a, dm_user_b, archived_at, created_by, created_at';
const MESSAGE_COLUMNS =
  'id, channel_id, parent_id, author_id, body, kind, promoted_to_type, promoted_to_id, edited_at, deleted_at, created_at';
// A channel attachment is a knowledge_items row with origin='channel'. Only the
// columns the message bubble renders — content and url are never set on one.
const ATTACHMENT_COLUMNS =
  'id, source_message_id, title, file_name, file_key, mime_type, size_bytes, status, created_at';
const PROPOSAL_COLUMNS =
  'id, message_id, channel_id, agent_id, run_id, product_id, action, payload, reasoning, status, decided_by, decided_at, decision_note, result_type, result_id, created_at';

export async function getChannelsAction(): Promise<Channel[]> {
  const caller = await requireActiveCaller();
  if (!caller) return [];

  const insforge = await createInsForgeServerClient();
  const {data} = await insforge.database
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .is('archived_at', null)
    .order('kind', {ascending: true})
    .order('slug', {ascending: true});

  return (data ?? []) as unknown as Channel[];
}

export type ChannelView = {
  channel: Channel | null;
  messages: Message[];
  proposals: AgentProposal[];
  attachments: MessageAttachment[];
  membership: {notification_level: string; last_read_at: string} | null;
};

// One channel and everything needed to render it. Proposals come back alongside
// the messages rather than being fetched per card: a channel with thirty
// messages would otherwise be thirty round trips.
export async function getChannelViewAction(
  channelId: string
): Promise<ChannelView> {
  const caller = await requireActiveCaller();
  const empty: ChannelView = {
    channel: null,
    messages: [],
    proposals: [],
    attachments: [],
    membership: null
  };
  if (!caller || !uuid.safeParse(channelId).success) return empty;

  const insforge = await createInsForgeServerClient();

  const [{data: channels}, {data: messages}, {data: proposals}, {data: membership}] =
    await Promise.all([
      insforge.database
        .from('channels')
        .select(CHANNEL_COLUMNS)
        .eq('id', channelId)
        .limit(1),
      insforge.database
        .from('messages')
        .select(MESSAGE_COLUMNS)
        .eq('channel_id', channelId)
        .order('created_at', {ascending: false})
        .limit(MESSAGE_PAGE_SIZE),
      insforge.database
        .from('agent_proposals')
        .select(PROPOSAL_COLUMNS)
        .eq('channel_id', channelId)
        .order('created_at', {ascending: false})
        .limit(MESSAGE_PAGE_SIZE),
      insforge.database
        .from('channel_members')
        .select('notification_level, last_read_at')
        .eq('channel_id', channelId)
        .eq('user_id', caller.user.id)
        .limit(1)
    ]);

  // Fetched newest-first so the LIMIT takes the most recent page, then
  // reversed for display: a chat reads oldest at the top.
  const page = ((messages ?? []) as unknown as Message[]).slice().reverse();

  // A second round trip rather than part of the batch above, because it needs
  // the ids the batch returns. knowledge_items carries no channel_id — an
  // attachment is bound to its message, not to the room — so the page of
  // messages is what scopes this. Skipped entirely for an empty channel.
  const messageIds = page.map((message) => message.id);
  const {data: attachments} = messageIds.length
    ? await insforge.database
        .from('knowledge_items')
        .select(ATTACHMENT_COLUMNS)
        .in('source_message_id', messageIds)
        .is('archived_at', null)
        .order('created_at', {ascending: true})
        .limit(messageIds.length * MAX_MESSAGE_ATTACHMENTS)
    : {data: []};

  return {
    channel: ((channels ?? [])[0] ?? null) as unknown as Channel | null,
    messages: page,
    proposals: (proposals ?? []) as unknown as AgentProposal[],
    attachments: (attachments ?? []) as unknown as MessageAttachment[],
    membership: ((membership ?? [])[0] ?? null) as ChannelView['membership']
  };
}

const postSchema = z.object({
  channelId: uuid,
  body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  parentId: uuid.nullable().optional()
});

export async function postMessageAction(
  input: z.infer<typeof postSchema>
): Promise<ChannelActionResult> {
  const caller = await requireActiveCaller();
  if (!caller) return {ok: false, error: 'forbidden'};

  const parsed = postSchema.safeParse(input);
  if (!parsed.success) return {ok: false, error: 'invalid'};

  const insforge = await createInsForgeServerClient();
  const {data, error} = await insforge.database
    .from('messages')
    .insert([
      {
        channel_id: parsed.data.channelId,
        parent_id: parsed.data.parentId ?? null,
        author_id: caller.user.id,
        body: parsed.data.body,
        kind: 'human'
      }
    ])
    .select('id');

  if (error) return {ok: false, error: error.message};

  const messageId = data?.[0]?.id as string | undefined;
  if (messageId) await pingQueuedAgentRuns(insforge, messageId);

  revalidatePath('/[locale]/channels/[id]', 'page');
  // Returned so the composer can attach files to the message it just posted.
  // Attachments cannot ride along with the insert: they are knowledge_items
  // rows that have to name a message id that does not exist until now.
  return {ok: true, messageId};
}

const deleteMessageSchema = z.object({messageId: uuid});

// Soft delete, because the schema is built for it: messages.deleted_at exists so
// replies beneath a removed message keep their parent and the record of who said
// what survives. There is no DELETE grant on the table at all — deleted_at is
// the only removal path, and the stream renders a tombstone in its place.
//
// Authorship is enforced by RLS ("author edits own message", which also pins
// kind='human'), so a member cannot delete someone else's message or erase an
// agent's reply by calling this with a borrowed id. The check below is the same
// answer arrived at early, so the caller gets 'forbidden' rather than a silent
// no-op.
export async function deleteMessageAction(
  input: z.infer<typeof deleteMessageSchema>
): Promise<ChannelActionResult> {
  const caller = await requireActiveCaller();
  if (!caller) return {ok: false, error: 'forbidden'};

  const parsed = deleteMessageSchema.safeParse(input);
  if (!parsed.success) return {ok: false, error: 'invalid'};

  const insforge = await createInsForgeServerClient();
  const {data, error} = await insforge.database
    .from('messages')
    .update({deleted_at: new Date().toISOString()})
    .eq('id', parsed.data.messageId)
    .eq('author_id', caller.user.id)
    .is('deleted_at', null)
    .select('id');

  if (error) return {ok: false, error: error.message};
  // No rows means the message is not this member's, or was already deleted.
  // Both are 'forbidden' from here; distinguishing them would tell a caller
  // whether a message id they do not own exists.
  if (!data?.length) return {ok: false, error: 'forbidden'};

  revalidatePath('/[locale]/channels/[id]', 'page');
  return {ok: true};
}

const attachmentSchema = z.object({
  url: z.string().url().max(2000),
  key: z.string().trim().min(1).max(1000),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z
    .string()
    .max(255)
    .refine(isAllowedAttachmentType, {message: 'unsupported file type'}),
  sizeBytes: z.number().int().positive().max(MAX_MESSAGE_ATTACHMENT_BYTES)
});

const attachSchema = z.object({
  messageId: uuid,
  files: z.array(attachmentSchema).min(1).max(MAX_MESSAGE_ATTACHMENTS)
});

// Files attached in a channel are stored in the knowledge base, which is the
// whole point rather than a side effect: there is no separate attachments table,
// and the knowledge item IS the attachment.
//
// Routed through the attach_files_to_message RPC rather than inserted here.
// origin and source_message_id are outside the column-level INSERT grant on
// knowledge_items — deliberately, for the same reason the lifecycle mirror keeps
// them out — so a client that could set them could forge an item claiming to
// have come from a conversation it was never in. The function derives both from
// the message id, and re-checks the author and the file type against what it
// was handed rather than trusting either.
export async function attachFilesToMessageAction(
  input: z.infer<typeof attachSchema>
): Promise<ChannelActionResult> {
  const caller = await requireActiveCaller();
  if (!caller) return {ok: false, error: 'forbidden'};

  const parsed = attachSchema.safeParse(input);
  if (!parsed.success) return {ok: false, error: 'invalid'};

  const insforge = await createInsForgeServerClient();
  const {error} = await insforge.database.rpc('attach_files_to_message', {
    p_message_id: parsed.data.messageId,
    // snake_case because the function reads these keys straight out of the
    // JSON, and the payload it stores is the row.
    p_files: parsed.data.files.map((file) => ({
      file_url: file.url,
      file_key: file.key,
      file_name: file.fileName,
      mime_type: file.mimeType,
      size_bytes: file.sizeBytes
    }))
  });

  // The RPC raises for every refusal — not a member, not the author, deleted
  // message, unsupported type. Its message is more accurate than anything this
  // layer could infer.
  if (error) return {ok: false, error: error.message};

  revalidatePath('/[locale]/channels/[id]', 'page');
  revalidatePath('/[locale]/knowledge', 'page');
  return {ok: true};
}

// The insert trigger queues a pending agent_runs row for every agent mentioned.
// This wakes the function immediately so a reply arrives in seconds rather than
// on the next five-minute tick.
//
// The lookup is awaited but the invocations are NOT. Each invocation runs the
// agent's entire OpenRouter call, and awaiting those held the post open until the
// reply was ready — so the poster's own message did not appear until the answer
// did, and the channel read as a form rather than a conversation. Letting them
// run on means the message lands immediately and the reply arrives on a poll.
//
// The client is passed in rather than built here. Creating one reads cookies(),
// which is only valid while the request is open; doing that after this function
// returns would throw into the catch below and kill the ping silently, leaving
// replies to wait for the five-minute tick with nothing to show why.
//
// Failures are deliberately swallowed: agent-tick drains the same queue, so a
// failed ping costs latency, never the reply. Surfacing it would turn a
// successful post into an error the poster cannot act on.
async function pingQueuedAgentRuns(
  insforge: Awaited<ReturnType<typeof createInsForgeServerClient>>,
  messageId: string
): Promise<void> {
  try {
    const {data: runs} = await insforge.database
      .from('agent_runs')
      .select('id')
      .eq('trigger_message_id', messageId)
      .eq('status', 'pending');

    for (const run of (runs ?? []) as Array<{id: string}>) {
      void insforge.functions
        .invoke('thread-agent', {
          method: 'POST',
          body: {action: 'run', run_id: run.id}
        })
        // Nothing awaits this, so it must never reject.
        .catch(() => undefined);
    }
  } catch {
    // agent-tick will pick these up.
  }
}

const createChannelSchema = z.object({
  name: z.string().trim().min(1).max(80),
  topic: z.string().trim().max(500).optional(),
  // Present for a room opened against a product. The channel is bound but not
  // primary: it shows under the product and gives an agent the product's
  // context, while the auto-created channel stays the one that follows the
  // product's name.
  productId: uuid.optional(),
  // Present for a subchannel. Binding is inherited from the parent by a trigger,
  // so a subchannel never needs — and is never trusted with — a productId.
  parentId: uuid.optional()
});

export async function createChannelAction(
  input: z.infer<typeof createChannelSchema>
): Promise<ChannelActionResult> {
  const caller = await requireActiveCaller();
  if (!caller) return {ok: false, error: 'forbidden'};

  const parsed = createChannelSchema.safeParse(input);
  if (!parsed.success) return {ok: false, error: 'invalid'};

  const slug = toChannelSlug(parsed.data.name);
  if (!slug) return {ok: false, error: 'invalid_slug'};

  // A parent decides everything about binding, so productId is ignored when one
  // is given. channels_inherit_from_parent() overwrites kind and product_id
  // anyway; sending our guess as well would just be a second, wrong opinion.
  const parentId = parsed.data.parentId;
  const bound = parentId === undefined && parsed.data.productId !== undefined;

  const insforge = await createInsForgeServerClient();
  const {data, error} = await insforge.database
    .from('channels')
    .insert([
      {
        slug,
        name: parsed.data.name,
        topic: parsed.data.topic || null,
        kind: bound ? 'product' : 'standing',
        product_id: bound ? parsed.data.productId : null,
        parent_id: parentId ?? null,
        created_by: caller.user.id
      }
    ])
    .select('id');

  if (error) return {ok: false, error: mapChannelError(error)};

  revalidatePath('/[locale]/channels/[id]', 'page');
  if (bound) revalidatePath('/[locale]/products', 'page');
  return {ok: true, channelId: data?.[0]?.id as string | undefined};
}

// The one failure a person can fix themselves is a name that normalises to a
// slug already taken — every channel slug is unique across the whole workspace,
// product rooms included.
export type OpenDmResult =
  | {ok: true; channelId: string}
  | {ok: false; error: string};

// Opening a DM is a single RPC because the row it writes is one a client is not
// allowed to write: dm_user_a/dm_user_b carry no INSERT grant, and the channels
// INSERT policy still pins kind = 'standing'. open_dm() is idempotent, so this
// doubles as "go to my conversation with this person".
export async function openDirectMessageAction(
  otherUserId: string
): Promise<OpenDmResult> {
  const caller = await requireActiveCaller();
  if (!caller) return {ok: false, error: 'forbidden'};
  if (!uuid.safeParse(otherUserId).success) {
    return {ok: false, error: 'invalid'};
  }

  const insforge = await createInsForgeServerClient();
  const {data, error} = await insforge.database.rpc('open_dm', {
    p_other_user: otherUserId
  });

  if (error) return {ok: false, error: mapChannelError(error)};

  const channelId = (Array.isArray(data) ? data[0] : data) as string | null;
  if (!channelId) return {ok: false, error: 'generic'};

  revalidatePath('/[locale]/channels', 'layout');
  return {ok: true, channelId};
}

export type DmPeer = {
  userId: string;
  displayName: string;
};

// Everyone a DM can be opened with, plus the names the rail needs to label the
// conversations that already exist. Agents are excluded for the same reason
// open_dm() refuses them: an agent only answers when its handle is mentioned,
// so a DM to one would be a room where nobody ever replies.
export async function getDmPeersAction(): Promise<DmPeer[]> {
  const caller = await requireActiveCaller();
  if (!caller) return [];

  const insforge = await createInsForgeServerClient();
  const {data} = await insforge.database
    .from('team_members')
    .select('user_id, display_name')
    .eq('is_active', true)
    .eq('kind', 'human')
    .order('display_name');

  return ((data ?? []) as Array<{user_id: string; display_name: string}>).map(
    (row) => ({userId: row.user_id, displayName: row.display_name})
  );
}

function mapChannelError(error: unknown): string {
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as {message: unknown}).message)
      : String(error ?? '');
  if (message.includes('channels_slug_key') || message.includes('duplicate key')) {
    return 'duplicate_slug';
  }
  if (message.includes('row-level security')) return 'forbidden';
  if (message.includes('archived channel')) return 'parent_archived';
  if (message.includes('parent channel not found')) return 'parent_missing';
  if (message.includes('primary channel cannot be removed')) return 'primary_locked';
  if (message.includes('direct message cannot be removed')) return 'dm_locked';
  if (message.includes('direct message cannot have subchannels')) return 'dm_no_children';
  if (message.includes('other than yourself')) return 'dm_self';
  if (message.includes('direct messages are between people')) return 'dm_not_person';
  if (message.includes('not an active member')) return 'dm_inactive';
  if (message.includes('creator or an admin')) return 'not_yours';
  if (message.includes('channel not found')) return 'parent_missing';
  if (message.includes('only active members')) return 'forbidden';
  return 'generic';
}

export type RemoveChannelResult =
  | {ok: true; deleted: boolean}
  | {ok: false; error: string};

// Removing a channel goes through remove_channel(), never a bare delete: the
// table still has no DELETE grant for any client role. The function decides
// between deleting an empty channel and archiving one that holds a record, and
// reports which it did so the rail can say so.
export async function removeChannelAction(
  channelId: string
): Promise<RemoveChannelResult> {
  const caller = await requireActiveCaller();
  if (!caller || !uuid.safeParse(channelId).success) {
    return {ok: false, error: 'forbidden'};
  }

  const insforge = await createInsForgeServerClient();
  const {data, error} = await insforge.database.rpc('remove_channel', {
    p_channel_id: channelId
  });

  if (error) return {ok: false, error: mapChannelError(error)};

  const row = (Array.isArray(data) ? data[0] : data) as
    | {deleted?: boolean}
    | null;

  revalidatePath('/[locale]/channels/[id]', 'page');
  revalidatePath('/[locale]/products', 'page');
  return {ok: true, deleted: row?.deleted === true};
}

export async function joinChannelAction(
  channelId: string
): Promise<ChannelActionResult> {
  const caller = await requireActiveCaller();
  if (!caller || !uuid.safeParse(channelId).success) {
    return {ok: false, error: 'forbidden'};
  }

  const insforge = await createInsForgeServerClient();
  const {error} = await insforge.database
    .from('channel_members')
    .insert([{channel_id: channelId, user_id: caller.user.id}]);

  if (error) return {ok: false, error: error.message};
  revalidatePath('/[locale]/channels/[id]', 'page');
  return {ok: true};
}

export async function leaveChannelAction(
  channelId: string
): Promise<ChannelActionResult> {
  const caller = await requireActiveCaller();
  if (!caller || !uuid.safeParse(channelId).success) {
    return {ok: false, error: 'forbidden'};
  }

  const insforge = await createInsForgeServerClient();
  const {error} = await insforge.database
    .from('channel_members')
    .delete()
    .eq('channel_id', channelId)
    .eq('user_id', caller.user.id);

  if (error) return {ok: false, error: error.message};
  revalidatePath('/[locale]/channels/[id]', 'page');
  return {ok: true};
}

const levelSchema = z.object({
  channelId: uuid,
  level: z.enum(NOTIFICATION_LEVELS)
});

export async function setChannelNotificationLevelAction(
  input: z.infer<typeof levelSchema>
): Promise<ChannelActionResult> {
  const caller = await requireActiveCaller();
  if (!caller) return {ok: false, error: 'forbidden'};

  const parsed = levelSchema.safeParse(input);
  if (!parsed.success) return {ok: false, error: 'invalid'};

  const insforge = await createInsForgeServerClient();
  const {error} = await insforge.database
    .from('channel_members')
    .update({notification_level: parsed.data.level})
    .eq('channel_id', parsed.data.channelId)
    .eq('user_id', caller.user.id);

  if (error) return {ok: false, error: error.message};
  revalidatePath('/[locale]/channels/[id]', 'page');
  return {ok: true};
}

export async function markChannelReadAction(
  channelId: string
): Promise<ChannelActionResult> {
  const caller = await requireActiveCaller();
  if (!caller || !uuid.safeParse(channelId).success) {
    return {ok: false, error: 'forbidden'};
  }

  const insforge = await createInsForgeServerClient();
  await insforge.database
    .from('channel_members')
    .update({last_read_at: new Date().toISOString()})
    .eq('channel_id', channelId)
    .eq('user_id', caller.user.id);

  return {ok: true};
}
