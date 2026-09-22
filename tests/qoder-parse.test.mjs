// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createQoderCnProvider, createQoderProvider } from '../packages/core/src/providers/qoder.ts';
import { assembleSessionDetail } from '../packages/core/src/session-detail.ts';
import { persist } from '../packages/core/src/persist.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { makeTempDir } from './temp-dirs.mjs';

const SCHEMA = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const FIXTURE_HOME = fileURLToPath(new URL('./fixtures/qoder/home', import.meta.url));

const RICH = '4b757031-4888-4f81-a7b6-13381d54ca11'; // owns the real Plan subagent, CN
const SMALL = '7094e97f-ccd9-446a-aa8a-0de882144280'; // complete small session, CN
const INTL = '322d97de-3389-4b4f-9e5a-c1c9cbc99ded'; // intl session

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
  // The provider root is each install dir; the GUI db follows as a sibling
  // AppData path, mirroring the real home layout.
  return {
    home,
    cnRoot: join(home, '.qoder-cn'),
    intlRoot: join(home, '.qoder'),
  };
}

function cnDbPath(home) {
  return join(home, 'AppData', 'Roaming', 'com.qodercn.app.stable', 'main.sqlite');
}

function intlDbPath(home) {
  return join(home, 'AppData', 'Roaming', 'com.qoder.app.stable', 'main.sqlite');
}

test('qoder-cn discovers its sessions with stable cursors', () => {
  const { home, cnRoot } = stageFixtureHome('obelisk-qodercn-discover-');
  const provider = createQoderCnProvider({ rootDir: cnRoot, dbPath: cnDbPath(home) });
  const units = provider.discover({ lastCursor: () => null });

  assert.deepEqual(units.map((unit) => unit.sessionId).sort(), [`qoder:${RICH}`, `qoder:${SMALL}`]);
  for (const unit of units) {
    assert.match(unit.meta.currentCursor, /^\d+:\d+(\.\d+)?:\d+:\d+$/);
  }

  const unchanged = provider.discover({
    lastCursor: (key) => units.find((unit) => unit.key === key)?.meta.currentCursor ?? null,
  });
  assert.deepEqual(unchanged, []);
});

test('qoder (intl) discovers only the intl install and stays isolated from qoder-cn', () => {
  const { intlRoot } = stageFixtureHome('obelisk-qoder-intl-');
  const intl = createQoderProvider({ rootDir: intlRoot });
  const intlUnits = intl.discover({ lastCursor: () => null });
  assert.deepEqual(intlUnits.map((unit) => unit.sessionId), [`qoder:${INTL}`]);

  const cn = createQoderCnProvider({ rootDir: join(makeTempDir('obelisk-qoder-cnside-'), '.qoder-cn') });
  assert.deepEqual(cn.discover({ lastCursor: () => null }), [],
    'the CN provider must not see intl sessions and vice versa');
});

test('qoder-cn projects the rich session with tools and folds the Plan subagent', () => {
  const { home, cnRoot } = stageFixtureHome('obelisk-qodercn-parse-');
  const provider = createQoderCnProvider({ rootDir: cnRoot, dbPath: cnDbPath(home) });
  const unit = provider.discover({ lastCursor: () => null })
    .find((candidate) => candidate.sessionId === `qoder:${RICH}`);
  const { values, ret } = drain(provider.parse(unit, null));
  const byKind = (kind) => values.filter((record) => record.kind === kind);

  assert.equal(values[0].kind, 'delete-session');
  assert.equal(ret, unit.meta.currentCursor);

  const session = byKind('session')[0];
  assert.deepEqual(
    (({ id, title, countMode, source, message_count }) => (
      { id, title, countMode, source, message_count }
    ))(session),
    {
      id: `qoder:${RICH}`,
      title: 'Obsidian Vault整理方案',
      countMode: 'total',
      source: 'qoder-cn',
      message_count: 31,
    },
  );

  assert.equal(byKind('tool_call').length, byKind('tool_result').length);
  const errored = byKind('tool_result').filter((record) => record.is_error === 1);
  assert.ok(errored.length >= 1, 'expected at least one errored tool result');

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
  assert.equal(detail.messages.some((message) => message.is_sidechain === 1), false);
});

