// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createQoderProvider } from '../packages/core/src/providers/qoder.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { persist } from '../packages/core/src/persist.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const FIXTURE_HOME = fileURLToPath(new URL('./fixtures/qoder/home', import.meta.url));

const RICH = '4b757031-4888-4f81-a7b6-13381d54ca11'; // owns the real Plan subagent
const SMALL = '7094e97f-ccd9-446a-aa8a-0de882144280';
const INTL = '322d97de-3389-4b4f-9e5a-c1c9cbc99ded';

function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) {
    values.push(step.value);
    step = gen.next();
  }
  return { values, ret: step.value };
}

function stageFixtureHome(prefix) {
  const home = makeTempDir(prefix);
  cpSync(FIXTURE_HOME, home, { recursive: true });
  // The provider root is the CN install dir; the intl install and the GUI
  // databases sit relative to it, mirroring the real home layout.
  return { home, root: join(home, '.qoder-cn') };
}

function cnDbPath(home) {
  return join(home, 'AppData', 'Roaming', 'com.qodercn.app.stable', 'main.sqlite');
}

function intlDbPath(home) {
  return join(home, 'AppData', 'Roaming', 'com.qoder.app.stable', 'main.sqlite');
}

test('qoder provider discovers sessions across both installs with stable cursors', () => {
  const { root } = stageFixtureHome('obelisk-qoder-discover-');
  const provider = createQoderProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => null });

  assert.deepEqual(units.map((unit) => unit.sessionId).sort(), [
    `qoder:${INTL}`,
    `qoder:${RICH}`,
    `qoder:${SMALL}`,
  ]);
  for (const unit of units) {
    assert.match(unit.meta.currentCursor, /^\d+:\d+(\.\d+)?:\d+$/);
  }

  const unchanged = provider.discover({
    lastCursor: (key) => units.find((unit) => unit.key === key)?.meta.currentCursor ?? null,
  });
  assert.deepEqual(unchanged, []);
});

test('qoder provider projects the rich session with tools and folds the Plan subagent', () => {
  const { root } = stageFixtureHome('obelisk-qoder-parse-');
  const provider = createQoderProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })
    .find((candidate) => candidate.sessionId === `qoder:${RICH}`);
  const { values, ret } = drain(provider.parse(unit, null));
  const byKind = (kind) => values.filter((record) => record.kind === kind);

  assert.equal(values[0].kind, 'delete-session');
  assert.equal(ret, unit.meta.currentCursor);

  const session = byKind('session')[0];
  assert.deepEqual(
    (({ id, title, countMode, source, message_count, jsonl_path }) => (
      { id, title, countMode, source, message_count }
    ))(session),
    {
      id: `qoder:${RICH}`,
      title: 'Obsidian Vault整理方案',
      countMode: 'total',
      source: 'qoder',
      message_count: 31,
    },
  );
  assert.match(session.jsonl_path, /projects[\\/].+4b757031-4888-4f81-a7b6-13381d54ca11\.jsonl$/);
  assert.match(session.project, /^-C:-Users-user/);

  // Tool calls attach their results; the failed shortcut-creation Bash keeps
  // its error flag.
  assert.equal(byKind('tool_call').length, byKind('tool_result').length);
  const errored = byKind('tool_result').filter((record) => record.is_error === 1);
  assert.ok(errored.length >= 1, 'expected at least one errored tool result');

  // The subagent folds in as sidechain records; the task manifest supplies
  // the real parent tool call id.
  const subagent = byKind('subagent')[0];
  assert.deepEqual(
    (({ agent_id, session_id, agent_type, description, parent_tool_use_id }) => (
      { agent_id, session_id, agent_type, description, parent_tool_use_id }
    ))(subagent),
    {
      agent_id: `qoder:${RICH}:aPlan-8e8d0184bb853bcd`,
      session_id: `qoder:${RICH}`,
      agent_type: 'Plan',
      description: '评审 Vault 重构设计',
      parent_tool_use_id: `qoder:${RICH}:call_d6d39477240543d0bc157c79`,
    },
  );
  const sideMessages = byKind('message').filter((message) => message.is_sidechain === 1);
  assert.ok(sideMessages.length > 0);
  assert.ok(sideMessages.every((message) => message.agent_id === `qoder:${RICH}:aPlan-8e8d0184bb853bcd`));

  const detail = assembleSessionDetail(values);
  const attached = detail.messages.flatMap((message) => message.tool_calls ?? []);
  assert.ok(attached.length > 0);
  assert.equal(attached.filter((call) => call.result).length, attached.length);
  // Sidechain content stays out of the main timeline.
  assert.equal(detail.messages.some((message) => message.is_sidechain === 1), false);
});

