// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Builds tests/fixtures/qoder/ from a real Qoder install.
//
// Usage: node tests/fixtures/qoder/build-fixture.mjs <home-dir-with-installs>
//
// The fixture root mimics a user home containing both installs:
//   .qoder-cn/projects/<slug>/<session-id>.jsonl  (+ <session-id>/subagents/)
//   .qoder/projects/...                           (intl install)
//   .qoder-cn.sqlite / .qoder.sqlite              (trimmed copies of the
//                                                  installs' main.sqlite)
// Keeps a small complete session (transcript + metadata) and the head of a
// large session that owns a real subagent (task manifest + agent transcript).
// Long human-readable strings are sanitized; structure, roles, tool names,
// statuses, timestamps and usage numbers are preserved verbatim.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const home = process.argv[2];
if (!home) {
  console.error('usage: node tests/fixtures/qoder/build-fixture.mjs <home-dir-containing-.qoder-installs>');
  process.exit(1);
}

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const outRoot = join(fixtureDir, 'home');

const SMALL_SESSION = '7094e97f-ccd9-446a-aa8a-0de882144280'; // complete session, CN
const BIG_SESSION = '4b757031-4888-4f81-a7b6-13381d54ca11'; // owns a real subagent, CN
const INTL_SESSION = '322d97de-3389-4b4f-9e5a-c1c9cbc99ded'; // single near-empty session, intl
const KEEP = new Set([SMALL_SESSION, BIG_SESSION]);

const SENSITIVE_KEYS = new Set(['text', 'thinking', 'input', 'content', 'response', 'result', 'prompt', 'title', 'lastPrompt', 'description']);

