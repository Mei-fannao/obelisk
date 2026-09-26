// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sep } from 'node:path';

import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { createBuiltinProviderRegistry } from '../packages/core/src/providers/builtins.ts';

// Watch-target paths are built with node:path join, whose separator differs
// by platform; normalize to '/' so the POSIX literals below assert everywhere.
const withPosixPaths = (targets) => targets.map((target) => ({
  ...target,
  path: target.path.split(sep).join('/'),
}));

function fakeProvider(id, root) {
  return {
    name: id,
    descriptor: {
      id,
      name: `${id} display`,
      vendor: `${id} vendor`,
      defaultRoot: root,
      color: '#123456',
    },
    watchTargets(configuredRoot) {
      return [
        { kind: 'tree', path: `${configuredRoot}/sessions` },
        { kind: 'file', path: `${configuredRoot}/session-index` },
      ];
    },
    discover() {
      return [];
    },
    *parse() {
      yield* [];
      return null;
    },
    raw(input) {
      return { text: `${id}:${input.messageUuid}` };
    },
  };
}

test('provider registry drives source catalog, watch roots, and raw lookup', () => {
  const registry = createProviderRegistry([
    fakeProvider('alpha', '/default/alpha'),
    fakeProvider('beta', '/default/beta'),
  ]);

  assert.deepEqual(registry.catalog(), [
    { id: 'alpha', name: 'alpha display', vendor: 'alpha vendor', defaultRoot: '/default/alpha', color: '#123456' },
    { id: 'beta', name: 'beta display', vendor: 'beta vendor', defaultRoot: '/default/beta', color: '#123456' },
  ]);
  assert.deepEqual(registry.watchTargets({ alpha: '/custom/alpha' }), [
    { kind: 'tree', path: '/custom/alpha/sessions' },
    { kind: 'file', path: '/custom/alpha/session-index' },
    { kind: 'tree', path: '/default/beta/sessions' },
    { kind: 'file', path: '/default/beta/session-index' },
  ]);
  assert.deepEqual(
    registry.raw({ source: 'beta', messageUuid: 'message-1', session: null, agentId: null }),
    { text: 'beta:message-1' },
  );
  assert.equal(
    registry.raw({ source: 'missing', messageUuid: 'message-1', session: null, agentId: null }),
    null,
  );
});

test('built-in provider registry exposes every source without caller-side branching', () => {
  const registry = createBuiltinProviderRegistry({
    claude: '/sources/claude',
    cline: '/sources/cline',
    codex: '/sources/codex',
    copilot: '/sources/copilot',
    deepseek: '/sources/deepseek',
    hermes: '/sources/hermes',
    kimi: '/sources/kimi',
    omp: '/sources/omp',
    pi: '/sources/pi',
    qoder: '/sources/qoder',
    'qoder-cn': '/sources/qoder-cn',
    stepcode: '/sources/stepcode',
    zcode: '/sources/zcode',
  });

  assert.deepEqual(registry.catalog().map(({ id, name }) => ({ id, name })), [
    { id: 'claude', name: 'Claude Code' },
    { id: 'cline', name: 'Cline' },
    { id: 'codex', name: 'Codex' },
    { id: 'copilot', name: 'GitHub Copilot' },
    { id: 'deepseek', name: 'DeepSeek Harness' },
    { id: 'hermes', name: 'Hermes Agent' },
    { id: 'kimi', name: 'Kimi Code' },
    { id: 'omp', name: 'OMP' },
    { id: 'pi', name: 'Pi' },
    { id: 'qoder', name: 'Qoder' },
    { id: 'qoder-cn', name: 'Qoder CN' },
    { id: 'stepcode', name: 'Step Code' },
    { id: 'zcode', name: 'ZCode' },
  ]);
  assert.deepEqual(withPosixPaths(registry.watchTargets()), [
    { kind: 'tree', path: '/sources/claude/projects' },
    { kind: 'file', path: '/sources/claude/history.jsonl' },
    { kind: 'tree', path: '/sources/cline/sessions' },
    { kind: 'tree', path: '/sources/codex/sessions' },
    { kind: 'tree', path: '/sources/codex/archived_sessions' },
    { kind: 'file', path: '/sources/codex/session_index.jsonl' },
    { kind: 'file', path: '/sources/copilot/globalStorage/github.copilot-chat/session-store.db' },
    { kind: 'file', path: '/sources/copilot/globalStorage/github.copilot-chat/session-store.db-wal' },
    { kind: 'tree', path: '/sources/copilot/workspaceStorage' },
    { kind: 'tree', path: '/sources/deepseek' },
    { kind: 'file', path: '/sources/hermes/state.db' },
    { kind: 'file', path: '/sources/hermes/state.db-wal' },
    { kind: 'tree', path: '/sources/hermes/profiles', fileNames: ['state.db', 'state.db-wal'] },
    { kind: 'tree', path: '/sources/kimi/sessions' },
    { kind: 'file', path: '/sources/kimi/session_index.jsonl' },
    { kind: 'tree', path: '/sources/omp' },
    { kind: 'tree', path: '/sources/pi' },
    { kind: 'tree', path: '/sources/qoder/projects' },
    { kind: 'file', path: '/sources/AppData/Roaming/com.qoder.app.stable/main.sqlite' },
    { kind: 'tree', path: '/sources/qoder-cn/projects' },
    { kind: 'file', path: '/sources/AppData/Roaming/com.qodercn.app.stable/main.sqlite' },
    { kind: 'tree', path: '/sources/stepcode' },
    { kind: 'file', path: '/sources/zcode/db/db.sqlite' },
    { kind: 'file', path: '/sources/zcode/db/db.sqlite-wal' },
  ]);
});
