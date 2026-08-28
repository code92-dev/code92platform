'use client';

import Link from 'next/link';
import {FileText, ImageIcon, Paperclip} from 'lucide-react';
import {useLocale, useTranslations} from 'next-intl';
import {useState, useTransition} from 'react';

import {signKnowledgeFileAction} from '@/lib/actions/knowledge';
import {formatFileSize, isImageFile} from '@/lib/attachments';
import type {MessageAttachment} from '@/lib/channels';

// Files attached to a message.
//
// Each row here is a knowledge_items record, not a pointer to one — a channel
// attachment IS a knowledge source that arrived through a conversation. That is
// why the chip carries a link to the knowledge page beside the download: the
// file is already filed, and saying so in the channel is what makes "attachments
// go to the knowledge base" visible rather than merely true.
//
// The bucket is private, so there is no durable href to render. The download
// mints a short-lived signed URL at click time, exactly as the knowledge page's
// own SourceFileLink does, and opens the tab first so Safari does not treat the
// deferred navigation as a popup.
export default function MessageAttachmentList({
  attachments
}: {
  attachments: MessageAttachment[];
}) {
  const t = useTranslations('channels');
  const locale = useLocale();
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function open(attachment: MessageAttachment) {
    setErrorKey(null);
    setPendingId(attachment.id);
    const tab = window.open('', '_blank');

    startTransition(async () => {
      const result = await signKnowledgeFileAction(attachment.id);
      setPendingId(null);
      if (!result.ok) {
        tab?.close();
        setErrorKey(result.error);
        return;
      }
      if (tab) {
        tab.location.href = result.url;
      } else {
        window.location.href = result.url;
      }
    });
  }

  return (
    <div className="mt-2 space-y-1.5">
      <ul className="flex flex-col gap-1.5">
        {attachments.map((attachment) => {
          const Icon = isImageFile(attachment.mime_type)
            ? ImageIcon
            : FileText;
          return (
            <li
              key={attachment.id}
              className="flex flex-wrap items-center gap-2 rounded border border-hairline bg-raised px-2.5 py-1.5"
            >
              <button
                type="button"
                onClick={() => open(attachment)}
                disabled={pendingId === attachment.id}
                className="inline-flex min-w-0 items-center gap-2 text-sm text-muted transition-colors hover:text-ink disabled:opacity-50"
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-faint" strokeWidth={1.75} />
                <span dir="auto" className="truncate">
                  {pendingId === attachment.id
                    ? t('attachments.opening')
                    : attachment.file_name}
                </span>
              </button>
              <span className="font-mono text-[10px] text-faint">
                {formatFileSize(attachment.size_bytes)}
              </span>
              <Link
                href={`/${locale}/knowledge/${attachment.id}`}
                className="ms-auto inline-flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-faint transition-colors hover:text-accent"
              >
                <Paperclip className="h-3 w-3" strokeWidth={1.75} />
                {t('attachments.inKnowledge')}
              </Link>
            </li>
          );
        })}
      </ul>
      {errorKey ? (
        <p className="text-xs text-danger">{t('attachments.openFailed')}</p>
      ) : null}
    </div>
  );
}
