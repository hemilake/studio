import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import Database from 'better-sqlite3';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  readObjectRecord,
  readOptionalString,
  sanitizeLeafDirectoryName,
  sliceTailPage,
} from '@/shared/utils.js';

const PROVIDER = 'antigravity';
const WAITING_FOR_EVENTS = /^<WAITING_FOR_EVENTS>\s*<\/WAITING_FOR_EVENTS>$/;
const TRUNCATION_MARKER = /<truncated \d+ bytes>/;

/** Resolves the native conversation DB without accepting path separators in a session id. */
function resolveAntigravityConversationDbPath(providerSessionId: string | null): string | null {
  if (!providerSessionId) return null;
  const safeSessionId = sanitizeLeafDirectoryName(providerSessionId, 'Antigravity session id');
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations', `${safeSessionId}.db`);
}

/** Reads one length-delimited protobuf field without depending on AGY's private schema. */
function readWireField(payload: Buffer, wantedField: number): Buffer | null {
  let offset = 0;
  const readVarint = (): bigint | null => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= payload.length) return null;
      const byte = payload[offset++];
      value |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value;
    }
    return null;
  };

  while (offset < payload.length) {
    const key = readVarint();
    if (key === null || key < 8n || key > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const field = Number(key >> 3n);
    const wireType = Number(key & 7n);

    if (wireType === 0) {
      if (readVarint() === null) return null;
    } else if (wireType === 1 || wireType === 5) {
      offset += wireType === 1 ? 8 : 4;
    } else if (wireType === 2) {
      const encodedLength = readVarint();
      if (encodedLength === null || encodedLength > BigInt(payload.length - offset)) return null;
      const length = Number(encodedLength);
      const value = payload.subarray(offset, offset + length);
      offset += length;
      if (field === wantedField) return value;
    } else {
      return null;
    }
    if (offset > payload.length) return null;
  }
  return null;
}

/** Restores a clipped assistant answer from the matching native AGY step, if it is still available. */
function restoreTruncatedAssistantContent(
  content: string,
  stepIndex: number,
  providerSessionId: string | null,
): string | null {
  const marker = TRUNCATION_MARKER.exec(content);
  if (!marker || !providerSessionId || !Number.isSafeInteger(stepIndex) || stepIndex < 0) return null;

  try {
    const dbPath = resolveAntigravityConversationDbPath(providerSessionId);
    if (!dbPath) return null;
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    let payload: unknown;
    try {
      payload = (db.prepare('SELECT step_payload FROM steps WHERE idx = ?').get(stepIndex) as
        | { step_payload?: unknown }
        | undefined)?.step_payload;
    } finally {
      db.close();
    }
    if (!Buffer.isBuffer(payload)) return null;

    // AGY stores planner text at step_payload field 20, nested field 1.
    const plannerStep = readWireField(payload, 20);
    const textField = plannerStep && readWireField(plannerStep, 1);
    if (!textField) return null;
    const fullContent = new TextDecoder('utf-8', { fatal: true }).decode(textField);
    const prefix = content.slice(0, marker.index).trimEnd();
    const suffix = content.slice(marker.index + marker[0].length).trimStart();
    if (!prefix || !suffix || !fullContent.startsWith(prefix) || !fullContent.endsWith(suffix)) return null;
    return fullContent;
  } catch {
    // Older AGY stores may lack the native DB or use a different step layout.
    return null;
  }
}

/** AGY leaves a final quota or runtime error only in the native DB, after the JSONL transcript ends. */
function readTrailingAntigravityError(
  providerSessionId: string | null,
  lastTranscriptStepIndex: number,
): { stepIndex: number; content: string } | null {
  try {
    const dbPath = resolveAntigravityConversationDbPath(providerSessionId);
    if (!dbPath) return null;
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    let row: { idx: number; step_type: number; step_payload: unknown } | undefined;
    try {
      row = db.prepare('SELECT idx, step_type, step_payload FROM steps ORDER BY idx DESC LIMIT 1').get() as
        | { idx: number; step_type: number; step_payload: unknown }
        | undefined;
    } finally {
      db.close();
    }
    if (!row || row.idx <= lastTranscriptStepIndex || row.step_type !== 17 || !Buffer.isBuffer(row.step_payload)) {
      return null;
    }
    // AGY's terminal error summary is step_payload field 24, nested fields 3 then 1.
    const errorStep = readWireField(row.step_payload, 24);
    const errorDetails = errorStep && readWireField(errorStep, 3);
    const summary = errorDetails && readWireField(errorDetails, 1);
    if (!summary) return null;
    const content = new TextDecoder('utf-8', { fatal: true }).decode(summary).trim();
    return content ? { stepIndex: row.idx, content } : null;
  } catch {
    return null;
  }
}

