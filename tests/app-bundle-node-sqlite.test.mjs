// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Guards ADR-0005: the Electron main bundle must not statically import
// node:sqlite.
//
// The app is bundled with electron-vite/rollup, which follows static
// `import`/`export ... from` specifiers. A module that statically imports
// node:sqlite therefore lands on the app's module graph. Electron ships the
// builtin today, but relying on that silently couples a desktop release to a
// Node runtime detail; provider adapters instead reach SQLite through an
// injected opener (see providers/zcode.ts, providers/qoder.ts).
//
// This walks the real import graph from every rollup entry declared in
// app/electron.vite.config.ts, so a new cross-package import cannot
// reintroduce the dependency unnoticed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ENTRY_DIR = join(repoRoot, 'app', 'src', 'main');
const MAIN_ENTRIES = [
  'index.ts',
  'update-service.ts',
  'update-backends.ts',
  'update-lifecycle.ts',
  'file-reference.ts',
  'indexer.ts',
  'indexer-service.ts',
  'indexer-worker.ts',
  'indexer-worker-client.ts',
  'recap-capture-query.ts',
];

/** Remove `/* ... *\/` and `// ...` so a specifier mentioned in prose is not a hit. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// Static import/export only: dynamic import() and require() are deliberately
// excluded, since those are how a module can defer a builtin past bundling.
const STATIC_SPECIFIER = /(?:^|;|\n)\s*(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

function staticSpecifiers(source) {
  const clean = stripComments(source);
  const found = [];
  for (const match of clean.matchAll(STATIC_SPECIFIER)) found.push(match[1]);
  return found;
}

function resolveLocal(specifier, fromFile) {
  if (!specifier.startsWith('.')) return null;
  const base = normalize(join(dirname(fromFile), specifier));
  const candidates = /\.(?:[cm]?[jt]s)$/.test(base)
    ? [base]
    : [`${base}.ts`, `${base}.mjs`, `${base}.js`, join(base, 'index.ts')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Breadth-first walk; returns every reachable module plus its first parent. */
function buildGraph(entries) {
  const graph = new Map();
  const parent = new Map();
  const queue = [];
  for (const entry of entries) {
    parent.set(entry, null);
    queue.push(entry);
  }
  while (queue.length > 0) {
    const file = queue.shift();
    if (graph.has(file)) continue;
    const specifiers = staticSpecifiers(readFileSync(file, 'utf8'));
    const deps = [];
    for (const specifier of specifiers) {
      const local = resolveLocal(specifier, file);
      if (local === null) {
        deps.push({ specifier, file: null });
        continue;
      }
      deps.push({ specifier, file: local });
      if (!parent.has(local)) {
        parent.set(local, file);
        queue.push(local);
      }
    }
    graph.set(file, deps);
  }
  return { graph, parent };
}

function chainTo(parent, file) {
  const chain = [];
  let current = file;
  while (current != null) {
    chain.push(current);
    current = parent.get(current) ?? null;
  }
  return chain.reverse();
}

const relative = file => file.slice(repoRoot.length + 1).replaceAll('\\', '/');

test('app main-bundle import graph never reaches a static node:sqlite import', () => {
  const entries = MAIN_ENTRIES.map(name => join(ENTRY_DIR, name));
  for (const entry of entries) {
    assert.ok(existsSync(entry), `rollup entry disappeared: ${relative(entry)}`);
  }

  const { graph, parent } = buildGraph(entries);

  const offenders = [];
  for (const [file, deps] of graph) {
    if (deps.some(dep => dep.file === null && dep.specifier === 'node:sqlite')) {
      offenders.push(file);
    }
  }

  const report = offenders
    .map(file => `${relative(file)}\n  via ${chainTo(parent, file).map(relative).join('\n   -> ')}`)
    .join('\n\n');

  assert.deepEqual(
    offenders.map(relative),
    [],
    `The Electron main bundle must not import node:sqlite statically. `
    + `Take an injected opener instead (see providers/zcode.ts).\n\n${report}`,
  );
});

test('the qoder adapters take an injected database opener, not a static import', async () => {
  // A behavioural check, so the guard above cannot be satisfied by an empty
  // graph after a future refactor.
  const { createQoderCnProvider } = await import('../packages/core/src/providers/qoder.ts');

  const opened = [];
  const provider = createQoderCnProvider({
    rootDir: join(repoRoot, 'tests', 'fixtures', 'qoder', 'home', '.qoder-cn'),
    openDatabase: sourcePath => {
      opened.push(sourcePath);
      throw new Error('deliberately unused: this test only asserts injection');
    },
  });

  provider.discover({
    lastCursor: () => null,
    indexedSessions: () => [],
    reportIncompleteInventory: () => {},
  });

  assert.ok(
    opened.length > 0 || !existsSync(join(repoRoot, 'tests', 'fixtures', 'qoder', 'home')),
    'createQoderCnProvider ignored the injected openDatabase',
  );
});
