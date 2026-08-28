'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition
} from 'react';
import {
  Bot,
  CornerDownRight,
  Paperclip,
  Send,
  Terminal,
  Trash2,
  X
} from 'lucide-react';
import {useTranslations} from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import ProposalCard from '@/components/channels/ProposalCard';
import RelativeTime from '@/components/RelativeTime';
import {
  attachFilesToMessageAction,
  deleteMessageAction,
  getChannelViewAction,
  markChannelReadAction,
  postMessageAction
} from '@/lib/actions/channels';
import MessageAttachmentList from '@/components/channels/MessageAttachmentList';
import {DOCUMENT_ACCEPT, formatFileSize} from '@/lib/attachments';
import {
  removeKnowledgeFile,
  uploadMessageAttachments
} from '@/lib/knowledge-upload';
import {
  MAX_MESSAGE_ATTACHMENTS,
  mentionToken,
  type Message,
  type MessageAttachment
} from '@/lib/channels';
import {mentionHighlight} from '@/lib/mention-highlight';
import type {AgentProposal} from '@/lib/agents';

// How often the open channel asks for new messages.
//
// The notification bell polls at 60s because a reassigned task is minutes-matter.
// A channel someone is reading is seconds-matter, so this is much tighter — and
// it is still polling rather than a subscription because the project ships with
// realtime.retention_days = 0. Raising that in insforge.toml is what replaces
// this loop; until then a short poll is the honest implementation rather than a
// subscription to a stream with nothing in it.
const POLL_INTERVAL_MS = 5000;

async function cleanupStoredFiles(
  stored: Awaited<ReturnType<typeof uploadMessageAttachments>>
) {
  await Promise.all(stored.map((file) => removeKnowledgeFile(file.key)));
}

export type MessageAuthor = {
  user_id: string;
  display_name: string;
  kind: 'human' | 'agent';
  handle: string | null;
  // Whether an @ actually reaches this author. Separate from the list itself
  // because an archived agent must keep rendering its past messages under its
  // own name — dropping it from `authors` would relabel the history it wrote.
  mentionable: boolean;
};