/** Resolves AGY's standard transcript location when an app-created DB row has not been synchronized yet. */
function resolveAntigravityTranscriptPath(options: FetchHistoryOptions): string | null {
  const indexedPath = readOptionalString(options.jsonlPath);
  if (indexedPath) {
    return indexedPath;
  }

  const providerSessionId = readOptionalString(options.providerSessionId);
  if (!providerSessionId) {
    return null;
  }

  const safeSessionId = sanitizeLeafDirectoryName(providerSessionId, 'Antigravity session id');
  return path.join(
    os.homedir(),
    '.gemini',
    'antigravity-cli',
    'brain',
    safeSessionId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
}

/**
 * Reads `transcript_full.jsonl` when it sits next to the transcript: it keeps
 * the planner's tool calls and reasoning, which `transcript.jsonl` drops.
 */
async function readPreferredTranscript(transcriptPath: string): Promise<string> {
  if (path.basename(transcriptPath) === 'transcript.jsonl') {
    try {
      return await readFile(path.join(path.dirname(transcriptPath), 'transcript_full.jsonl'), 'utf8');
    } catch {
      // Older AGY builds write only transcript.jsonl.
    }
  }
  return readFile(transcriptPath, 'utf8');
}

/** Removes provider metadata tags from user-facing transcript content. */
function stripAntigravityTags(content: string): string {
  return content
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .replace(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/g, '$1')
    .trim();
}

/** Converts a provider timestamp into the normalized ISO representation. */
function parseAntigravityTimestamp(value: unknown): string | undefined {
  const raw = readOptionalString(value);
  if (!raw) {
    return undefined;
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Drops the timing header AGY puts at the top of every tool result. */
function stripAntigravityToolHeader(content: string): string {
  return content.replace(/^(?:(?:Created|Completed) At: [^\n]*\n)+\n?/, '').trim();
}

/**
 * Maps one AGY JSONL step into zero or more shared history messages.
 *
 * `transcript_full.jsonl` puts a planner step's tool calls in `tool_calls` and
 * their results in the MODEL steps that follow, in the same order;
 * `pendingToolIds` carries the open calls from one step to the next so each
 * result attaches to its call. `transcript.jsonl` has no `tool_calls`, and its
 * results stay unpaired as before.
 */
function normalizeAntigravityHistoryStep(
  rawStep: unknown,
  sessionId: string | null,
  pendingToolIds: string[] = [],
): NormalizedMessage[] {
  const raw = readObjectRecord(rawStep);
  if (!raw) {
    return [];
  }

  const source = readOptionalString(raw.source);
  const type = readOptionalString(raw.type);
  const content = readOptionalString(raw.content);
  const stepIndex = raw.step_index;
  const baseId = `${sessionId || 'antigravity'}-${typeof stepIndex === 'number' ? stepIndex : generateMessageId('antigravity')}`;
  const timestamp = parseAntigravityTimestamp(raw.created_at);

  if (source === 'USER_EXPLICIT' && type === 'USER_INPUT' && content?.trim()) {
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'text',
      role: 'user',
      content: stripAntigravityTags(content),
    })];
  }

  if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
    const messages: NormalizedMessage[] = [];
    const thinking = readOptionalString(raw.thinking)?.trim();
    if (thinking) {
      messages.push(createNormalizedMessage({
        id: `${baseId}-thinking`,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'thinking',
        role: 'assistant',
        content: thinking,
      }));
    }
    const text = content?.trim();
    if (text && !WAITING_FOR_EVENTS.test(text)) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'text',
        role: 'assistant',
        content: text,
      }));
    }
    const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
    toolCalls.forEach((call, index) => {
      const record = readObjectRecord(call);
      const toolId = `${baseId}-call-${index}`;
      pendingToolIds.push(toolId);
      messages.push(createNormalizedMessage({
        id: toolId,
        sessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: readOptionalString(record?.name) ?? 'Antigravity Tool',
        toolInput: record?.args ?? {},
        toolId,
      }));
    });
    return messages;
  }

  if (source === 'MODEL' && (content?.trim() || readOptionalString(raw.error))) {
    const pairedId = pendingToolIds.shift();
    const isError = type === 'ERROR_MESSAGE' || raw.status === 'ERROR';
    const body = content?.trim() ? stripAntigravityToolHeader(content) : '';
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'tool_result',
      role: 'assistant',
      toolName: type || 'Antigravity Tool',
      toolId: pairedId ?? baseId,
      content: body || readOptionalString(raw.error) || '',
      isError,
    })];
  }

  if (source === 'SYSTEM' && type === 'ERROR_MESSAGE' && content?.trim()) {
    return [createNormalizedMessage({
      id: baseId,
      sessionId,
      timestamp,
      provider: PROVIDER,
      kind: 'error',
      content: content.trim(),
    })];
  }

  return [];
}

/**
 * Maps one stream-json `step_update` to live messages.
 *
 * Text arrives as `text_delta` chunks of an `agent_response` step, which ends
 * with state DONE; that closes the streamed bubble so tool calls that follow
 * render after it. A tool step arrives ACTIVE (call) and then DONE (result).
 */
