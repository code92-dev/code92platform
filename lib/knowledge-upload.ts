'use client';

import {
  isAllowedAttachmentType,
  resolveFileType,
  storedFileType
} from '@/lib/attachments';
import {insforge} from '@/lib/insforge/client';
import {
  KNOWLEDGE_FILE_BUCKET,
  MAX_KNOWLEDGE_FILE_BYTES
} from '@/lib/knowledge';

export type StoredFile = {
  url: string;
  key: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

function safeFileName(name: string): string {
  const extension = name.includes('.') ? name.split('.').pop() : '';
  const suffix = (extension || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return suffix ? `${crypto.randomUUID()}.${suffix}` : crypto.randomUUID();
}

export function validateKnowledgeFile(file: File): string | null {
  if (file.size <= 0 || file.size > MAX_KNOWLEDGE_FILE_BYTES) return 'fileSize';
  // The resolved type, so a .md file with no browser-declared type passes.
  if (!isAllowedAttachmentType(resolveFileType(file))) return 'fileType';
  return null;
}

export async function uploadKnowledgeFile(file: File): Promise<StoredFile> {
  const invalid = validateKnowledgeFile(file);
  if (invalid) throw new Error(invalid);

  const path = `sources/${safeFileName(file.name)}`;
  const {data, error} = await insforge.storage
    .from(KNOWLEDGE_FILE_BUCKET)
    .upload(path, file);
  if (error || !data) throw new Error('uploadFailed');

  return {
    url: data.url,
    key: data.key,
    fileName: file.name,
    mimeType: storedFileType(file, data.mimeType),
    sizeBytes: data.size || file.size
  };
}

// Files attached in a channel go into this same bucket, under their own prefix.
//
// The same bucket, deliberately: a channel attachment becomes a knowledge source
// row, and the signed-URL reader that already serves knowledge sources has to be
// able to read it. A second bucket would mean a second read path for a row that
// is not otherwise different.
export async function uploadMessageAttachments(
  files: File[]
): Promise<StoredFile[]> {
  const uploaded: StoredFile[] = [];
  try {
    for (const file of files) {
      const invalid = validateKnowledgeFile(file);
      if (invalid) throw new Error(invalid);

      const path = `channels/${safeFileName(file.name)}`;
      const {data, error} = await insforge.storage
        .from(KNOWLEDGE_FILE_BUCKET)
        .upload(path, file);
      if (error || !data) throw new Error('uploadFailed');

      uploaded.push({
        url: data.url,
        key: data.key,
        fileName: file.name,
        mimeType: storedFileType(file, data.mimeType),
        sizeBytes: data.size || file.size
      });
    }
    return uploaded;
  } catch (error) {
    // No row references these yet, so an abandoned object is pure litter.
    // Best effort: a failed cleanup must not mask the real error.
    await Promise.allSettled(
      uploaded.map((stored) =>
        insforge.storage.from(KNOWLEDGE_FILE_BUCKET).remove(stored.key)
      )
    );
    throw error;
  }
}

// Best-effort cleanup of an object the database never ended up referencing.
export async function removeKnowledgeFile(key: string) {
  await Promise.allSettled([
    insforge.storage.from(KNOWLEDGE_FILE_BUCKET).remove(key)
  ]);
}