test('qoder-cn canonical records survive a persist round trip (ADR-0007)', () => {
  const { home, cnRoot } = stageFixtureHome('obelisk-qodercn-roundtrip-');
  const provider = createQoderCnProvider({ rootDir: cnRoot, dbPath: cnDbPath(home) });
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

test('qoder (intl) projects its session with db metadata', () => {
  const { intlRoot } = stageFixtureHome('obelisk-qoder-intl-parse-');
  const provider = createQoderProvider({ rootDir: intlRoot });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));
  const session = values.find((record) => record.kind === 'session');
  assert.equal(session.title, '又一个免费的搜索工具');
  assert.equal(session.source, 'qoder');
  assert.equal(session.message_count, 2);
});

test('qoder-cn retracts a session deleted from the GUI database', () => {
  const { home, cnRoot } = stageFixtureHome('obelisk-qodercn-tombstone-');
  const provider = createQoderCnProvider({ rootDir: cnRoot, dbPath: cnDbPath(home) });

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const units = provider.discover({ lastCursor: () => null });
  for (const unit of units) persist(db, unit, provider.parse(unit, null));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 2);

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
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
  db.close();
});

test('qoder-cn degrades gracefully when its GUI database is unreadable', () => {
  const { home, cnRoot } = stageFixtureHome('obelisk-qodercn-corrupt-');
  writeFileSync(cnDbPath(home), 'this is not a sqlite database');
  const provider = createQoderCnProvider({ rootDir: cnRoot, dbPath: cnDbPath(home) });

  const issues = [];
  // Transcripts remain the presence truth: sessions still index (with null
  // titles), inventory is reported incomplete, and tombstoning is suppressed.
  const units = provider.discover({
    lastCursor: () => null,
    indexedSessions: () => [{ sessionId: `qoder:${SMALL}`, jsonlPath: join(cnRoot, 'x.jsonl') }],
    reportIncompleteInventory(value) { issues.push(value); },
  });
  assert.deepEqual(units.map((unit) => unit.sessionId).sort(), [`qoder:${RICH}`, `qoder:${SMALL}`]);
  assert.ok(units.every((unit) => unit.meta.title === null && unit.meta.dbUpdatedAt === null));
  assert.deepEqual(issues.map(({ path, error }) => ({ path, error })), [
    { path: cnDbPath(home), error: 'Source database is unreadable' },
  ]);
});