function normalizeAntigravityStreamStep(step: Record<string, unknown>, sessionId: string | null): NormalizedMessage[] {
  const stepType = readOptionalString(step.step_type);
  const state = readOptionalString(step.state);
  const conversationId = readOptionalString(step.conversation_id) ?? sessionId ?? 'antigravity';
  const stepId = `${conversationId}-${typeof step.step_index === 'number' ? step.step_index : generateMessageId('antigravity')}`;
  const messages: NormalizedMessage[] = [];

  if (stepType === 'agent_response') {
    const delta = typeof step.text_delta === 'string' ? step.text_delta : '';
    if (delta && !WAITING_FOR_EVENTS.test(delta.trim())) {
      messages.push(createNormalizedMessage({ sessionId, provider: PROVIDER, kind: 'stream_delta', content: delta }));
    }
    if (state === 'DONE') {
      messages.push(createNormalizedMessage({ sessionId, provider: PROVIDER, kind: 'stream_end' }));
    }
    return messages;
  }

  if (stepType === 'tool') {
    const info = readObjectRecord(step.tool_info);
    const toolName = readOptionalString(step.tool_name) ?? readOptionalString(info?.name) ?? 'Antigravity Tool';
    if (state === 'ACTIVE') {
      return [createNormalizedMessage({
        id: `${stepId}-call`,
        sessionId,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName,
        toolInput: info?.parameters ?? {},
        toolId: stepId,
      })];
    }
    const output = info?.output;
    return [createNormalizedMessage({
      id: `${stepId}-result`,
      sessionId,
      provider: PROVIDER,
      kind: 'tool_result',
      toolId: stepId,
      content: typeof output === 'string' ? output : output === undefined ? '' : JSON.stringify(output),
      isError: state !== 'DONE',
    })];
  }

  if (state === 'ERROR' || state === 'FAILED') {
    const error = readOptionalString(step.error) ?? readOptionalString(step.text_delta);
    if (error) {
      messages.push(createNormalizedMessage({ id: stepId, sessionId, provider: PROVIDER, kind: 'error', content: error }));
    }
  }
  return messages;
}

/** Antigravity transcript reader and message normalizer used by session services. */
export class AntigravitySessionsProvider implements IProviderSessions {
  /**
   * Normalizes a live AGY event for websocket and SSE consumers: a stream-json
   * `step_update` payload, or a plain text chunk.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (raw && typeof raw.step_type === 'string') {
      return normalizeAntigravityStreamStep(raw, sessionId);
    }
    const content = typeof rawMessage === 'string'
      ? rawMessage
      : readOptionalString(raw?.content) ?? readOptionalString(raw?.text) ?? '';

    if (!content.trim()) {
      return [];
    }

    return [createNormalizedMessage({
      id: readOptionalString(raw?.id) ?? generateMessageId('antigravity'),
      sessionId,
      provider: PROVIDER,
      kind: 'stream_delta',
      content,
    })];
  }

  /** Loads a resilient, tail-paginated view of an AGY transcript. */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const transcriptPath = resolveAntigravityTranscriptPath(options);
    if (!transcriptPath) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: normalizedOffset,
        limit: normalizedLimit,
      };
    }

    const normalized: NormalizedMessage[] = [];
    const pendingToolIds: string[] = [];
    let lastTranscriptStepIndex = -1;
    try {
      const lines = (await readPreferredTranscript(transcriptPath)).split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        try {
          const step = JSON.parse(trimmed);
          const raw = readObjectRecord(step);
          if (typeof raw?.step_index === 'number') {
            lastTranscriptStepIndex = Math.max(lastTranscriptStepIndex, raw.step_index);
          }
          const truncatedFields = raw?.truncated_fields;
          if (
            raw?.source === 'MODEL'
            && raw.type === 'PLANNER_RESPONSE'
            && Array.isArray(truncatedFields)
            && truncatedFields.includes('content')
            && typeof raw.content === 'string'
            && typeof raw.step_index === 'number'
          ) {
            const restored = restoreTruncatedAssistantContent(
              raw.content,
              raw.step_index,
              readOptionalString(options.providerSessionId) ?? null,
            );
            if (restored !== null) raw.content = restored;
          }
          normalized.push(...normalizeAntigravityHistoryStep(raw ?? step, sessionId, pendingToolIds));
        } catch {
          // A live transcript can end with a partially written JSONL record.
          // Preserve every complete entry instead of hiding the whole history.
        }
      }
    } catch (error) {
      console.warn(
        '[AntigravityProvider] Failed to read session transcript:',
        error instanceof Error ? error.name : 'UnknownError',
      );
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: normalizedOffset,
        limit: normalizedLimit,
      };
    }

    const trailingError = readTrailingAntigravityError(
      readOptionalString(options.providerSessionId) ?? null,
      lastTranscriptStepIndex,
    );
    if (trailingError) {
      normalized.push(createNormalizedMessage({
        id: `${sessionId}-${trailingError.stepIndex}`,
        sessionId,
        provider: PROVIDER,
        kind: 'error',
        content: trailingError.content,
      }));
    }

    const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total: normalized.length,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }
}
