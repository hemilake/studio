import { parseAdversarialReviewTag } from '@/shared/adversarial-review.js';
import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * One visible message item in a shared session transcript.
 *
 * Consumed by `share.service.ts` and `share.routes.ts` for both the public
 * endpoint and the owner preview endpoint.
 */
export type SharedTranscriptItem = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
};

/**
 * Candidate transcript item with its hidden flag, returned by the owner preview
 * endpoint so the owner can toggle individual items on or off.
 */
export type SharedTranscriptPreviewItem = SharedTranscriptItem & {
  hidden: boolean;
};

const SYSTEM_REMINDER_BLOCK_REGEX = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const HOOK_CONTEXT_BLOCK_REGEX = /<(?:user-prompt-submit-hook|hook-[a-z0-9_-]+)>[\s\S]*?<\/(?:user-prompt-submit-hook|hook-[a-z0-9_-]+)>/gi;
const SLASH_COMMAND_TAG_REGEX = /<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*?<\/(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/i;
const INLINE_DATA_IMAGE_REGEX = /!\[[^\]]*\]\(data:image\/[^)]+\)|data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g;
const INLINE_DATA_ATTACHMENT_REGEX = /data:[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g;
const COMPACTION_ACK_REGEX = /^Compacted\.?$/i;

const SYNTHETIC_PREFIXES = [
  '<system-reminder>',
  '<task-notification>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<local-command-caveat>',
  '<command-name>',
  '<command-message>',
  '<user-prompt-submit-hook>',
  'Caveat:',
  '[Request interrupted',
  'Base directory for this skill:',
] as const;

function startsWithSyntheticPrefix(text: string): boolean {
  const trimmed = text.trimStart();
  return SYNTHETIC_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function sanitizeCommonText(raw: string): string {
  return raw
    .replace(SYSTEM_REMINDER_BLOCK_REGEX, '')
    .replace(HOOK_CONTEXT_BLOCK_REGEX, '')
    .replace(INLINE_DATA_IMAGE_REGEX, '[image]')
    .replace(INLINE_DATA_ATTACHMENT_REGEX, '[attachment]')
    .trim();
}

function isDroppedMessageMetadata(message: NormalizedMessage): boolean {
  if (message.kind !== 'text') {
    return true;
  }

  if (message.role !== 'user' && message.role !== 'assistant') {
    return true;
  }

  if (
    message.isMeta === true
    || message.isCompactSummary === true
    || Boolean(message.compact)
    || message.isLocalCommand === true
    || message.isLocalCommandStdout === true
    || Boolean(message.commandName)
    || Boolean(message.commandMessage)
    || Boolean(message.parentToolUseId)
    || Boolean(message.subagent)
    || Boolean(message.subagentTools)
    || Boolean(message.toolName)
    || Boolean(message.toolId)
    || Boolean(message.toolInput)
    || Boolean(message.toolResult)
  ) {
    return true;
  }

  return false;
}

function formatUserPromptText(message: NormalizedMessage): string | null {
  const rawContent = typeof message.content === 'string' ? message.content : '';

  if (SLASH_COMMAND_TAG_REGEX.test(rawContent)) {
    return null;
  }

  // Strip embedded <system-reminder> and hook blocks before checking whether any
  // human-authored prompt text remains.
  const withoutReminders = rawContent
    .replace(SYSTEM_REMINDER_BLOCK_REGEX, '')
    .replace(HOOK_CONTEXT_BLOCK_REGEX, '');

  if (startsWithSyntheticPrefix(withoutReminders)) {
    return null;
  }

  const parsedImages = parseImagesInputTag(withoutReminders);
  const parsedFiles = parseFilesInputTag(parsedImages.text);
  const parsedReview = parseAdversarialReviewTag(parsedFiles.text);

  const cleanedText = sanitizeCommonText(parsedReview.text);
  if (startsWithSyntheticPrefix(cleanedText) || SLASH_COMMAND_TAG_REGEX.test(cleanedText)) {
    return null;
  }

  const explicitImagesCount = Array.isArray(message.images) ? message.images.length : 0;
  const imageCount = explicitImagesCount > 0 ? explicitImagesCount : parsedImages.attachments.length;

  const explicitFilesCount =
    (Array.isArray(message.files) ? message.files.length : 0)
    + (Array.isArray(message.attachments) ? message.attachments.length : 0);
  const attachmentCount = explicitFilesCount > 0 ? explicitFilesCount : parsedFiles.attachments.length;

  const placeholders: string[] = [
    ...Array.from({ length: imageCount }, () => '[image]'),
    ...Array.from({ length: attachmentCount }, () => '[attachment]'),
  ];

  const parts: string[] = [];
  if (cleanedText) {
    parts.push(cleanedText);
  }
  if (placeholders.length > 0) {
    parts.push(placeholders.join(' '));
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join('\n\n');
}

function formatAssistantText(
  message: NormalizedMessage,
  compactionSummaries: ReadonlySet<string>,
  hasCompaction: boolean,
): string | null {
  const rawContent = typeof message.content === 'string' ? message.content : '';
  if (!rawContent.trim()) {
    return null;
  }

  if (SLASH_COMMAND_TAG_REGEX.test(rawContent) || startsWithSyntheticPrefix(rawContent)) {
    return null;
  }

  const cleaned = sanitizeCommonText(rawContent);
  if (!cleaned) {
    return null;
  }

  if (compactionSummaries.has(cleaned) || compactionSummaries.has(rawContent.trim())) {
    return null;
  }

  if (hasCompaction && COMPACTION_ACK_REGEX.test(cleaned)) {
    return null;
  }

  return cleaned;
}

/**
 * Pure filter that transforms normalized session history into candidate public
 * share items.
 *
 * Used by `share.service.ts` to build both the owner preview list and the
 * public share payload with identical stable item ids.
 */
export function buildShareCandidateItems(messages: readonly NormalizedMessage[]): SharedTranscriptItem[] {
  const compactionSummaries = new Set<string>();
  let hasCompaction = false;

  for (const message of messages) {
    if (message.compact || message.isCompactSummary) {
      hasCompaction = true;
    }
    if (message.isCompactSummary && typeof message.content === 'string' && message.content.trim()) {
      compactionSummaries.add(message.content.trim());
    }
  }

  const items: SharedTranscriptItem[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || isDroppedMessageMetadata(message)) {
      continue;
    }

    const itemId = typeof message.id === 'string' && message.id.trim()
      ? message.id.trim()
      : `item-${index}`;
    const timestamp = typeof message.timestamp === 'string' ? message.timestamp : '';

    if (message.role === 'user') {
      const text = formatUserPromptText(message);
      if (!text) {
        continue;
      }

      items.push({
        id: itemId,
        role: 'user',
        text,
        timestamp,
      });
      continue;
    }

    if (message.role === 'assistant') {
      const text = formatAssistantText(message, compactionSummaries, hasCompaction);
      if (!text) {
        continue;
      }

      const previous = items[items.length - 1];
      if (previous && previous.role === 'assistant') {
        previous.text = `${previous.text}\n\n${text}`;
      } else {
        items.push({
          id: itemId,
          role: 'assistant',
          text,
          timestamp,
        });
      }
    }
  }

  return items;
}

/**
 * Pure filter that produces the public share items with hidden message ids
 * removed so hidden or internal content never leaves the server.
 *
 * Used by `share.service.ts` and tested directly by `share.filter.test.ts`.
 */
export function filterSharedItems(
  messages: readonly NormalizedMessage[],
  hiddenIds: readonly string[] = [],
): SharedTranscriptItem[] {
  const hiddenSet = new Set(hiddenIds);
  return buildShareCandidateItems(messages).filter((item) => !hiddenSet.has(item.id));
}

/**
 * Pure filter that builds the owner preview items, keeping hidden items in the
 * list with `hidden: true` so the owner UI can toggle them.
 *
 * Used by `share.service.ts` for `GET /api/shares/:id/preview`.
 */
export function buildSharePreviewItems(
  messages: readonly NormalizedMessage[],
  hiddenIds: readonly string[] = [],
): SharedTranscriptPreviewItem[] {
  const hiddenSet = new Set(hiddenIds);
  return buildShareCandidateItems(messages).map((item) => ({
    ...item,
    hidden: hiddenSet.has(item.id),
  }));
}
