// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Builds tests/fixtures/zcode/db.sqlite from a real ZCode CLI database.
//
// Usage: node tests/fixtures/zcode/build-fixture.mjs <path-to-real-db>
//
// The fixture keeps two real main sessions (one with an errored Bash tool part
// and a synthetic todo_reminder message, one small plain session) plus one
// hand-crafted subagent_child session — the synthetic stand-in exists because
// the only real child sessions on the source machine are far too large for a
// fixture. All long human-readable strings are sanitized; structure, tool
// names, statuses, timestamps and path shapes are preserved verbatim.

import { cpSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const realDbPath = process.argv[2];
if (!realDbPath) {
  console.error('usage: node tests/fixtures/zcode/build-fixture.mjs <real-db.sqlite>');
  process.exit(1);
}

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(fixtureDir, 'db.sqlite');
const stagingPath = join(fixtureDir, 'db.staging.sqlite');

const KEEP_SESSIONS = [
  'sess_6920b0a8-9cb5-44c1-89a1-816330a9f5c4', // main; error tool part + synthetic reminder
  'sess_b7dcccf8-eb31-4ca5-931f-9cfb4a4ed92d', // small plain main session
];
const CRAFTED_CHILD = 'sess_subagent_agent_fixture000-0000-0000-000000000001';
const KEEP_ALL = [...KEEP_SESSIONS, CRAFTED_CHILD];

const SENSITIVE_KEYS = new Set(['text', 'thinking', 'content', 'output', 'error', 'prompt', 'description']);

function sanitizeString(key, value) {
  if (typeof value !== 'string') return value;
  let out = value.replaceAll('联想', 'user');
  // Provider credentials are short and can sit under arbitrary nested keys, so
  // scrub them by shape before the length-based rules below.
  out = out.replace(/sk-or-v1-[0-9a-f]{40,}/g, '[REDACTED_OPENROUTER_KEY]');
  if (SENSITIVE_KEYS.has(key) && out.length > 40) out = `[${key} sanitized: ${out.length} chars]`;
  else if (out.length > 240) out = `${out.slice(0, 240)}…[truncated]`;
  return out;
}

function sanitizeJson(value, key = '') {
  if (typeof value === 'string') return sanitizeString(key, value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, key));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeJson(v, k);
    return out;
  }
  return value;
}

// 兜底：对库内所有 TEXT 列做用户名替换，覆盖未单独建模的表/列
// （session.directory/path、input_history.text、crafted child 行内的 cwd 等）。
function textColumns(db, table) {
  return db.prepare(`SELECT name, type FROM pragma_table_info('${table}')`).all()
    .filter((col) => /TEXT|CHAR|CLOB/i.test(col.type ?? ''))
    .map((col) => col.name);
}

function replaceUsernameEverywhere(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    .map((row) => row.name);
  for (const table of tables) {
    for (const column of textColumns(db, table)) {
      db.prepare(`UPDATE "${table}" SET "${column}" = REPLACE("${column}", '联想', 'user') WHERE "${column}" LIKE '%联想%'`).run();
    }
  }
  return tables;
}

// 自检：任何 TEXT 列仍残留本机用户名则构建失败（宁缺毋滥）。
function assertNoUsername(db, tables) {
  const leaks = [];
  for (const table of tables) {
    for (const column of textColumns(db, table)) {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" LIKE '%联想%'`).get().n;
      if (n > 0) leaks.push(`${table}.${column}(${n})`);
    }
  }
  if (leaks.length > 0) throw new Error(`fixture 仍残留本机用户名: ${leaks.join(', ')}`);
}

