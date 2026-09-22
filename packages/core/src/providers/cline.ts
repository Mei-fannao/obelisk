// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Cline CLI provider adapter (see docs/adr/0001).
//
// Source: ~/.cline/data/sessions/<session-id>/ directories, each holding a
// <session-id>.json metadata file (status, cwd, title, usage) and a
// <session-id>.messages.json transcript (Anthropic-style content blocks:
// text / thinking / tool_use / tool_result / image). Structurally the Kimi
// shape — one directory per session, aggregate cursor, full reparse — so the
// kimi.ts patterns apply: unit key = session directory, snapshot parse with a
// delete-session head and countMode 'total', cursor = a stat quadruple
// (max mtime + messages.json size + max ctime + max ino) across the session's
// files — stat-only, so discovery never parses the transcript; same-mtime
// rewrites change one of the other three components.
//
// Projection: assistant text and thinking blocks become separate message
// records (kimi's content.part style), tool calls/results ride the assistant
// record that carries the tool_use block. User messages that carry ONLY
// tool_result blocks are result transports, not user turns — their results
// attach to the tool call they answer. Cline stores subagent activity only as
// aggregated cost in the metadata, so no SubagentRecords exist.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

import { projectSlugFromPath, sourceInventoryIssue, trunc, truncJson } from '../parsing.ts';

import type {
  Cursor,
  DiscoverContext,
  IndexUnit,
  ProviderAdapter,
  RawLookup,
  RawRecord,
  TranscriptRecord,
} from './types.ts';

type JsonRecord = Record<string, any>;

const SOURCE = 'cline';
export const CLINE_CANONICAL_TRANSCRIPT_MARKER = '__cline_canonical_transcript_v1__';

const PROMPT_OPEN_TAG = '<user_input';
const PROMPT_CLOSE_TAG = '</user_input>';

interface ClineSessionUnitMeta {
  readonly kind: 'session';
  readonly sessionDir: string;
  readonly metaPath: string;
  readonly messagesPath: string;
  readonly currentCursor: Exclude<Cursor, null>;
}

interface ClineTombstoneUnitMeta {
  readonly kind: 'tombstone';
}

function defaultClineRoot(): string {
  return join(homedir(), '.cline', 'data');
}

function namespacedSessionId(nativeId: string): string {
  return `cline:${nativeId}`;
}

function nativeSessionId(sessionId: string): string | null {
  return sessionId.startsWith('cline:') ? sessionId.slice('cline:'.length) : null;
}

function normalizeTime(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

function contentBlocks(content: unknown): JsonRecord[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content)
    ? content.filter((block): block is JsonRecord => block !== null && typeof block === 'object')
    : [];
}

function cursorFor(metaPath: string, messagesPath: string): Exclude<Cursor, null> | null {
  let maxMtime = 0;
  let size = 0;
  let ctime = 0;
  let ino = 0;
  for (const path of [metaPath, messagesPath]) {
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    maxMtime = Math.max(maxMtime, stat.mtimeMs);
    ctime = Math.max(ctime, stat.ctimeMs);
    ino = Math.max(ino, stat.ino);
    if (path === messagesPath) size = stat.size;
  }
  return `${maxMtime}:${size}:${ctime}:${ino}`;
}

// Strips the "<user_input mode=...>…</user_input>" wrapper around the first
// prompt via index slicing — the wrapper is a fixed tag, not a pattern.
function stripPromptWrapper(prompt: string): string {
  const open = prompt.indexOf(PROMPT_OPEN_TAG);
  if (open === -1) return prompt;
  const bodyStart = prompt.indexOf('>', open);
  if (bodyStart === -1) return prompt;
  const close = prompt.indexOf(PROMPT_CLOSE_TAG, bodyStart);
  if (close === -1) return prompt.slice(bodyStart + 1);
  return prompt.slice(bodyStart + 1, close);
}

function sessionTitle(meta: JsonRecord): string | null {
  const metadata = meta.metadata;
  if (metadata !== null && typeof metadata === 'object' && typeof metadata.title === 'string') {
    return metadata.title;
  }
  const prompt = typeof meta.prompt === 'string' ? meta.prompt : null;
  if (prompt === null) return null;
  return trunc(stripPromptWrapper(prompt).trim()) || null;
}

function sessionRoot(meta: JsonRecord): string | null {
  if (typeof meta.workspace_root === 'string') return meta.workspace_root;
  if (typeof meta.cwd === 'string') return meta.cwd;
  return null;
}

