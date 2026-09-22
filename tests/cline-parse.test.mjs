// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createClineProvider } from '../packages/core/src/providers/cline.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { persist } from '../packages/core/src/persist.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const FIXTURE_SESSIONS = fileURLToPath(new URL('./fixtures/cline/sessions', import.meta.url));

const RICH = '1787458927083_fgec4';
const SMALL = '1787732507956_vkafw';
const MINIMAL = '1787801982963_3fnb7';

function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) {
    values.push(step.value);
    step = gen.next();
  }
  return { values, ret: step.value };
}

function stageFixtureRoot(prefix) {
  const root = makeTempDir(prefix);
  mkdirSync(join(root, 'sessions'));
  cpSync(FIXTURE_SESSIONS, join(root, 'sessions'), { recursive: true });
  return root;
}

test('cline provider discovers fixture session directories with stable cursors', () => {
  const root = stageFixtureRoot('obelisk-cline-discover-');
  const provider = createClineProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => null });

  assert.deepEqual(
    units.map((unit) => unit.sessionId).sort(),
    [`cline:${MINIMAL}`, `cline:${RICH}`, `cline:${SMALL}`].sort(),
  );
  for (const unit of units) {
    assert.equal(unit.key, join(root, 'sessions', unit.sessionId.slice('cline:'.length)));
    assert.match(unit.meta.currentCursor, /^\d+(\.\d+)?:\d+:\d+(\.\d+)?:\d+$/);
  }

  const unchanged = provider.discover({
    lastCursor: (key) => units.find((unit) => unit.key === key)?.meta.currentCursor ?? null,
  });
  assert.deepEqual(unchanged, []);
});

test('cline provider projects content blocks, tool calls, and results into canonical records', () => {
  const root = stageFixtureRoot('obelisk-cline-parse-');
  const provider = createClineProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })
    .find((candidate) => candidate.sessionId === `cline:${RICH}`);
  const { values, ret } = drain(provider.parse(unit, null));
  const byKind = (kind) => values.filter((record) => record.kind === kind);

  assert.equal(values[0].kind, 'delete-session');
  assert.equal(ret, unit.meta.currentCursor);

  const session = byKind('session')[0];
  assert.deepEqual(
    (({ id, title, project, countMode, source, message_count, version, started_at, ended_at }) => (
      { id, title, project, countMode, source, message_count, version, started_at, ended_at }
    ))(session),
    {
      id: `cline:${RICH}`,
      title: '你是否有全局agent.md的文件？',
      project: '-home-user',
      countMode: 'total',
      source: 'cline',
      message_count: 122,
      version: '3.0.57',
      started_at: '2026-08-23T04:22:07.083Z',
      ended_at: '2026-08-23T06:49:17.288Z',
    },
  );

  // The wrapped first prompt is unwrapped for display.
  const firstUser = byKind('message').find((message) => message.role === 'user');
  assert.equal(firstUser.text, '你是否有全局agent.md的文件？');
  // Thinking and text blocks project as separate records; usage lands on the
  // first block of the message.
  const assistantFirst = byKind('message').find((message) => message.role === 'assistant');
  assert.equal(assistantFirst.content_type, 'thinking');
  assert.match(assistantFirst.text, /^\[thinking sanitized/);
  assert.equal(assistantFirst.input_tokens, 9509);
  assert.match(assistantFirst.uuid, /:b0$/);

  // Every tool call carries a result; results attach to the call's record.
  assert.equal(byKind('tool_call').length, 82);
  assert.equal(byKind('tool_result').length, 82);
  const readCall = byKind('tool_call').find((record) => record.name === 'read_files');
  assert.equal(readCall.file_path, '/mnt/c/Users/user/.wezterm.lua');
  assert.match(readCall.input_json, /wezterm\.lua/);

  // Both block-level is_error and success:false results are flagged.
  const errored = byKind('tool_result').filter((record) => record.is_error === 1);
  assert.ok(errored.length >= 10, `expected flagged errors, got ${errored.length}`);
  assert.ok(errored.every((record) => byKind('tool_result').some((candidate) => candidate.tool_use_id === record.tool_use_id)));

  // Detail assembly keeps results on their calls and result carriers out of
  // the main timeline.
  const detail = assembleSessionDetail(values);
  const attached = detail.messages.flatMap((message) => message.tool_calls ?? []);
  assert.equal(attached.filter((call) => call.result).length, 81);
  assert.equal(detail.messages.some((message) => message.content_type === 'tool_result'), false);
});