// 字节级兜底自检：BLOB 列与非 UTF-8 编码残留都逃得过 SQL LIKE；产物落盘后
// 读文件 Buffer 按字节扫描，命中即中止构建（与 qoder/cline 脚本同一清单）。
const LEAK_BYTES = [
  ['联想/UTF-8', Buffer.from('联想', 'utf8')],
  ['联想/GBK', Buffer.from([0xC1, 0xAA, 0xCF, 0xEB])],
  ['联想/UTF-16LE', Buffer.from('联想', 'utf16le')],
  ['jinyu/ASCII', Buffer.from('jinyu', 'ascii')],
  // Real provider credentials must never reach a committed fixture. The string
  // sanitizer only rewrites known long-text keys, so keys embedded in nested
  // tool payloads (part.data) survived it once; the byte check is the backstop.
  ['openrouter-key', Buffer.from('sk-or-v1-', 'ascii')],
];
function assertNoLeakBytes(filePath) {
  const buf = readFileSync(filePath);
  for (const [label, needle] of LEAK_BYTES) {
    if (buf.includes(needle)) throw new Error(`fixture 字节级泄漏: ${label} in ${filePath}`);
  }
}


rmSync(stagingPath, { force: true });
// 用 VACUUM INTO 从只读连接做一致性快照：活动库多为 WAL 模式，直接 cpSync
// 主文件会丢 -wal 里的最新事务，拿到撕裂镜像（曾触发 "database disk image
// is malformed"）。VACUUM INTO 在源库读事务内完成，且允许只读连接。
const sourceDb = new DatabaseSync(realDbPath, { readOnly: true });
sourceDb.exec(`VACUUM INTO '${stagingPath.replaceAll('\\', '/')}'`);
sourceDb.close();
const db = new DatabaseSync(stagingPath);

const dropAllExcept = (table, column, keep) => {
  const placeholders = keep.map(() => '?').join(',');
  db.prepare(`DELETE FROM ${table} WHERE ${column} NOT IN (${placeholders})`).run(...keep);
};
for (const table of [
  'message', 'part', 'turn_usage', 'tool_usage', 'model_usage', 'session_entry',
  'todo', 'input_history', 'session_target', 'session_input',
]) {
  dropAllExcept(table, 'session_id', KEEP_ALL);
}
for (const table of [
  'permission', 'local_setting', 'workflow_definition', 'workflow_run',
  'workflow_activity', 'workflow_event', 'session_task_link',
]) {
  db.prepare(`DELETE FROM ${table}`).run();
}
dropAllExcept('session', 'id', KEEP_ALL);

// Sanitize retained message/part JSON payloads in place.
for (const table of ['message', 'part']) {
  const rows = db.prepare(`SELECT rowid, data FROM ${table}`).all();
  const update = db.prepare(`UPDATE ${table} SET data = ? WHERE rowid = ?`);
  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      continue;
    }
    update.run(JSON.stringify(sanitizeJson(parsed)), row.rowid);
  }
}
db.prepare('DELETE FROM session WHERE id = ?').run(CRAFTED_CHILD);

// Crafted subagent_child session following the exact real row shape.
const parent = db.prepare('SELECT * FROM session WHERE id = ?').get(KEEP_SESSIONS[0]);
const childBase = {
  id: CRAFTED_CHILD, project_id: parent.project_id, workspace_id: null,
  parent_id: KEEP_SESSIONS[0], slug: CRAFTED_CHILD,
  directory: parent.directory, path: parent.path, title: 'Fixture child: explore the schema',
  version: parent.version, share_url: null, summary_additions: null, summary_deletions: null,
  summary_files: null, summary_diffs: null, revert: null, permission: null,
  time_created: parent.time_created + 60_000, time_updated: parent.time_created + 120_000,
  time_compacting: null, time_archived: null, task_type: 'subagent_child',
  title_source: 'default', title_message_id: null, time_title_updated: null, trace_id: parent.trace_id,
};
const sessionColumns = Object.keys(childBase);
db.prepare(
  `INSERT INTO session (${sessionColumns.join(',')}) VALUES (${sessionColumns.map(() => '?').join(',')})`,
).run(...sessionColumns.map((c) => childBase[c]));