export default function MessageStream({
  channelId,
  initialMessages,
  initialProposals,
  initialAttachments,
  authors,
  currentUserId,
  isAdmin
}: {
  channelId: string;
  initialMessages: Message[];
  initialProposals: AgentProposal[];
  initialAttachments: MessageAttachment[];
  authors: MessageAuthor[];
  currentUserId: string;
  isAdmin: boolean;
}) {
  const t = useTranslations('channels');
  const [messages, setMessages] = useState(initialMessages);
  // Messages this reader has just sent that the server has not confirmed yet.
  // Kept beside `messages` rather than merged into it so a poll landing mid-send
  // cannot wipe them.
  const [sending, setSending] = useState<Message[]>([]);
  const [proposals, setProposals] = useState(initialProposals);
  const [attachments, setAttachments] = useState(initialAttachments);
  const [body, setBody] = useState('');
  // Files chosen but not yet posted. They are uploaded on send, not on pick, so
  // abandoning a draft leaves nothing behind in storage to clean up.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  // The @token being typed right now: where it starts in the body, and what has
  // been typed after the @. null when the caret is not inside one.
  const [mention, setMention] = useState<{start: number; query: string} | null>(
    null
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);
  // The transition is still what defers the post, but nothing renders from its
  // pending flag any more: the draft message itself is the progress indicator.
  const [, startTransition] = useTransition();
  const bottomRef = useRef<HTMLDivElement>(null);

  const attachmentsByMessage = useMemo(() => {
    const grouped = new Map<string, MessageAttachment[]>();
    for (const attachment of attachments) {
      const existing = grouped.get(attachment.source_message_id);
      if (existing) existing.push(attachment);
      else grouped.set(attachment.source_message_id, [attachment]);
    }
    return grouped;
  }, [attachments]);

  const authorMap = new Map(authors.map((a) => [a.user_id, a]));

  // Everyone who can actually be reached with an @. Members whose name yields no
  // usable token are left out rather than offered and silently ignored.
  const mentionable = authors
    .filter((a) => a.mentionable)
    .map((a) => ({author: a, token: mentionToken(a)}))
    .filter((c): c is {author: MessageAuthor; token: string} => c.token !== null);

  const knownTokens = new Set(mentionable.map((c) => c.token));
  const highlight = mentionHighlight(knownTokens);

  const refresh = useCallback(async () => {
    const view = await getChannelViewAction(channelId);
    setMessages(view.messages);
    setProposals(view.proposals);
    setAttachments(view.attachments);
  }, [channelId]);

  useEffect(() => {
    // Pause while the tab is hidden. A backgrounded channel polling every five
    // seconds is a battery cost with no reader on the other end.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    void markChannelReadAction(channelId);
  }, [channelId, messages.length]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({behavior: 'smooth', block: 'end'});
  }, [messages.length, sending.length]);

  // An @ counts as starting a mention only at the beginning of a word, so an
  // email address does not open the menu.
  function readMention(value: string, caret: number) {
    const upto = value.slice(0, caret);
    const at = upto.lastIndexOf('@');
    if (at === -1) return null;

    const before = at === 0 ? '' : upto[at - 1];
    if (before && !/\s/.test(before)) return null;

    const query = upto.slice(at + 1);
    // A space ends it; so does a token longer than any handle can be.
    if (/[\s]/.test(query) || query.length > 40) return null;
    return {start: at, query};
  }

  function onComposerChange(value: string, caret: number) {
    setBody(value);
    const next = readMention(value, caret);
    setMention(next);
    setMentionIndex(0);
  }

  const matches = mention
    ? mentionable
        .filter(({author, token}) => {
          const q = mention.query.toLowerCase();
          return (
            q === '' ||
            token.startsWith(q) ||
            author.display_name.toLowerCase().includes(q)
          );
        })
        .slice(0, 6)
    : [];

  function choose(token: string) {
    if (!mention) return;
    const before = body.slice(0, mention.start);
    const after = body.slice(mention.start + 1 + mention.query.length);
    const next = `${before}@${token} ${after}`;
    setBody(next);
    setMention(null);
    setMentionIndex(0);

    // Put the caret after the inserted mention rather than at the end of the
    // message, so it can be typed around mid-sentence.
    const caret = before.length + token.length + 2;
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(caret, caret);
    });
  }

  function pickFiles(chosen: FileList | null) {
    if (!chosen?.length) return;
    setError(null);
    setPendingFiles((prev) => {
      const next = [...prev, ...Array.from(chosen)];
      if (next.length > MAX_MESSAGE_ATTACHMENTS) {
        setError(t('errors.tooManyFiles', {count: MAX_MESSAGE_ATTACHMENTS}));
        return next.slice(0, MAX_MESSAGE_ATTACHMENTS);
      }
      return next;
    });
    // Cleared so re-picking the same file fires onChange again.
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function send() {
    const files = pendingFiles;
    // A message row must have a body — the CHECK requires 1..20000 characters —
    // so a post that is only files still needs text. The file names are the
    // honest default: they say what was sent without inventing a sentence.
    const trimmed =
      body.trim() || (files.length ? files.map((f) => f.name).join(', ') : '');
    if (!trimmed) {
      setError(t('errors.empty'));
      return;
    }
    setError(null);

    const parentId = replyTo;
    const draft: Message = {
      id: `sending-${crypto.randomUUID()}`,
      channel_id: channelId,
      parent_id: parentId,
      author_id: currentUserId,
      body: trimmed,
      kind: 'human',
      promoted_to_type: null,
      promoted_to_id: null,
      edited_at: null,
      deleted_at: null,
      created_at: new Date().toISOString()
    };

    // On screen before the round trip, not after it. Posting wakes any mentioned
    // agent, and while that used to be awaited the poster watched their own
    // sentence wait for the reply and then arrive with it — which reads as a form
    // submission rather than as a conversation.
    setSending((prev) => [...prev, draft]);
    setBody('');
    setReplyTo(null);
    setPendingFiles([]);
    if (files.length) setUploading(true);

    startTransition(async () => {
      const result = await postMessageAction({
        channelId,
        body: trimmed,
        parentId
      });

      if (!result.ok) {
        // Hand the text and the files back rather than losing them to a failed
        // send. Nothing was uploaded yet, so there is no storage to undo.
        setSending((prev) => prev.filter((m) => m.id !== draft.id));
        setBody((current) => (current.trim() ? current : trimmed));
        setReplyTo(parentId);
        setPendingFiles(files);
        setUploading(false);
        setError(t('errors.generic'));
        return;
      }

      // Files go up after the message exists, because each becomes a knowledge
      // item that has to name the message it arrived on. The message is already
      // posted at this point, so a failed upload is reported without taking the
      // message down with it — the text is real and the reader can retry the
      // file.
      if (files.length && result.messageId) {
        // Both halves report the reason they failed, and both reasons are
        // shown. A generic "could not be attached" hides which half broke —
        // a storage rejection and a database refusal need different fixes,
        // and the person who can see the message is the one who can act on it.
        let stored: Awaited<ReturnType<typeof uploadMessageAttachments>> = [];
        try {
          stored = await uploadMessageAttachments(files);
          const attached = await attachFilesToMessageAction({
            messageId: result.messageId,
            files: stored
          });
          if (!attached.ok) {
            await cleanupStoredFiles(stored);
            console.error('[attach] server action refused:', attached.error);
            setError(`${t('errors.attachFailed')} ${attached.error}`);
          }
        } catch (uploadError) {
          // A thrown server-action/network failure is just as uncommitted as an
          // explicit refusal. The uploaded objects have no database owner, so
          // leaving them behind would leak storage on every interrupted attach.
          await cleanupStoredFiles(stored);
          const reason =
            uploadError instanceof Error
              ? uploadError.message
              : String(uploadError);
          console.error('[attach] upload threw:', uploadError);
          setError(`${t('errors.attachFailed')} ${reason}`);
        }
      }
      setUploading(false);

      await refresh();
      // Dropped in the same tick the confirmed list arrives, so the message never
      // flickers out of the thread between the two.
      setSending((prev) => prev.filter((m) => m.id !== draft.id));

      // An agent reply lands a few seconds after the mention, so look again
      // once rather than making the reader wait for the next poll.
      setTimeout(() => void refresh(), 3000);
    });
  }

  // Optimistic, and safe to be: the row is only ever soft-deleted, so the worst
  // a failed call costs is a tombstone that un-hides on the next poll.
  function remove(messageId: string) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId ? {...m, deleted_at: new Date().toISOString()} : m
      )
    );
    startTransition(async () => {
      const result = await deleteMessageAction({messageId});
      if (!result.ok) setError(t('errors.deleteFailed'));
      await refresh();
    });
  }

  const allMessages = [...messages, ...sending];
  const topLevel = allMessages.filter((m) => m.parent_id === null);
  const repliesOf = (id: string) =>
    allMessages.filter((m) => m.parent_id === id);
  const proposalsFor = (messageId: string) =>
    proposals.filter((p) => p.message_id === messageId);
  const attachmentsFor = (messageId: string) =>
    attachmentsByMessage.get(messageId) ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
        {topLevel.length === 0 ? (
          <p className="py-12 text-center text-sm text-faint">
            {t('empty.noMessages')}
          </p>
        ) : (
          <ol className="flex flex-col gap-5">
            {topLevel.map((message) => (
              <li key={message.id} className="flex flex-col gap-3">
                <MessageRow
                  message={message}
                  author={authorMap.get(message.author_id ?? '') ?? null}
                  onReply={() => setReplyTo(message.id)}
                  onDelete={() => remove(message.id)}
                  canDelete={message.author_id === currentUserId}
                  attachments={attachmentsFor(message.id)}
                  replyCount={repliesOf(message.id).length}
                  isSending={message.id.startsWith('sending-')}
                  highlight={highlight}
                />

                {repliesOf(message.id).length > 0 ? (
                  <ol className="flex flex-col gap-3 border-s border-hairline ps-4 ms-3">
                    {repliesOf(message.id).map((reply) => (
                      <li key={reply.id} className="flex flex-col gap-3">
                        <MessageRow
                          message={reply}
                          author={authorMap.get(reply.author_id ?? '') ?? null}
                          onReply={() => setReplyTo(message.id)}
                          onDelete={() => remove(reply.id)}
                          canDelete={reply.author_id === currentUserId}
                          attachments={attachmentsFor(reply.id)}
                          replyCount={0}
                          isSending={reply.id.startsWith('sending-')}
                          highlight={highlight}
                        />
                        {proposalsFor(reply.id).map((p) => (
                          <ProposalCard
                            key={p.id}
                            proposal={p}
                            agentHandle={
                              authorMap.get(p.agent_id)?.handle ?? 'agent'
                            }
                            deciderName={
                              p.decided_by
                                ? (authorMap.get(p.decided_by)?.display_name ??
                                  null)
                                : null
                            }
                            isAdmin={isAdmin}
                          />
                        ))}
                      </li>
                    ))}
                  </ol>
                ) : null}

                {proposalsFor(message.id).map((p) => (
                  <ProposalCard
                    key={p.id}
                    proposal={p}
                    agentHandle={authorMap.get(p.agent_id)?.handle ?? 'agent'}
                    deciderName={
                      p.decided_by
                        ? (authorMap.get(p.decided_by)?.display_name ?? null)
                        : null
                    }
                    isAdmin={isAdmin}
                  />
                ))}
              </li>
            ))}
          </ol>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-hairline bg-panel px-4 py-3 md:px-6">
        {replyTo ? (
          <button
            type="button"
            onClick={() => setReplyTo(null)}
            className="mb-2 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-accent"
          >
            <CornerDownRight className="h-3 w-3 rtl:rotate-180" strokeWidth={1.75} />
            {t('message.reply')}
            <span className="text-faint">·</span>
            <span className="text-faint">{t('create.cancel')}</span>
          </button>
        ) : null}

        {mention && matches.length > 0 ? (
          <ul
            role="listbox"
            aria-label={t('composer.mentionListLabel')}
            className="mb-2 max-h-56 overflow-y-auto rounded-lg border border-hairline bg-panel py-1 shadow-lg"
          >
            {matches.map((candidate, i) => (
              <li key={candidate.author.user_id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === mentionIndex}
                  // onMouseDown, not onClick: the textarea must not lose focus
                  // before the insertion runs.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(candidate.token);
                  }}
                  onMouseEnter={() => setMentionIndex(i)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-start text-sm transition-colors ${
                    i === mentionIndex ? 'bg-raised text-ink' : 'text-muted'
                  }`}
                >
                  {candidate.author.kind === 'agent' ? (
                    <Bot className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={1.75} />
                  ) : (
                    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[10px] text-faint">
                      {candidate.author.display_name.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="truncate">{candidate.author.display_name}</span>
                  <span className="ms-auto shrink-0 font-mono text-[10px] text-faint" dir="ltr">
                    @{candidate.token}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {pendingFiles.length > 0 ? (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {pendingFiles.map((file, i) => (
              <li
                key={`${file.name}-${i}`}
                className="inline-flex items-center gap-1.5 rounded border border-hairline bg-raised px-2 py-1 text-xs text-muted"
              >
                <Paperclip className="h-3 w-3 shrink-0 text-faint" strokeWidth={1.75} />
                <span dir="auto" className="max-w-[16rem] truncate">
                  {file.name}
                </span>
                <span className="font-mono text-[10px] text-faint">
                  {formatFileSize(file.size)}
                </span>
                <button
                  type="button"
                  aria-label={t('composer.removeFile')}
                  onClick={() =>
                    setPendingFiles((prev) => prev.filter((_, j) => j !== i))
                  }
                  className="text-faint transition-colors hover:text-danger"
                >
                  <X className="h-3 w-3" strokeWidth={2} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={DOCUMENT_ACCEPT}
            className="sr-only"
            onChange={(e) => pickFiles(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title={t('composer.attachHint')}
            aria-label={t('composer.attach')}
            className="inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded border border-hairline bg-bg text-faint transition-colors hover:border-accent/40 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <Paperclip className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <textarea
            ref={composerRef}
            value={body}
            onChange={(e) =>
              onComposerChange(e.target.value, e.target.selectionStart ?? 0)
            }
            onClick={(e) =>
              onComposerChange(
                e.currentTarget.value,
                e.currentTarget.selectionStart ?? 0
              )
            }
            onBlur={() => setMention(null)}
            onKeyDown={(e) => {
              // While the menu is open it owns the arrows, Enter and Tab.
              if (mention && matches.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % matches.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMentionIndex((i) => (i - 1 + matches.length) % matches.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  choose(matches[mentionIndex].token);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setMention(null);
                  return;
                }
              }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            dir="auto"
            placeholder={
              replyTo
                ? t('composer.replyPlaceholder')
                : t('composer.placeholder')
            }
            className="min-h-[44px] flex-1 resize-y rounded border border-hairline bg-bg px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={send}
            className="inline-flex h-[44px] items-center gap-1.5 rounded bg-accent px-4 text-sm font-semibold text-bg transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <Send className="h-3.5 w-3.5 rtl:rotate-180" strokeWidth={2} />
            {uploading ? t('composer.uploading') : t('composer.send')}
          </button>
        </div>

        {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
        <p className="mt-2 text-xs text-faint">
          {t('composer.mentionHint')} {t('composer.attachHint')}
        </p>
      </div>
    </div>
  );
}

function MessageRow({
  message,
  author,
  onReply,
  onDelete,
  canDelete,
  attachments,
  replyCount,
  isSending = false,
  highlight
}: {
  message: Message;
  author: MessageAuthor | null;
  onReply: () => void;
  onDelete: () => void;
  canDelete: boolean;
  attachments: MessageAttachment[];
  replyCount: number;
  isSending?: boolean;
  highlight: ReturnType<typeof mentionHighlight>;
}) {
  const t = useTranslations('channels');
  const isSystem = message.kind === 'system';
  const isAgent = message.kind === 'agent';

  if (message.deleted_at) {
    return <p className="text-sm italic text-faint">{t('message.deleted')}</p>;
  }

  return (
    <article
      className={`flex items-start gap-2.5 ${isSending ? 'opacity-60' : ''}`}
    >
      <span
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium ${
          isSystem
            ? 'border-hairline bg-raised text-faint'
            : isAgent
              ? 'border-accent/30 bg-accent/10 text-accent'
              : 'border-hairline bg-raised text-muted'
        }`}
        aria-hidden="true"
      >
        {isSystem ? (
          <Terminal className="h-3.5 w-3.5" strokeWidth={1.75} />
        ) : isAgent ? (
          <Bot className="h-3.5 w-3.5" strokeWidth={1.75} />
        ) : (
          (author?.display_name ?? '?').slice(0, 1).toUpperCase()
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium text-ink">
            {isSystem
              ? t('message.system')
              : (author?.display_name ?? '—')}
          </span>
          {isAgent && author?.handle ? (
            <span className="font-mono text-[10px] uppercase tracking-widest text-accent">
              @{author.handle}
            </span>
          ) : null}
          <span className="font-mono text-[10px] text-faint">
            {isSending ? (
              t('composer.sending')
            ) : (
              <RelativeTime date={message.created_at} />
            )}
          </span>
          {message.edited_at ? (
            <span className="font-mono text-[10px] text-faint">
              {t('message.edited')}
            </span>
          ) : null}
        </div>

        {/* dir="auto" on the body — the single documented exception to the
            DESIGN.md rule that dir is set only on <html>. A thread mixes Arabic
            and English messages and each has to lay out on its own terms. */}
        <div
          dir="auto"
          className="prose-sm mt-1 max-w-none whitespace-pre-wrap break-words text-sm text-muted [&_a]:text-accent [&_code]:rounded [&_code]:border [&_code]:border-hairline [&_code]:bg-raised [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_strong]:text-ink"
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm, highlight]}
            components={{
              a({className, children, ...props}) {
                if (className === 'c92-mention') {
                  return (
                    <span
                      dir="ltr"
                      className="rounded bg-accent/10 px-1 font-medium text-accent"
                    >
                      {children}
                    </span>
                  );
                }
                return (
                  <a className={className} {...props}>
                    {children}
                  </a>
                );
              }
            }}
          >
            {message.body}
          </ReactMarkdown>
        </div>

        {message.promoted_to_type ? (
          <p className="mt-1.5 inline-flex items-center gap-1.5 rounded border border-accent/30 bg-accent/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-accent">
            {message.promoted_to_type === 'product_task'
              ? t('message.becameTask')
              : message.promoted_to_type === 'status_update'
                ? t('message.becameStatus')
                : message.promoted_to_type === 'knowledge_item'
                  ? t('message.becameNote')
                  : t('message.becamePhase')}
          </p>
        ) : null}

        {attachments.length > 0 ? (
          <MessageAttachmentList attachments={attachments} />
        ) : null}

        {!isSystem && !isSending ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onReply}
              className="font-mono text-[10px] uppercase tracking-widest text-faint transition-colors hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {replyCount > 0 ? t('message.replies', {count: replyCount}) : t('message.reply')}
            </button>
            {/* Only the author's own messages. RLS says the same thing, so this
                is about not offering an action that would be refused — an agent
                reply and someone else's message have no delete control at all. */}
            {canDelete ? (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(t('message.confirmDelete'))) onDelete();
                }}
                className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-faint transition-colors hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-danger"
              >
                <Trash2 className="h-3 w-3" strokeWidth={1.75} />
                {t('message.delete')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
