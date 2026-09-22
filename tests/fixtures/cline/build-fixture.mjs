// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Builds tests/fixtures/cline/sessions/ from a real Cline CLI data directory.
//
// Usage: node tests/fixtures/cline/build-fixture.mjs <path-to-~/.cline>
//
// Keeps three real sessions: one rich (tools, images, an errored tool result,
// status "failed"), one small cancelled session, and one two-message
// completed session. Long human-readable strings and image payloads are
// sanitized; block structure, roles, tool names, statuses, timestamps and
// usage numbers are preserved verbatim so the parse tests can pin them.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = process.argv[2];
if (!sourceRoot) {
  console.error('usage: node tests/fixtures/cline/build-fixture.mjs <~/.cline>');
  process.exit(1);
}

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const outRoot = join(fixtureDir, 'sessions');

const KEEP_SESSIONS = [
  '1787458927083_fgec4', // rich: tools, images, tool error, failed status
  '1787732507956_vkafw', // small: 4 tool calls, cancelled status
  '1787801982963_3fnb7', // minimal: 2 messages, completed status
];

const SENSITIVE_KEYS = new Set([
  'text', 'thinking', 'input', 'content', 'result', 'query',
  'prompt', 'system_prompt', 'data',
]);

function sanitizeString(key, value) {
  if (typeof value !== 'string') return value;
  let out = value.replaceAll('联想', 'user').replaceAll('/home/jinyu', '/home/user').replaceAll('jinyu', 'user');
  if (key === 'data') return '[image payload removed]';
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
mkdirSync(outRoot, { recursive: true });

for (const sessionId of KEEP_SESSIONS) {
  const sourceDir = join(sourceRoot, 'data', 'sessions', sessionId);
  if (!existsSync(sourceDir)) {
    console.error(`missing source session: ${sessionId}`);
    process.exit(1);
  }
  const targetDir = join(outRoot, sessionId);
  mkdirSync(targetDir);
  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);
    const parsed = JSON.parse(readFileSync(sourcePath, 'utf8'));
    writeFileSync(targetPath, JSON.stringify(sanitizeJson(parsed), null, 1));
  }
  console.log(`fixture session: ${sessionId} -> ${targetDir} (${readdirSync(targetDir).join(', ')})`);
}

// 自检：fixture 不得残留 Windows/WSL 用户名（宁缺毋滥）
for (const sessionId of KEEP_SESSIONS) {
  for (const entry of readdirSync(join(outRoot, sessionId))) {
    const text = readFileSync(join(outRoot, sessionId, entry), 'utf8');
    if (text.includes('联想') || text.includes('jinyu')) {
      throw new Error(`fixture 仍残留用户名: ${sessionId}/${entry}`);
    }
  }
}

// 字节级兜底自检：非 UTF-8 编码残留逃得过文本自检；读文件 Buffer 按字节
// 扫描，命中即中止构建（与 qoder 脚本同一清单）。
const LEAK_BYTES = [
  ['联想/UTF-8', Buffer.from('联想', 'utf8')],
  ['联想/GBK', Buffer.from([0xC1, 0xAA, 0xCF, 0xEB])],
  ['联想/UTF-16LE', Buffer.from('联想', 'utf16le')],
  ['jinyu/ASCII', Buffer.from('jinyu', 'ascii')],
];
for (const sessionId of KEEP_SESSIONS) {
  for (const entry of readdirSync(join(outRoot, sessionId))) {
    const filePath = join(outRoot, sessionId, entry);
    const buf = readFileSync(filePath);
    for (const [label, needle] of LEAK_BYTES) {
      if (buf.includes(needle)) throw new Error(`fixture 字节级泄漏: ${label} in ${filePath}`);
    }
  }
}