test('qoder canonical records survive a persist round trip (ADR-0007)', () => {
  const { root } = stageFixtureHome('obelisk-qoder-roundtrip-');
  const provider = createQoderProvider({ rootDir: root });
  const smallId = `qoder:${SMALL}`;
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
  assert.equal(persistedDetail.session.title, '根据这个帖子及一些附赠信息，告诉我这个项目的具体情况');
  db.close();
});

test('qoder provider retracts a session deleted from the GUI database', () => {
  const { home, root } = stageFixtureHome('obelisk-qoder-tombstone-');
  const provider = createQoderProvider({ rootDir: root });

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const units = provider.discover({ lastCursor: () => null });
  for (const unit of units) persist(db, unit, provider.parse(unit, null));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 3);

  const remove = new DatabaseSync(cnDbPath(home));
  remove.prepare('UPDATE chat_sessions SET deleted_at = ? WHERE session_id = ?').run(Date.now(), SMALL);
  remove.close();

  const after = provider.discover({
    lastCursor: () => null,
    indexedSessions: () => db.prepare('SELECT id, jsonl_path FROM sessions').all()
      .map((row) => ({ sessionId: row.id, jsonlPath: row.jsonl_path })),
  });
  const tombstone = after.find((unit) => unit.sessionId === `qoder:${SMALL}`);
  assert.deepEqual(tombstone.retractSessionIds, [`qoder:${SMALL}`]);
  persist(db, tombstone, provider.parse(tombstone, null));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 2);
  db.close();
});

test('qoder provider degrades gracefully when a GUI database is unreadable', () => {
  const { home, root } = stageFixtureHome('obelisk-qoder-corrupt-');
  writeFileSync(cnDbPath(home), 'this is not a sqlite database');
  writeFileSync(intlDbPath(home), 'this is not a sqlite database');
  const provider = createQoderProvider({ rootDir: root });

  const issues = [];
  // Transcripts remain the presence truth: sessions still index (with null
  // titles), inventory is reported incomplete, and tombstoning is suppressed.
  const units = provider.discover({
    lastCursor: () => null,
    indexedSessions: () => [{ sessionId: `qoder:${SMALL}`, jsonlPath: join(root, 'x.jsonl') }],
    reportIncompleteInventory(value) { issues.push(value); },
  });
  assert.deepEqual(units.map((unit) => unit.sessionId).sort(), [`qoder:${INTL}`, `qoder:${RICH}`, `qoder:${SMALL}`]);
  assert.ok(units.every((unit) => unit.meta.title === null && unit.meta.dbUpdatedAt === null));
  assert.deepEqual(issues.map(({ path, error }) => ({ path, error })), [
    { path: cnDbPath(home), error: 'Source database is unreadable' },
    { path: intlDbPath(home), error: 'Source database is unreadable' },
  ]);
});

test('qoder raw lookup replays a transcript line by its uuid', () => {
  const { root } = stageFixtureHome('obelisk-qoder-raw-');
  const provider = createQoderProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })
    .find((candidate) => candidate.sessionId === `qoder:${SMALL}`);
  const { values } = drain(provider.parse(unit, null));
  const assistant = values.find((record) => record.kind === 'message' && record.role === 'assistant');
  const raw = provider.raw({
    source: 'qoder',
    messageUuid: assistant.uuid,
    session: { id: unit.sessionId, jsonl_path: unit.meta.jsonlPath },
    agentId: null,
  });
  assert.ok(raw.text.includes('"type"'));
  assert.equal(raw.messageText, assistant.text);
});

