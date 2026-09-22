// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Qoder provider adapters (see docs/adr/0001).
//
// Qoder (Alibaba's agentic IDE) ships an agent SDK whose transcripts are
// Claude-Code-style append-only JSONL under `~/.qoder[-cn]/projects/<cwd-slug>/
// <session-id>.jsonl`, with subagent transcripts in a sibling `<session-id>/
// subagents/` directory (`task-*.json` manifest + `agent-*.jsonl`). Display
// metadata (title, cwd, model, archived/deleted) lives in the GUI database
// `<home>/AppData/Roaming/com.qoder[.cn|.app.stable]/main.sqlite`
// (`chat_sessions`, epoch-ms timestamps).
//
// Two installs, two providers: `qoder-cn` (~/.qoder-cn) and `qoder`
// (~/.qoder). Each is a home subdirectory, so the app's home-relocation of
// provider defaults relocates the whole layout. Session ids share the
// `qoder:<uuid>` namespace (UUIDs are globally unique); the `source` column
// distinguishes the installs. The unit is the session, keyed by its
// transcript path, full snapshot per parse (cline's model) with the freshness
// guard running after the yields.
//
// Projection: text/thinking blocks become separate message records, tool
// calls/results ride the emitting record, user lines that carry ONLY
// tool_result blocks are result transports. Subagent transcripts fold into
// the parent session as sidechain records; the task manifest supplies the
// real parent_tool_use_id. Known limitations: the JSONL is a parentUuid tree
// with `active-leaf` bookkeeping — branches are linearized in file order;
// `automationExecution` (Quest) sessions are indexed as ordinary sessions.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { filePath, projectSlugFromPath, sourceInventoryIssue, trunc, truncJson } from '../parsing.ts';

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

export const QODER_CANONICAL_TRANSCRIPT_MARKER = '__qoder_canonical_transcript_v1__';

interface QoderInstallSpec {
  readonly name: 'qoder' | 'qoder-cn';
  readonly displayName: string;
  readonly color: string;
  readonly appId: string;
  readonly installDir: string;
  readonly dbPath: string;
}

function qoderCnInstall(): QoderInstallSpec {
  return {
    name: 'qoder-cn',
    displayName: 'Qoder CN',
    color: '#e0533d',
    appId: 'com.qodercn.app.stable',
    installDir: join(homedir(), '.qoder-cn'),
    dbPath: join(homedir(), 'AppData', 'Roaming', 'com.qodercn.app.stable', 'main.sqlite'),
  };
}

function qoderIntlInstall(): QoderInstallSpec {
  return {
    name: 'qoder',
    displayName: 'Qoder',
    color: '#2e8b57',
    appId: 'com.qoder.app.stable',
    installDir: join(homedir(), '.qoder'),
    dbPath: join(homedir(), 'AppData', 'Roaming', 'com.qoder.app.stable', 'main.sqlite'),
  };
}

// Tests relocate the install by passing both rootDir and dbPath together.
// A rootDir-only override (settings UI) also derives the db from the new
// root's sibling AppData — if that db is not there the provider degrades
// gracefully (null titles, tombstones suppressed), never a crash.
function withRoot(base: QoderInstallSpec, overrides: { rootDir?: string; dbPath?: string } = {}): QoderInstallSpec {
  if (!overrides.rootDir && !overrides.dbPath) return base;
  const installDir = overrides.rootDir ?? base.installDir;
  const dbPath = overrides.dbPath
    ?? (overrides.rootDir
      ? join(dirname(overrides.rootDir), 'AppData', 'Roaming', base.appId, 'main.sqlite')
      : base.dbPath);
  return { ...base, installDir, dbPath };
}

const SKIP_LINE_TYPES = new Set([
  'workspace-directories', 'runtime-config', 'active-leaf', 'attachment', 'last-prompt',
]);

interface QoderSessionUnitMeta {
  readonly kind: 'session';
  readonly jsonlPath: string;
  readonly dbPath: string;
  readonly sessionDir: string;
  readonly nativeId: string;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly model: string | null;
  readonly dbUpdatedAt: number | null;
  readonly currentCursor: Exclude<Cursor, null>;
}