test('cline provider indexes the small session end to end (ADR-0007 round trip)', () => {
  const root = stageFixtureRoot('obelisk-cline-roundtrip-');
  const provider = createClineProvider({ rootDir: root });
  const smallId = `cline:${SMALL}`;
  const records = [];
  for (const unit of provider.discover({ lastCursor: () => null })) {
    const { values } = drain(provider.parse(unit, null));
    if (unit.sessionId === smallId) records.push(...values);
  }
  const detail = assembleSessionDetail(records);

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  for (const unit of provider.discover({ lastCursor: () => null })) {
    if (unit.sessionId === smallId) persist(db, unit, provider.parse(unit, null));
  }
  const persistedDetail = assembleSessionDetail({
    session: db.prepare('SELECT * FROM sessions WHERE id = ?').get(smallId),
    messages: db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, uuid').all(smallId),
    toolCalls: db.prepare('SELECT * FROM tool_calls WHERE session_id = ?').all(smallId),
    toolResults: db.prepare('SELECT * FROM tool_results WHERE session_id = ?').all(smallId),
    subagents: [],
    workflows: [],
    summaries: [],
  });
  assert.deepEqual(persistedDetail, detail);
  assert.deepEqual(
    persistedDetail.messages.flatMap((message) => message.tool_calls ?? []).map((call) => call.name),
    ['ask_question', 'run_commands', 'read_files', 'run_commands'],
  );
  // The parent chain crosses message boundaries: within one message text
  // follows thinking; the next message's first record chains onto the
  // previous message's last record.
  const messageRecords = records.filter((record) => record.kind === 'message');
  const blockRecord = (messageId, index) => messageRecords
    .find((record) => record.uuid === `cline:${SMALL}:${messageId}:b${index}`);
  const firstUser = blockRecord('msg_mt9tuh9x_1', 0);
  assert.equal(firstUser.parent_uuid, null);
  const thinking = blockRecord('msg_P55lElF5', 0);
  const text = blockRecord('msg_P55lElF5', 1);
  assert.equal(text.parent_uuid, thinking.uuid);
  assert.equal(thinking.parent_uuid, firstUser.uuid);
  const secondFirst = blockRecord('msg_0R5l5teJ', 0);
  assert.equal(secondFirst.parent_uuid, text.uuid);
  db.close();
});

test('cline provider retracts a session whose directory disappears', () => {
  const root = stageFixtureRoot('obelisk-cline-tombstone-');
  const provider = createClineProvider({ rootDir: root });

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const units = provider.discover({ lastCursor: () => null });
  for (const unit of units) persist(db, unit, provider.parse(unit, null));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 3);

  rmSync(join(root, 'sessions', MINIMAL), { recursive: true, force: true });
  const after = provider.discover({
    lastCursor: () => null,
    indexedSessions: () => db.prepare('SELECT id, jsonl_path FROM sessions').all()
      .map((row) => ({ sessionId: row.id, jsonlPath: row.jsonl_path })),
  });
  const tombstone = after.find((unit) => unit.sessionId === `cline:${MINIMAL}`);
  assert.deepEqual(tombstone.retractSessionIds, [`cline:${MINIMAL}`]);
  persist(db, tombstone, provider.parse(tombstone, null));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 2);
  db.close();
});

test('cline raw lookup replays a message by its native id', () => {
  const root = stageFixtureRoot('obelisk-cline-raw-');
  const provider = createClineProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })
    .find((candidate) => candidate.sessionId === `cline:${MINIMAL}`);
  const { values } = drain(provider.parse(unit, null));
  const assistant = values.find((record) => record.kind === 'message' && record.role === 'assistant');
  const raw = provider.raw({
    source: 'cline',
    messageUuid: assistant.uuid,
    session: { id: unit.sessionId, jsonl_path: assistant.session_id ? join(root, 'sessions', MINIMAL, `${MINIMAL}.messages.json`) : null },
    agentId: null,
  });
  assert.ok(raw.text.includes('"role"'));
  assert.equal(raw.messageText, 'ok');
});