test('qoder-cn raw lookup replays a transcript line by its uuid', () => {
  const { home, cnRoot } = stageFixtureHome('obelisk-qodercn-raw-');
  const provider = createQoderCnProvider({ rootDir: cnRoot, dbPath: cnDbPath(home) });
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

test('qoder-cn reports a missing install only when sessions were indexed', () => {
  const home = makeTempDir('obelisk-qodercn-missing-');
  const provider = createQoderCnProvider({ rootDir: join(home, '.qoder-cn') });

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

test('qoder-cn reports a non-directory install', () => {
  const home = makeTempDir('obelisk-qodercn-enotdir-');
  writeFileSync(join(home, '.qoder-cn'), 'not a directory');
  const provider = createQoderCnProvider({ rootDir: join(home, '.qoder-cn') });

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

test('qoder-cn changedPaths routing emits only the touched session', () => {
  const { home, cnRoot } = stageFixtureHome('obelisk-qodercn-routing-');
  const provider = createQoderCnProvider({ rootDir: cnRoot, dbPath: cnDbPath(home) });
  const all = provider.discover({ lastCursor: () => null });
  const smallUnit = all.find((unit) => unit.sessionId === `qoder:${SMALL}`);

  const changed = provider.discover({
    lastCursor: () => null,
    changedPaths: [smallUnit.meta.jsonlPath],
  });
  assert.deepEqual(changed.map((unit) => unit.sessionId), [`qoder:${SMALL}`]);
});

test('qoder-cn changed-mode still skips sessions whose cursor is unchanged', () => {
  const { home, cnRoot } = stageFixtureHome('obelisk-qodercn-changed-');
  const provider = createQoderCnProvider({ rootDir: cnRoot, dbPath: cnDbPath(home) });
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

test('qoder-cn parse throws when the GUI db row changes after discovery', () => {
  const { home, cnRoot } = stageFixtureHome('obelisk-qodercn-stale-db-');
  const provider = createQoderCnProvider({ rootDir: cnRoot, dbPath: cnDbPath(home) });
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

test('qoder (intl) retracts a session deleted from its GUI database', () => {
  const { home, intlRoot } = stageFixtureHome('obelisk-qoder-intl-tomb-');
  const provider = createQoderProvider({ rootDir: intlRoot, dbPath: intlDbPath(home) });

  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const units = provider.discover({ lastCursor: () => null });
  for (const unit of units) persist(db, unit, provider.parse(unit, null));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);

  const remove = new DatabaseSync(intlDbPath(home));
  remove.prepare('UPDATE chat_sessions SET deleted_at = ? WHERE session_id = ?').run(Date.now(), INTL);
  remove.close();

  const after = provider.discover({
    lastCursor: () => null,
    indexedSessions: () => db.prepare('SELECT id, jsonl_path FROM sessions').all()
      .map((row) => ({ sessionId: row.id, jsonlPath: row.jsonl_path })),
  });
  const tombstone = after.find((unit) => unit.sessionId === `qoder:${INTL}`);
  assert.deepEqual(tombstone.retractSessionIds, [`qoder:${INTL}`]);
  persist(db, tombstone, provider.parse(tombstone, null));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  db.close();
});

test('registry raw lookup dispatches by session source across the split providers', () => {
  const { home, cnRoot, intlRoot } = stageFixtureHome('obelisk-qoder-rawdispatch-');
  const registry = createProviderRegistry([
    createQoderCnProvider({ rootDir: cnRoot, dbPath: cnDbPath(home) }),
    createQoderProvider({ rootDir: intlRoot, dbPath: intlDbPath(home) }),
  ]);

  const cnAssistant = drain((() => {
    const provider = createQoderCnProvider({ rootDir: cnRoot, dbPath: cnDbPath(home) });
    const unit = provider.discover({ lastCursor: () => null })
      .find((candidate) => candidate.sessionId === `qoder:${SMALL}`);
    return provider.parse(unit, null);
  })()).values.find((record) => record.kind === 'message' && record.role === 'assistant');
  const intlAssistant = drain((() => {
    const provider = createQoderProvider({ rootDir: intlRoot, dbPath: intlDbPath(home) });
    const unit = provider.discover({ lastCursor: () => null })[0];
    return provider.parse(unit, null);
  })()).values.find((record) => record.kind === 'message' && record.role === 'assistant');

  const cnRaw = registry.raw({
    source: 'qoder-cn', messageUuid: cnAssistant.uuid,
    session: { id: cnAssistant.session_id, jsonl_path: unit_jsonl(join(cnRoot, 'projects'), SMALL) }, agentId: null,
  });
  assert.equal(cnRaw.messageText, cnAssistant.text);
  const intlRaw = registry.raw({
    source: 'qoder', messageUuid: intlAssistant.uuid,
    session: { id: intlAssistant.session_id, jsonl_path: unit_jsonl(join(intlRoot, 'projects'), INTL) }, agentId: null,
  });
  assert.equal(intlRaw.messageText, intlAssistant.text);
});

function unit_jsonl(projectsDir, sessionId) {
  for (const slug of readdirSync(projectsDir)) {
    const candidate = join(projectsDir, slug, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`transcript not found: ${sessionId}`);
}

test('qoder (intl) changedPaths routing emits only the touched session', () => {
  const { home, intlRoot } = stageFixtureHome('obelisk-qoder-intl-routing-');
  const provider = createQoderProvider({ rootDir: intlRoot, dbPath: intlDbPath(home) });
  const all = provider.discover({ lastCursor: () => null });
  const intlUnit = all.find((unit) => unit.sessionId === `qoder:${INTL}`);

  const changed = provider.discover({
    lastCursor: () => null,
    changedPaths: [intlUnit.meta.jsonlPath],
  });
  assert.deepEqual(changed.map((unit) => unit.sessionId), [`qoder:${INTL}`]);
});