function namespacedSessionId(nativeId: string): string {
  return `qoder:${nativeId}`;
}

function nativeSessionId(sessionId: string): string | null {
  return sessionId.startsWith('qoder:') ? sessionId.slice('qoder:'.length) : null;
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

function inputUsage(usage: unknown): number | null {
  if (usage === null || typeof usage !== 'object') return null;
  const record = usage as JsonRecord;
  const fields = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_read_tokens', 'cache_creation_tokens'];
  const values = fields.map((field) => record[field]);
  if (!values.some((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  return values.reduce<number>((sum, value) => sum + (typeof value === 'number' && Number.isFinite(value) ? value : 0), 0);
}

function toolResultText(content: unknown): { text: string; errored: boolean } {
  if (typeof content === 'string') return { text: trunc(content), errored: false };
  if (Array.isArray(content)) {
    const lines: string[] = [];
    let errored = false;
    for (const item of content) {
      if (item === null || typeof item !== 'object') continue;
      if (item.success === false) errored = true;
      const text = typeof item.text === 'string' ? item.text : null;
      lines.push(text ?? truncJson(item) ?? '');
    }
    return { text: trunc(lines.join('\n')), errored };
  }
  if (content === null || content === undefined) return { text: '', errored: false };
  return { text: truncJson(content) ?? '', errored: false };
}

interface InstallDbInfo {
  readonly updated_at: number | null;
  readonly deleted: boolean;
  readonly title: string | null;
  readonly cwd: string | null;
  readonly model: string | null;
}

function readSessions(dbPath: string): Map<string, InstallDbInfo> | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const out = new Map<string, InstallDbInfo>();
    for (const row of db.prepare('SELECT session_id, updated_at, deleted_at, title, cwd, model FROM chat_sessions').all()) {
      out.set(String(row.session_id), {
        updated_at: row.updated_at === null || row.updated_at === undefined ? null : Number(row.updated_at),
        deleted: row.deleted_at !== null && row.deleted_at !== undefined,
        title: row.title === null || row.title === undefined ? null : String(row.title),
        cwd: row.cwd === null || row.cwd === undefined ? null : String(row.cwd),
        model: row.model === null || row.model === undefined ? null : String(row.model),
      });
    }
    return out;
  } catch {
    return null; // torn/corrupt database: fail closed, report incomplete
  } finally {
    db.close();
  }
}

function dbUpdatedAt(info: InstallDbInfo | undefined): number | null {
  return info?.updated_at ?? null;
}

function transcriptStat(jsonlPath: string): { mtimeMs: number; size: number; ino: number } | null {
  try {
    const stat = statSync(jsonlPath);
    return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
  } catch {
    return null;
  }
}

function cursorFor(dbUpdated: number | null, jsonlPath: string): Exclude<Cursor, null> | null {
  const stat = transcriptStat(jsonlPath);
  if (stat === null) return null;
  return `${dbUpdated ?? 0}:${stat.mtimeMs}:${stat.size}:${stat.ino}`;
}

function findTranscript(projectsDir: string, nativeId: string): string | null {
  let slugs: string[];
  try {
    slugs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const candidate = join(projectsDir, slug, `${nativeId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function* projectTranscript(
  recordSource: string,
  transcriptPath: string,
  sessionId: string,
  nativeId: string,
  agentId: string | null,
): Generator<TranscriptRecord, { firstTs: string | null; lastTs: string | null; visibleCount: number; totalTokens: number }> {
  const records: TranscriptRecord[] = [];
  const callOwnerUuids = new Map<string, string>();
  let previousUuid: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let visibleCount = 0;
  let totalTokens = 0;
  const fallbackAgentId = agentId;
  // Merge helper keeps TS from narrowing `current` to never at first bump.
  const mergeTs = (current: string | null, candidate: string, pickMin: boolean): string =>
    current === null || (pickMin ? candidate < current : candidate > current) ? candidate : current;

  const lines = readFileSync(transcriptPath, 'utf8').split('\n');
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let event: JsonRecord;
    try {
      event = JSON.parse(line) as JsonRecord;
    } catch {
      continue; // torn tail line: stat participates in the cursor anyway
    }
    const type = typeof event.type === 'string' ? event.type : null;
    if (type === null || SKIP_LINE_TYPES.has(type)) continue;
    if (type !== 'user' && type !== 'assistant') continue;
    const message = event.message ?? {};
    const blocks = contentBlocks(message.content);
    const timestamp = normalizeTime(event.timestamp);
    if (timestamp !== null) {
      firstTs = mergeTs(firstTs, timestamp, true);
      lastTs = mergeTs(lastTs, timestamp, false);
    }
    const lineAgentId = typeof event.agentId === 'string' ? event.agentId : fallbackAgentId;
    const isSidechain: 0 | 1 = event.isSidechain === true || lineAgentId !== null ? 1 : 0;
    const model = typeof message.model === 'string' ? message.model : null;
    const usage = message.usage as JsonRecord | undefined;
    const cwd = typeof event.cwd === 'string' ? event.cwd : null;

    const toolResults = blocks.filter((block) => block.type === 'tool_result');
    const isResultCarrier = blocks.length > 0 && toolResults.length === blocks.length;
    const baseUuid = `qoder:${nativeId}:${String(event.uuid ?? timestamp ?? 'unknown')}`;

    if (isResultCarrier) {
      for (const block of toolResults) {
        const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
        if (callId === null) continue;
        const { text, errored } = toolResultText(block.content);
        records.push({
          kind: 'tool_result',
          tool_use_id: `qoder:${nativeId}:${callId}`,
          message_uuid: callOwnerUuids.get(callId) ?? baseUuid,
          session_id: sessionId,
          content: text,
          file_path: null,
          is_error: (block.is_error === true || errored) ? 1 : 0,
        });
      }
      continue;
    }

    const emit = (text: string, contentType: string, index: number): string => {
      const uuid = `${baseUuid}:b${index}`;
      records.push({
        kind: 'message',
        uuid,
        session_id: sessionId,
        type: message.role ?? type,
        parent_uuid: previousUuid,
        timestamp,
        role: message.role ?? type,
        text: trunc(text),
        content_type: contentType,
        is_meta: 0,
        visibility: 'visible',
        model,
        is_sidechain: isSidechain,
        agent_id: lineAgentId === null ? null : `qoder:${nativeId}:${lineAgentId}`,
        input_tokens: index === 0 ? inputUsage(usage) : null,
        output_tokens: index === 0 && typeof usage?.output_tokens === 'number' ? usage.output_tokens : null,
        cwd,
        skill: null,
        source: recordSource,
      });
      previousUuid = uuid;
      return uuid;
    };

    let primaryUuid: string | null = null;
    let emitted = 0;
    for (const block of blocks) {
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
        primaryUuid = emit(block.thinking, 'thinking', emitted++);
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        primaryUuid = emit(block.text, 'text', emitted++);
      }
    }
    if (primaryUuid === null) {
      // A line with nothing renderable contributes no records at all; a
      // tool-use-only line still needs its visible anchor record.
      const hasToolUse = blocks.some((block) => block.type === 'tool_use' && typeof block.id === 'string');
      if (!hasToolUse && toolResults.length === 0) continue;
      primaryUuid = emit('', 'tool_use', 0);
    }
    if (isSidechain === 0) visibleCount += 1;
    totalTokens += (inputUsage(usage) ?? 0) + (typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0);

    for (const block of blocks) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        const name = typeof block.name === 'string' ? block.name : 'tool';
        const input = block.input ?? {};
        records.push({
          kind: 'tool_call',
          id: `qoder:${nativeId}:${block.id}`,
          message_uuid: primaryUuid,
          session_id: sessionId,
          name,
          presentation: name === 'Skill' ? 'skill' : 'default',
          input_json: truncJson(input) ?? '{}',
          file_path: filePath(name, input),
        });
        callOwnerUuids.set(block.id, primaryUuid);
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const { text, errored } = toolResultText(block.content);
        records.push({
          kind: 'tool_result',
          tool_use_id: `qoder:${nativeId}:${block.tool_use_id}`,
          message_uuid: callOwnerUuids.get(block.tool_use_id) ?? primaryUuid,
          session_id: sessionId,
          content: text,
          file_path: null,
          is_error: (block.is_error === true || errored) ? 1 : 0,
        });
      }
    }
  }
  yield* records;
  return { firstTs, lastTs, visibleCount, totalTokens };
}

function rawLine(transcriptPath: string, lineUuid: string): RawRecord | null {
  if (!existsSync(transcriptPath)) return null;
  for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    let event: JsonRecord;
    try {
      event = JSON.parse(line) as JsonRecord;
    } catch {
      continue;
    }
    if (event.uuid !== lineUuid) continue;
    const parts = contentBlocks(event.message?.content)
      .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : null)
        ?? (block.type === 'thinking' && typeof block.thinking === 'string' ? block.thinking : null))
      .filter((value): value is string => value !== null);
    const payload = JSON.stringify(event);
    return {
      text: payload,
      totalLength: payload.length,
      offset: 0,
      limit: payload.length,
      hasMore: false,
      messageText: parts.length > 0 ? parts.join('\n') : null,
    };
  }
  return null;
}

function changedPathsTouch(root: string, changedPaths: readonly string[], targets: readonly string[]): boolean {
  for (const changedPath of changedPaths) {
    const absolute = isAbsolute(changedPath) ? normalize(changedPath) : normalize(join(root, changedPath));
    for (const target of targets) {
      if (absolute === target) return true;
      if (absolute.startsWith(target + sep)) return true;
    }
  }
  return false;
}

export function createQoderInstallProvider(spec: QoderInstallSpec): ProviderAdapter {
  const name = spec.name;
  return {
    name,
    descriptor: { id: name, name: spec.displayName, vendor: 'Alibaba', defaultRoot: spec.installDir, color: spec.color },
    indexVersionMarker: QODER_CANONICAL_TRANSCRIPT_MARKER,
    watchTargets: (configuredRoot) => {
      void configuredRoot;
      return [
        { kind: 'tree' as const, path: join(spec.installDir, 'projects') },
        { kind: 'file' as const, path: spec.dbPath },
      ];
    },
    discover(ctx: DiscoverContext): IndexUnit[] {
      const indexedNativeIds = new Set(
        (ctx.indexedSessions?.() ?? [])
          .map((session) => nativeSessionId(session.sessionId))
          .filter((nativeId): nativeId is string => nativeId !== null),
      );
      const units: IndexUnit[] = [];
      const liveNativeIds = new Set<string>();
      let inventoryComplete = true;

      const installDir = spec.installDir;
      const dbPath = spec.dbPath;
      let installState: 'missing' | 'not-directory' | 'directory';
      try {
        installState = statSync(installDir).isDirectory() ? 'directory' : 'not-directory';
      } catch {
        installState = 'missing';
      }
      if (installState !== 'directory') {
        if (installState === 'not-directory') {
          inventoryComplete = false;
          ctx.reportIncompleteInventory?.({ path: installDir, error: 'Source path is not a directory' });
        } else if ((ctx.indexedSessions?.().length ?? 0) > 0) {
          // Convention: a missing source is an issue only when sessions were
          // previously indexed.
          inventoryComplete = false;
          ctx.reportIncompleteInventory?.({ path: installDir, error: 'Source folder is unavailable' });
        }
      } else {
        discoverInstall();
      }
      if (inventoryComplete) {
        for (const nativeId of indexedNativeIds) {
          if (liveNativeIds.has(nativeId)) continue;
          const sessionId = namespacedSessionId(nativeId);
          units.push({
            key: `${dbPath}#${sessionId}`,
            sessionId,
            retractSessionIds: [sessionId],
            meta: { kind: 'tombstone' },
          });
        }
      }
      return units;

      function discoverInstall() {
        const projectsDir = join(installDir, 'projects');
        const sessions = existsSync(dbPath) ? readSessions(dbPath) : null;
        if (sessions === null && existsSync(dbPath)) {
          inventoryComplete = false;
          ctx.reportIncompleteInventory?.({ path: dbPath, error: 'Source database is unreadable' });
        }
        const dbKnown = sessions ?? new Map<string, InstallDbInfo>();
        const dbLiveNativeIds = new Set(
          [...dbKnown.entries()].filter(([, info]) => !info.deleted).map(([id]) => id),
        );
        // JSONL transcripts are the presence truth for sessions the GUI db
        // does not know yet; sessions the db marks deleted are not resurrected.
        const jsonlNativeIds = new Set<string>();
        const jsonlBySession = new Map<string, string>();
        if (existsSync(projectsDir)) {
          let slugs: string[];
          try {
            slugs = readdirSync(projectsDir);
          } catch (error) {
            inventoryComplete = false;
            ctx.reportIncompleteInventory?.(sourceInventoryIssue(projectsDir, error));
            return;
          }
          for (const slug of slugs) {
            const slugDir = join(projectsDir, slug);
            let entries: string[];
            try {
              entries = readdirSync(slugDir);
            } catch {
              continue;
            }
            for (const entry of entries) {
              if (!entry.endsWith('.jsonl')) continue;
              const nativeId = entry.slice(0, -'.jsonl'.length);
              const jsonlPath = join(slugDir, entry);
              jsonlNativeIds.add(nativeId);
              jsonlBySession.set(nativeId, jsonlPath);
            }
          }
        }
        for (const nativeId of dbLiveNativeIds) liveNativeIds.add(nativeId);
        for (const nativeId of jsonlNativeIds) {
          if (!dbKnown.has(nativeId)) liveNativeIds.add(nativeId);
        }

        // Only a GUI-database event re-scan touches every session of the
        // install; transcript events are routed per session below.
        const dbTouched = ctx.changedPaths !== undefined
          && changedPathsTouch(installDir, ctx.changedPaths, [normalize(dbPath)]);
        for (const nativeId of liveNativeIds) {
          const jsonlPath = jsonlBySession.get(nativeId)
            ?? (dbLiveNativeIds.has(nativeId) ? findTranscript(projectsDir, nativeId) : null);
          if (jsonlPath === null) continue;
          const info = dbKnown.get(nativeId);
          const cursor = cursorFor(dbUpdatedAt(info), jsonlPath);
          if (cursor === null) continue;
          const sessionId = namespacedSessionId(nativeId);
          const key = jsonlPath;
          // Cursor check runs in every mode: a watch event on one transcript
          // must not re-parse every sibling session of the install.
          if (ctx.lastCursor(key) === cursor) continue;
          if (ctx.changedPaths !== undefined && !dbTouched) {
            const touched = changedPathsTouch(installDir, ctx.changedPaths, [
              normalize(jsonlPath),
              normalize(join(dirname(jsonlPath), nativeId)),
            ]);
            if (!touched) continue;
          }
          units.push({
            key,
            sessionId,
            project: undefined,
            meta: {
              kind: 'session',
              jsonlPath,
              dbPath,
              sessionDir: join(dirname(jsonlPath), nativeId),
              nativeId,
              title: info?.title ?? null,
              cwd: info?.cwd ?? null,
              model: info?.model ?? null,
              dbUpdatedAt: dbUpdatedAt(info),
              currentCursor: cursor,
            } satisfies QoderSessionUnitMeta,
          });
        }
      }
    },
    *parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
      const meta = unit.meta as QoderSessionUnitMeta | { kind: 'tombstone' };
      if (meta.kind === 'tombstone') return null; // persist retracts via retractSessionIds
      const before = cursorFor(meta.dbUpdatedAt, meta.jsonlPath);
      if (before === null || before !== meta.currentCursor) {
        throw new Error(`Qoder session changed or unreadable: ${meta.jsonlPath}`);
      }
      yield { kind: 'delete-session', sessionId: unit.sessionId };

      const main = yield* projectTranscript(name, meta.jsonlPath, unit.sessionId, meta.nativeId, null);

      // Subagent transcripts fold into the parent session; the task manifest
      // carries the real parent tool call.
      const subagentsDir = join(meta.sessionDir, 'subagents');
      let firstTs = main.firstTs;
      let lastTs = main.lastTs;
      if (existsSync(subagentsDir)) {
        for (const entry of readdirSync(subagentsDir)) {
          if (!entry.startsWith('task-') || !entry.endsWith('.json')) continue;
          let manifest: JsonRecord;
          try {
            manifest = JSON.parse(readFileSync(join(subagentsDir, entry), 'utf8')) as JsonRecord;
          } catch {
            continue;
          }
          const agentId = typeof manifest.agentId === 'string' ? manifest.agentId : null;
          if (agentId === null) continue;
          const agentTranscript = join(subagentsDir, `agent-${agentId}.jsonl`);
          if (!existsSync(agentTranscript)) continue;
          const child = yield* projectTranscript(
            name,
            agentTranscript,
            unit.sessionId,
            meta.nativeId,
            agentId,
          );
          if (child.firstTs !== null) firstTs = firstTs === null || child.firstTs < firstTs ? child.firstTs : firstTs;
          if (child.lastTs !== null) lastTs = lastTs === null || child.lastTs > lastTs ? child.lastTs : lastTs;
          yield {
            kind: 'subagent',
            agent_id: `qoder:${meta.nativeId}:${agentId}`,
            session_id: unit.sessionId,
            parent_tool_use_id: typeof manifest.parentToolUseId === 'string'
              ? `qoder:${meta.nativeId}:${manifest.parentToolUseId}`
              : null,
            agent_type: typeof manifest.agentType === 'string' ? manifest.agentType : null,
            description: typeof manifest.description === 'string' ? manifest.description : null,
            duration_ms: child.firstTs !== null && child.lastTs !== null
              ? Date.parse(child.lastTs) - Date.parse(child.firstTs)
              : null,
            total_tokens: child.totalTokens,
          };
        }
      }

      // Title/project come from the GUI db (captured at discover time); the
      // transcript is the presence truth for everything else.
      yield {
        kind: 'session',
        id: unit.sessionId,
        title: meta.title,
        project: unit.project ?? projectSlugFromPath(meta.cwd),
        started_at: normalizeTime(firstTs),
        ended_at: normalizeTime(lastTs),
        git_branch: null,
        version: null,
        message_count: main.visibleCount,
        countMode: 'total',
        jsonl_path: meta.jsonlPath,
        source: name,
      };
      const after = cursorFor(
        readSessions(meta.dbPath)?.get(meta.nativeId)?.updated_at ?? meta.dbUpdatedAt,
        meta.jsonlPath,
      );
      if (after !== meta.currentCursor) {
        throw new Error(`Qoder session changed while indexing: ${meta.jsonlPath}`);
      }
      return meta.currentCursor;
    },
    raw(input: RawLookup): RawRecord | null {
      // uuid shape: qoder:<nativeSessionId>:<lineUuid>[:b<index>]
      const segments = input.messageUuid.split(':');
      if (segments.length < 3 || segments[0] !== 'qoder') return null;
      const lineUuid = segments[2]!;
      if (input.agentId !== null && input.agentId !== undefined) {
        const agentId = input.agentId.split(':').at(-1);
        const sessionId = typeof input.session?.id === 'string' ? input.session.id : null;
        const mainPath = typeof input.session?.jsonl_path === 'string' ? input.session.jsonl_path : null;
        const nativeId = sessionId !== null ? nativeSessionId(sessionId) : null;
        if (mainPath !== null && nativeId !== null && agentId !== undefined) {
          const sessionDir = join(dirname(mainPath), nativeId, 'subagents');
          return rawLine(join(sessionDir, `agent-${agentId}.jsonl`), lineUuid);
        }
      }
      const mainPath = typeof input.session?.jsonl_path === 'string' ? input.session.jsonl_path : null;
      if (mainPath === null) return null;
      return rawLine(mainPath, lineUuid);
    },
  };
}

export function createQoderCnProvider(overrides: { rootDir?: string; dbPath?: string } = {}): ProviderAdapter {
  return createQoderInstallProvider(withRoot(qoderCnInstall(), overrides));
}

export function createQoderProvider(overrides: { rootDir?: string; dbPath?: string } = {}): ProviderAdapter {
  return createQoderInstallProvider(withRoot(qoderIntlInstall(), overrides));
}