function sanitizeString(key, value) {
  if (typeof value !== 'string') return value;
  let out = value.replaceAll('联想', 'user');
  if (SENSITIVE_KEYS.has(key) && out.length > 120) out = `[${key} sanitized: ${out.length} chars]`;
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
// 兜底：对库内所有 TEXT 列做用户名替换，覆盖未单独建模的表/列，
// 保证 schema 漂移或遗漏都不会把本机用户名带进 fixture。
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

// 字节级兜底自检：BLOB 列（如 FTS5 影子表索引块）与非 UTF-8 编码残留都
// 逃得过 SQL LIKE 与 TEXT 兜底；产物落盘后读文件 Buffer 按字节扫描，命中即
// 中止构建。此前"全字节扫描 0 命中"的验证声明因 BLOB 漏检而失真，此处补齐。
const LEAK_BYTES = [
  ['联想/UTF-8', Buffer.from('联想', 'utf8')],
  ['联想/GBK', Buffer.from([0xC1, 0xAA, 0xCF, 0xEB])],
  ['联想/UTF-16LE', Buffer.from('联想', 'utf16le')],
  ['jinyu/ASCII', Buffer.from('jinyu', 'ascii')],
];
function assertNoLeakBytes(filePath) {
  const buf = readFileSync(filePath);
  for (const [label, needle] of LEAK_BYTES) {
    if (buf.includes(needle)) throw new Error(`fixture 字节级泄漏: ${label} in ${filePath}`);
  }
}



rmSync(outRoot, { recursive: true, force: true });

function findSessionFile(installDir, sessionId) {
  const projects = join(home, installDir, 'projects');
  if (!existsSync(projects)) return null;
  for (const slug of readdirSync(projects)) {
    const candidate = join(projects, slug, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function copyTranscript(installDir, sessionId, headLines) {
  const source = findSessionFile(installDir, sessionId);
  if (source === null) throw new Error(`transcript not found: ${sessionId}`);
  const slug = source.split(/[\\/]/).at(-2);
  const targetDir = join(outRoot, installDir, 'projects', slug);
  mkdirSync(targetDir, { recursive: true });
  const lines = readFileSync(source, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  const kept = (headLines === undefined ? lines : lines.slice(0, headLines)).map((line) => (
    JSON.stringify(sanitizeJson(JSON.parse(line)))
  ));
  writeFileSync(join(targetDir, `${sessionId}.jsonl`), kept.join('\n') + '\n');
  return { slug, totalLines: lines.length, keptLines: kept.length };
}

// Session dir (subagents) sits next to the transcript, named by session id.
function copySessionDir(installDir, sessionId, headLines) {
  const source = findSessionFile(installDir, sessionId);
  if (source === null) return;
  const sourceDir = join(dirname(source), sessionId);
  if (!existsSync(sourceDir)) return;
  const targetDir = join(outRoot, installDir, 'projects', source.split(/[\\/]/).at(-2), sessionId);
  mkdirSync(targetDir, { recursive: true });
  const subagents = join(sourceDir, 'subagents');
  if (!existsSync(subagents)) return;
  const targetSubagents = join(targetDir, 'subagents');
  mkdirSync(targetSubagents);
  for (const entry of readdirSync(subagents)) {
    const sourcePath = join(subagents, entry);
    if (entry.endsWith('.jsonl')) {
      const lines = readFileSync(sourcePath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
      const kept = (headLines === undefined ? lines : lines.slice(0, headLines))
        .map((line) => JSON.stringify(sanitizeJson(JSON.parse(line))));
      writeFileSync(join(targetSubagents, entry), kept.join('\n') + '\n');
    } else {
      writeFileSync(join(targetSubagents, entry), JSON.stringify(sanitizeJson(JSON.parse(readFileSync(sourcePath, 'utf8'))), null, 1));
    }
  }
}

function copyMainDb(installDir, appId, keepSessions) {
  const source = join(home, 'AppData', 'Roaming', appId, 'main.sqlite');
  if (!existsSync(source)) return false;
  const dbTargetDir = join(outRoot, 'AppData', 'Roaming', appId);
  mkdirSync(dbTargetDir, { recursive: true });
  const staging = join(outRoot, `${installDir}.staging.sqlite`);
  rmSync(staging, { force: true });
  cpSync(source, staging);
  const db = new DatabaseSync(staging);
  const keep = new Set(keepSessions);
  const idColumn = {
    chat_sessions: 'session_id',
    chat_session_messages: 'session_id',
    chat_session_highlights: 'session_id',
    chat_session_recaps: 'session_id',
    chat_session_context_usage: 'session_id',
    chat_session_search_segments: 'session_id',
    chat_session_sidebar_placements: 'session_id',
    turn_file_change_sets: 'session_id',
  };
  if (keep.size > 0) {
    for (const [table, column] of Object.entries(idColumn)) {
      try {
        const placeholders = [...keep].map(() => '?').join(',');
        db.prepare(`DELETE FROM ${table} WHERE ${column} NOT IN (${placeholders})`).run(...keep);
      } catch {
        // table absent in older schemas: fine
      }
    }
  }
  // turn_file_change_files/patches hang off turn ids; drop rows whose turn no
  // longer has a set rather than tracking the chain.
  try { db.exec('DELETE FROM turn_file_change_files'); } catch { /* absent */ }
  try { db.exec('DELETE FROM turn_file_change_patches'); } catch { /* absent */ }
  const knownTables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  // 会话无关的安装级全局表可能携带账户 ID、工作区路径等 PII；
  // 适配器与测试均不读取，整表清空（保留 schema）。
  for (const table of [
    'account_profiles', 'workspaces', 'app_settings',
    'plugin_inventory_meta', 'plugin_inventory_installations', 'plugin_inventory_resources',
    'marketplace_resource_bindings', 'extension_installations',
    'scheduled_tasks', 'scheduled_task_run_logs', 'scheduled_task_settings',
    // cn 库残留真实账户/环境/服务器标识的安装级全局表（intl 库这些表均为 0 行）
    'partner_plan_snapshots', 'rc_ingress_environments', 'rc_identity_migrations',
    'mcp_connection_profiles', 'mcp_marketplace_receipts', 'mcp_marketplace_receipt_entries',
  ]) {
    if (knownTables.has(table)) db.prepare(`DELETE FROM "${table}"`).run();
  }
  // 纯文本列：用户名替换 + 敏感键截断。表存在性显式判断，不再用 catch 吞错。
  for (const [table, column] of [
    ['chat_sessions', 'title'],
    ['chat_sessions', 'cwd'],
    ['chat_session_recaps', 'text'],
    ['chat_session_search_segments', 'text'],
    ['chat_session_highlights', 'description'],
    ['chat_session_search_fts', 'normalized_text'],
  ]) {
    if (!knownTables.has(table)) continue;
    // rowid 必须显式取别名：若表声明了 INTEGER PRIMARY KEY 列（如
    // chat_session_search_segments.row_id），SELECT rowid 会以声明列名返回
    const rows = db.prepare(`SELECT rowid AS ob_rowid, "${column}" AS value FROM "${table}"`).all();
    const update = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`);
    for (const row of rows) update.run(sanitizeString(column, row.value), row.ob_rowid);
  }
  // JSON 列：逐行结构化净化，rowid 定位。原实现 SELECT 漏取 message_id，
  // 绑定 undefined 被外层 catch 静默吞掉，导致 payload 从未被净化。
  for (const [table, column] of [
    ['chat_session_messages', 'payload_json'],
    ['chat_sessions', 'extra_json'],
    ['chat_sessions', 'execution_target_json'],
    ['scheduled_task_run_logs', 'task_snapshot_json'],
    ['chat_session_highlights', 'items_json'],
  ]) {
    if (!knownTables.has(table)) continue;
    const rows = db.prepare(`SELECT rowid AS ob_rowid, "${column}" AS value FROM "${table}"`).all();
    const update = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`);
    for (const row of rows) {
      if (typeof row.value !== 'string') continue;
      try {
        update.run(JSON.stringify(sanitizeJson(JSON.parse(row.value))), row.ob_rowid);
      } catch {
        // 非 JSON 内容：留给下面的兜底用户名替换
      }
    }
  }
  const allTables = replaceUsernameEverywhere(db);
  assertNoUsername(db, allTables);
  // FTS5 影子表的 BLOB 索引块持有原词分词，TEXT 兜底与 SQL 自检都够不到；
  // 外部内容 FTS 从已净化的 chat_session_search_segments 重建，放在 VACUUM 前。
  if (knownTables.has('chat_session_search_fts')) {
    db.exec("INSERT INTO chat_session_search_fts(chat_session_search_fts) VALUES('rebuild')");
  }
  db.exec('VACUUM');
  // 固化为 rollback journal：WAL 模式会在任何读取时生成 -shm/-wal 副车文件，
  // 污染 fixture 目录（且可能被误提交）
  db.exec('PRAGMA journal_mode=DELETE');
  db.close();
  const target = join(dbTargetDir, 'main.sqlite');
  rmSync(target, { force: true });
  cpSync(staging, target);
  rmSync(staging, { force: true });
  // 清理 staging 的 WAL 副车（源库为 WAL 模式时生成）
  rmSync(`${staging}-shm`, { force: true });
  rmSync(`${staging}-wal`, { force: true });
  return true;
}

// CN install: small complete session + head of the big session (with subagent).
const cnSmall = copyTranscript('.qoder-cn', SMALL_SESSION);
copySessionDir('.qoder-cn', SMALL_SESSION);
const cnBig = copyTranscript('.qoder-cn', BIG_SESSION, 80);
copySessionDir('.qoder-cn', BIG_SESSION, 30);
copyMainDb('.qoder-cn', 'com.qodercn.app.stable', [SMALL_SESSION, BIG_SESSION]);

// Intl install: pinned session (auto-pick would drift as the live install grows).
if (findSessionFile('.qoder', INTL_SESSION) !== null) {
  copyTranscript('.qoder', INTL_SESSION);
  copyMainDb('.qoder', 'com.qoder.app.stable', [INTL_SESSION]);
}

// 字节级终检：覆盖 sqlite 产物与所有 JSONL 转录（BLOB 与非 UTF-8 编码兜底）
for (const entry of readdirSync(outRoot, { recursive: true })) {
  const p = join(outRoot, entry.toString());
  if (statSync(p).isFile()) assertNoLeakBytes(p);
}

const check = new DatabaseSync(join(outRoot, 'AppData', 'Roaming', 'com.qodercn.app.stable', 'main.sqlite'), { readOnly: true });
const kept = check.prepare('SELECT session_id, title FROM chat_sessions').all();
check.close();
console.log('cn small:', cnSmall, '\ncn big:', cnBig);
console.log('fixture sessions in db:', kept.map((row) => row.session_id.slice(0, 8)));
console.log('written:', outRoot);