function inputUsage(metrics: unknown): number | null {
  if (metrics === null || typeof metrics !== 'object') return null;
  const record = metrics as JsonRecord;
  const fields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  const values = fields.map((field) => record[field]);
  if (!values.some((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  return values.reduce<number>((sum, value) => sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0), 0);
}

function toolResultContent(content: unknown): { text: string; errored: boolean } {
  if (typeof content === 'string') return { text: trunc(content), errored: false };
  if (Array.isArray(content)) {
    const lines: string[] = [];
    let errored = false;
    for (const item of content) {
      if (item === null || typeof item !== 'object') continue;
      if (item.success === false) errored = true;
      const query = typeof item.query === 'string' ? item.query : '';
      const result = typeof item.result === 'string' ? item.result : truncJson(item.result) ?? '';
      const error = typeof item.error === 'string' ? item.error : null;
      const body = error !== null && result.length === 0 ? error : result;
      lines.push(query.length > 0 ? `${query}: ${body}` : body);
    }
    return { text: trunc(lines.join('\n')), errored };
  }
  if (content === null || content === undefined) return { text: '', errored: false };
  return { text: truncJson(content) ?? '', errored: false };
}

function projectSession(
  sessionId: string,
  metaRecord: JsonRecord,
  transcript: JsonRecord,
  messagesPath: string,
  project: string | null,
): TranscriptRecord[] {
  const nativeId = nativeSessionId(sessionId) ?? sessionId;
  const records: TranscriptRecord[] = [];
  const messages = Array.isArray(transcript.messages) ? transcript.messages : [];
  // tool call id → record uuid that carries the call; tool results attach here.
  const callOwnerUuids = new Map<string, string>();
  // Last message record uuid of the previous message: the parent chain must
  // cross message boundaries (tool_result carrier messages between them do
  // not emit message records and stay out of the chain).
  let previousMessageUuid: string | null = null;
  let visibleCount = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  const emitToolResults = (blocks: JsonRecord[], primaryUuid: string): void => {
    for (const block of blocks) {
      const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
      if (callId === null) continue;
      const { text, errored } = toolResultContent(block.content);
      records.push({
        kind: 'tool_result',
        tool_use_id: `cline:${nativeId}:${callId}`,
        message_uuid: callOwnerUuids.get(callId) ?? primaryUuid,
        session_id: sessionId,
        content: text,
        file_path: null,
        is_error: (block.is_error === true || errored) ? 1 : 0,
      });
    }
  };

  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    const role = typeof message.role === 'string' ? message.role : 'unknown';
    const blocks = contentBlocks(message.content);
    const ts = typeof message.ts === 'number' && Number.isFinite(message.ts) ? message.ts : null;
    const timestamp = normalizeTime(ts);
    if (ts !== null) {
      firstTs = firstTs === null ? ts : Math.min(firstTs, ts);
      lastTs = lastTs === null ? ts : Math.max(lastTs, ts);
    }
    const modelInfo = message.modelInfo as JsonRecord | undefined;
    const model = typeof modelInfo?.id === 'string' ? modelInfo.id : null;
    const metrics = message.metrics as JsonRecord | undefined;

    const baseUuid = `cline:${nativeId}:${String(message.id ?? `ts-${ts}`)}`;
    const toolResults = blocks.filter((block) => block.type === 'tool_result');
    const isResultCarrier = role === 'user'
      && toolResults.length > 0
      && toolResults.length === blocks.length;

    if (isResultCarrier) {
      // Result transports attach their results to the tool call they answer;
      // they never appear as user turns.
      emitToolResults(toolResults, baseUuid);
      continue;
    }

    const textBlocks = blocks.filter((block) => block.type === 'text' && typeof block.text === 'string');
    const thinkingBlocks = blocks.filter((block) => block.type === 'thinking' && typeof block.thinking === 'string');
    const toolUses = blocks.filter((block) => block.type === 'tool_use' && typeof block.id === 'string');

    // Within one message the blocks chain onto each other (text follows
    // thinking); the first record chains to the previous message's last
    // record, keeping one connected parent chain across the whole session.
    let previousUuid: string | null = previousMessageUuid;
    const emit = (text: string, contentType: string, index: number): string => {
      const uuid = `${baseUuid}:b${index}`;
      records.push({
        kind: 'message',
        uuid,
        session_id: sessionId,
        type: role,
        parent_uuid: previousUuid,
        timestamp,
        role,
        text: trunc(text),
        content_type: contentType,
        is_meta: 0,
        visibility: 'visible',
        model,
        is_sidechain: 0,
        agent_id: null,
        input_tokens: index === 0 ? inputUsage(metrics) : null,
        output_tokens: index === 0 && typeof metrics?.outputTokens === 'number' ? metrics.outputTokens : null,
        cwd: sessionRoot(metaRecord),
        skill: null,
        source: SOURCE,
      });
      previousUuid = uuid;
      return uuid;
    };

    let primaryUuid: string | null = null;
    let emitted = 0;
    for (const block of thinkingBlocks) {
      primaryUuid = emit(String(block.thinking), 'thinking', emitted++);
    }
    for (const block of textBlocks) {
      const raw = String(block.text);
      // Cline wraps the first user prompt in a fixed tag; unwrap for display.
      const text = role === 'user' && raw.startsWith(PROMPT_OPEN_TAG)
        ? stripPromptWrapper(raw).trim()
        : raw;
      primaryUuid = emit(text, 'text', emitted++);
    }
    if (primaryUuid === null) {
      // A bare tool-use (or unknown-shape) message still needs a visible anchor.
      primaryUuid = emit('', 'tool_use', 0);
    }
    visibleCount += 1;

    for (const block of toolUses) {
      const name = typeof block.name === 'string' ? block.name : 'tool';
      const toolId = `cline:${nativeId}:${block.id}`;
      const input = block.input ?? {};
      let filePath: string | null = null;
      if (typeof input?.path === 'string') filePath = input.path;
      else if (Array.isArray(input?.files) && input.files.length > 0) {
        filePath = typeof input.files[0]?.path === 'string' ? input.files[0].path : null;
      }
      records.push({
        kind: 'tool_call',
        id: toolId,
        message_uuid: primaryUuid,
        session_id: sessionId,
        name,
        presentation: 'default',
        input_json: truncJson(input) ?? '{}',
        file_path: filePath,
      });
      callOwnerUuids.set(String(block.id), primaryUuid);
    }

    // Real user messages can mix text with tool_result blocks; project the
    // results so the matching call renders with its output.
    emitToolResults(toolResults, primaryUuid);
    previousMessageUuid = primaryUuid;
  }

  records.push({
    kind: 'session',
    id: sessionId,
    title: sessionTitle(metaRecord),
    project,
    started_at: normalizeTime(metaRecord.started_at),
    ended_at: normalizeTime(metaRecord.ended_at),
    git_branch: null,
    version: typeof transcript.origin?.version === 'string' ? transcript.origin.version : null,
    message_count: visibleCount,
    countMode: 'total',
    jsonl_path: messagesPath,
    source: SOURCE,
  });
  return records;
}

function changedSessionDirs(root: string, changedPaths: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const changedPath of changedPaths) {
    const absolute = isAbsolute(changedPath) ? normalize(changedPath) : normalize(join(root, changedPath));
    const inside = relative(root, absolute);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue;
    const segments = inside.split(sep);
    result.add(join(root, segments[0]!));
  }
  return result;
}

function listSessionDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, `${entry.name}.messages.json`)))
    .map((entry) => join(root, entry.name))
    .sort();
}

function rawMessage(messagesPath: string, messageId: string): RawRecord | null {
  if (!existsSync(messagesPath)) return null;
  let transcript: JsonRecord;
  try {
    transcript = JSON.parse(readFileSync(messagesPath, 'utf8')) as JsonRecord;
  } catch {
    return null;
  }
  const message = (Array.isArray(transcript.messages) ? transcript.messages : [])
    .find((candidate: JsonRecord) => candidate?.id === messageId);
  if (message === undefined) return null;
  const blocks = contentBlocks(message.content);
  const parts = blocks
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : null)
      ?? (block.type === 'thinking' && typeof block.thinking === 'string' ? block.thinking : null))
    .filter((value): value is string => value !== null);
  const payload = JSON.stringify(message);
  return {
    text: payload,
    totalLength: payload.length,
    offset: 0,
    limit: payload.length,
    hasMore: false,
    messageText: parts.length > 0 ? parts.join('\n') : null,
  };
}

export function createClineProvider({ rootDir = defaultClineRoot() }: { rootDir?: string } = {}): ProviderAdapter {
  const name = SOURCE;
  return {
    name,
    descriptor: { id: name, name: 'Cline', vendor: 'Cline', defaultRoot: rootDir, color: '#3b82f6' },
    indexVersionMarker: CLINE_CANONICAL_TRANSCRIPT_MARKER,
    sessionUnitKey: ({ jsonlPath }) => join(jsonlPath, '..'),
    watchTargets: (configuredRoot) => [{ kind: 'tree', path: join(configuredRoot, 'sessions') }],
    discover(ctx: DiscoverContext): IndexUnit[] {
      const sessionsDir = join(rootDir, 'sessions');
      if (!existsSync(sessionsDir)) {
        if ((ctx.indexedSessions?.().length ?? 0) > 0) {
          ctx.reportIncompleteInventory?.({ path: sessionsDir, error: 'Source folder is unavailable' });
        }
        return [];
      }
      let sessionDirs: string[];
      try {
        sessionDirs = listSessionDirs(sessionsDir);
      } catch (error) {
        ctx.reportIncompleteInventory?.(sourceInventoryIssue(sessionsDir, error));
        return [];
      }
      const indexedNativeIds = new Set(
        (ctx.indexedSessions?.() ?? [])
          .map((session) => nativeSessionId(session.sessionId))
          .filter((nativeId): nativeId is string => nativeId !== null),
      );
      const changedDirs = ctx.changedPaths === undefined ? null : changedSessionDirs(sessionsDir, ctx.changedPaths);
      const units: IndexUnit[] = [];
      const seenNativeIds = new Set<string>();
      for (const sessionDir of sessionDirs) {
        const nativeId = sessionDir.split(sep).at(-1)!;
        seenNativeIds.add(nativeId);
        if (changedDirs !== null && !changedDirs.has(sessionDir)) continue;
        const metaPath = join(sessionDir, `${nativeId}.json`);
        const messagesPath = join(sessionDir, `${nativeId}.messages.json`);
        const currentCursor = cursorFor(metaPath, messagesPath);
        if (currentCursor === null) continue;
        const sessionId = namespacedSessionId(nativeId);
        if (changedDirs === null && ctx.lastCursor(sessionDir) === currentCursor) continue;
        units.push({
          key: sessionDir,
          sessionId,
          project: undefined,
          meta: {
            kind: 'session',
            sessionDir,
            metaPath,
            messagesPath,
            currentCursor,
          } satisfies ClineSessionUnitMeta,
        });
      }
      for (const nativeId of indexedNativeIds) {
        if (seenNativeIds.has(nativeId)) continue;
        const sessionId = namespacedSessionId(nativeId);
        units.push({
          key: join(sessionsDir, nativeId),
          sessionId,
          retractSessionIds: [sessionId],
          meta: { kind: 'tombstone' } satisfies ClineTombstoneUnitMeta,
        });
      }
      return units;
    },
    *parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
      const meta = unit.meta as ClineSessionUnitMeta | ClineTombstoneUnitMeta;
      if (meta.kind === 'tombstone') return null; // persist retracts via retractSessionIds
      const before = cursorFor(meta.metaPath, meta.messagesPath);
      if (before === null) throw new Error(`Cline session unreadable: ${meta.sessionDir}`);
      const metaRecord = JSON.parse(readFileSync(meta.metaPath, 'utf8')) as JsonRecord;
      const transcript = JSON.parse(readFileSync(meta.messagesPath, 'utf8')) as JsonRecord;
      const after = cursorFor(meta.metaPath, meta.messagesPath);
      if (before !== after) throw new Error(`Cline session changed while indexing: ${meta.sessionDir}`);

      const projected = projectSession(
        unit.sessionId,
        metaRecord,
        transcript,
        meta.messagesPath,
        unit.project ?? projectSlugFromPath(sessionRoot(metaRecord)),
      );
      yield { kind: 'delete-session', sessionId: unit.sessionId };
      yield projected[projected.length - 1]!;
      yield* projected.slice(0, -1);
      return meta.currentCursor;
    },
    raw(input: RawLookup): RawRecord | null {
      const messagesPath = typeof input.session?.jsonl_path === 'string' ? input.session.jsonl_path : null;
      if (messagesPath === null) return null;
      // uuid shape: cline:<nativeSessionId>:<messageId>:b<blockIndex>
      const segments = input.messageUuid.split(':');
      if (segments.length < 3 || segments[0] !== 'cline') return null;
      return rawMessage(messagesPath, segments[2]!);
    },
  };
}

export const clineProvider = createClineProvider();