const childMessages = [
  {
    id: 'msg_fixchild_1', seq: 0, role: 'user',
    data: {
      role: 'user', time: { created: childBase.time_created + 1_000 }, agent: 'zcode-agent',
      contextSnapshot: { envInfo: { cwd: parent.directory } },
    },
  },
  {
    id: 'msg_fixchild_2', seq: 1, role: 'assistant',
    data: {
      role: 'assistant', time: { created: childBase.time_created + 2_000, completed: childBase.time_created + 3_000 },
      parentID: 'msg_fixchild_1', modelID: 'GLM-5.3', providerID: 'builtin:bigmodel-coding-plan',
      mode: 'yolo', agent: 'zcode-agent', path: { cwd: parent.directory, root: parent.directory },
      cost: 0, tokens: { total: 120, input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: 'stop',
    },
  },
];
for (const m of childMessages) {
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?)')
    .run(m.id, CRAFTED_CHILD, childBase.time_created + m.seq, childBase.time_created + m.seq, JSON.stringify(m.data), m.seq);
}
const childParts = [
  { message: 'msg_fixchild_1', seq: 0, data: { type: 'text', text: 'List the tables in the schema.', time: { start: childBase.time_created + 1_000 } } },
  { message: 'msg_fixchild_2', seq: 0, data: { type: 'reasoning', text: 'I will run a sqlite query.', time: { start: childBase.time_created + 2_000 } } },
  { message: 'msg_fixchild_2', seq: 1, data: {
    type: 'tool', callID: 'call_fixture_child_0001', tool: 'Bash',
    state: {
      status: 'completed', input: { command: 'sqlite3 db.sqlite .tables', description: 'list tables' },
      output: 'session  message  part', title: 'Bash',
      time: { start: childBase.time_created + 2_100, end: childBase.time_created + 2_400 },
    },
  } },
  { message: 'msg_fixchild_2', seq: 2, data: { type: 'text', text: 'The schema has three tables.', time: { start: childBase.time_created + 2_500 } } },
];
for (const p of childParts) {
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data, sequence) VALUES (?,?,?,?,?,?,?)')
    .run(`part_fix_${p.message}_${p.seq}`, p.message, CRAFTED_CHILD, childBase.time_created, childBase.time_created, JSON.stringify(p.data), p.seq);
}

// input_history 等长文本按敏感键规则净化（crafted child 插入之后执行，顺带覆盖）
// rowid 显式取别名，避免 INTEGER PRIMARY KEY 别名列改写结果键名
for (const [table, column] of [['session', 'title'], ['input_history', 'text']]) {
  const rows = db.prepare(`SELECT rowid AS ob_rowid, "${column}" AS value FROM "${table}"`).all();
  const update = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`);
  for (const row of rows) update.run(sanitizeString(column, row.value), row.ob_rowid);
}
const allTables = replaceUsernameEverywhere(db);
assertNoUsername(db, allTables);

db.exec('VACUUM');
db.exec('VACUUM');
// 固化为 rollback journal：WAL 模式会在任何读取时生成 -shm/-wal 副车文件，
// 污染 fixture 目录（且可能被误提交）
db.exec('PRAGMA journal_mode=DELETE');
db.close();
rmSync(fixturePath, { force: true });
cpSync(stagingPath, fixturePath);
rmSync(stagingPath, { force: true });
// 清理 staging 的 WAL 副车（源库为 WAL 模式时生成）
rmSync(`${stagingPath}-shm`, { force: true });
rmSync(`${stagingPath}-wal`, { force: true });
// 字节级终检：BLOB 与非 UTF-8 编码残留的兜底
assertNoLeakBytes(fixturePath);

const check = new DatabaseSync(fixturePath, { readOnly: true });
console.log('fixture sessions:', check.prepare('SELECT id, task_type FROM session ORDER BY time_created').all());
console.log('fixture messages:', check.prepare('SELECT COUNT(*) AS n FROM message').get().n);
console.log('fixture parts:', check.prepare('SELECT COUNT(*) AS n FROM part').get().n);
check.close();
console.log('written:', fixturePath);
