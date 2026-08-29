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

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const [table, column] of Object.entries({ chat_sessions: 'title', chat_sessions_cwd: 'cwd', chat_session_recaps: 'text', chat_session_search_segments: 'text' })) {
    try {
      const realTable = table.replace('_cwd', '');
      const rows = db.prepare(`SELECT rowid, ${column} AS value FROM ${realTable}`).all();
      const update = db.prepare(`UPDATE ${realTable} SET ${column} = ? WHERE rowid = ?`);
      for (const row of rows) update.run(sanitizeString(column, row.value), row.rowid);
    } catch { /* absent */ }
  }
  try {
    const rows = db.prepare('SELECT session_id, payload_json FROM chat_session_messages').all();
    const update = db.prepare('UPDATE chat_session_messages SET payload_json = ? WHERE session_id = ? AND message_id = ?');
    for (const row of rows) {
      update.run(JSON.stringify(sanitizeJson(JSON.parse(row.payload_json))), row.session_id, row.message_id);
    }
  } catch { /* absent */ }
  db.exec('VACUUM');
  db.close();
  const target = join(dbTargetDir, 'main.sqlite');
  rmSync(target, { force: true });
  cpSync(staging, target);
  rmSync(staging, { force: true });
  return true;
}

// CN install: small complete session + head of the big session (with subagent).
const cnSmall = copyTranscript('.qoder-cn', SMALL_SESSION);
copySessionDir('.qoder-cn', SMALL_SESSION);
const cnBig = copyTranscript('.qoder-cn', BIG_SESSION, 80);
copySessionDir('.qoder-cn', BIG_SESSION, 30);
copyMainDb('.qoder-cn', 'com.qodercn.app.stable', [SMALL_SESSION, BIG_SESSION]);

// Intl install: keep whatever exists (a single near-empty session here).
const intlSession = (() => {
  const projects = join(home, '.qoder', 'projects');
  if (!existsSync(projects)) return null;
  for (const slug of readdirSync(projects)) {
    for (const entry of readdirSync(join(projects, slug))) {
      if (entry.endsWith('.jsonl')) return entry.slice(0, -'.jsonl'.length);
    }
  }
  return null;
})();
if (intlSession !== null) {
  copyTranscript('.qoder', intlSession);
  copyMainDb('.qoder', 'com.qoder.app.stable', [intlSession]);
}

const check = new DatabaseSync(join(outRoot, 'AppData', 'Roaming', 'com.qodercn.app.stable', 'main.sqlite'), { readOnly: true });
const kept = check.prepare('SELECT session_id, title FROM chat_sessions').all();
check.close();
console.log('cn small:', cnSmall, '\ncn big:', cnBig);
console.log('fixture sessions in db:', kept.map((row) => row.session_id.slice(0, 8)));
console.log('written:', outRoot);