test('qoder provider reports a missing install only when sessions were indexed', () => {
  const home = makeTempDir('obelisk-qoder-missing-');
  const provider = createQoderProvider({ rootDir: join(home, '.qoder-cn') });

  const issues = [];
  const context = {
    lastCursor: () => null,
    reportIncompleteInventory(value) { issues.push(value); },
  };
  assert.deepEqual(provider.discover(context), []);
  assert.deepEqual(issues, []);
  assert.deepEqual(provider.discover({
    ...context,
    indexedSessions: () => [{ sessionId: `qoder:${SMALL}`, jsonlPath: '/prior/qoder.jsonl' }],
  }), []);
  assert.deepEqual(issues, [{
    path: join(home, '.qoder-cn'),
    error: 'Source folder is unavailable',
  }]);
});

test('qoder provider reports a non-directory install', () => {
  const home = makeTempDir('obelisk-qoder-enotdir-');
  writeFileSync(join(home, '.qoder-cn'), 'not a directory');
  const provider = createQoderProvider({ rootDir: join(home, '.qoder-cn') });

  const issues = [];
  const units = provider.discover({
    lastCursor: () => null,
    reportIncompleteInventory(value) { issues.push(value); },
  });
  assert.deepEqual(units, []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, join(home, '.qoder-cn'));
  assert.match(issues[0].error, /not a directory/i);
});

test('qoder changedPaths routing emits only the touched session', () => {
  const { root } = stageFixtureHome('obelisk-qoder-routing-');
  const provider = createQoderProvider({ rootDir: root });
  const all = provider.discover({ lastCursor: () => null });
  const smallUnit = all.find((unit) => unit.sessionId === `qoder:${SMALL}`);

  const changed = provider.discover({
    lastCursor: () => null,
    changedPaths: [smallUnit.meta.jsonlPath],
  });
  assert.deepEqual(changed.map((unit) => unit.sessionId), [`qoder:${SMALL}`]);
});

test('qoder changed-mode still skips sessions whose cursor is unchanged', () => {
  const { root } = stageFixtureHome('obelisk-qoder-changed-');
  const provider = createQoderProvider({ rootDir: root });
  const all = provider.discover({ lastCursor: () => null });
  const smallUnit = all.find((unit) => unit.sessionId === `qoder:${SMALL}`);
  const cursors = new Map(all.map((unit) => [unit.key, unit.meta.currentCursor]));

  // Append one line to the small transcript only.
  const line = JSON.stringify({
    type: 'user', uuid: 'test-appended-line', timestamp: '2026-08-29T12:00:00.000Z',
    isSidechain: false, cwd: smallUnit.meta.cwd,
    message: { role: 'user', content: [{ type: 'text', text: 'appended line' }] },
  });
  appendFileSync(smallUnit.meta.jsonlPath, line + '\n');

  const changed = provider.discover({
    lastCursor: (key) => cursors.get(key) ?? null,
    changedPaths: [smallUnit.meta.jsonlPath],
  });
  assert.deepEqual(changed.map((unit) => unit.sessionId), [`qoder:${SMALL}`],
    'the touched session re-indexes; siblings with unchanged cursors are skipped');
});

test('qoder parse throws when the GUI db row changes after discovery', () => {
  const { home, root } = stageFixtureHome('obelisk-qoder-stale-db-');
  const provider = createQoderProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })
    .find((candidate) => candidate.sessionId === `qoder:${SMALL}`);

  const db = new DatabaseSync(cnDbPath(home));
  db.prepare('UPDATE chat_sessions SET title = ?, updated_at = updated_at + 1000 WHERE session_id = ?')
    .run('renamed after discovery', SMALL);
  db.close();

  // The end-of-parse guard recomputes the db half of the cursor and fails the
  // snapshot, so a stale title can never be persisted as up-to-date.
  assert.throws(() => drain(provider.parse(unit, null)), /changed while indexing/);
});
