// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createStepcodeProvider } from '../packages/core/src/providers/stepcode.ts';
import { makeTempDir } from './temp-dirs.mjs';

function drain(generator) {
  const values = [];
  let step = generator.next();
  while (!step.done) {
    values.push(step.value);
    step = generator.next();
  }
  return { values, cursor: step.value };
}

function jsonl(records, trailingNewline = true) {
  return records.map(record => JSON.stringify(record)).join('\n') + (trailingNewline ? '\n' : '');
}

function header(overrides = {}) {
  return {
    type: 'session',
    version: 3,
    id: '01a0d77c-edfe-76c3-9a07-cae320b35517',
    timestamp: '2026-09-25T07:34:43.966Z',
    cwd: '/home/jinyu',
    ...overrides,
  };
}

function writeSession(content, { root, relativePath = '--home-jinyu--/session.jsonl' } = {}) {
  const sessionRoot = root ?? makeTempDir('obelisk-stepcode-');
  const path = join(sessionRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return { root: sessionRoot, path };
}

function parseOnly(root) {
  const provider = createStepcodeProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 1);
  return { provider, unit: units[0], ...drain(provider.parse(units[0], null)) };
}

// Captured from a real Step Code 0.1.1 session so this suite fails if the
// upstream format drifts away from Pi's JSONL v3 contract.
const STEP_CODE_SESSION = jsonl([
  header(),
  {
    type: 'model_change',
    id: 'cc33cb27',
    parentId: null,
    timestamp: '2026-09-25T07:34:47.120Z',
    provider: 'step',
    modelId: 'step-5-preview',
  },
  {
    type: 'thinking_level_change',
    id: '58953f7c',
    parentId: 'cc33cb27',
    timestamp: '2026-09-25T07:34:47.120Z',
    thinkingLevel: 'medium',
  },
  {
    type: 'message',
    id: 'm-user',
    parentId: 'ef34e72f',
    timestamp: '2026-09-25T07:35:54.900Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '你是否有自带的Harness呢？' }],
      timestamp: 1790321754900,
    },
  },
  {
    type: 'message',
    id: 'm-assistant',
    parentId: 'm-user',
    timestamp: '2026-09-25T07:35:55.012Z',
    message: {
      role: 'assistant',
      provider: 'step',
      model: 'step-5-preview',
      content: [
        { type: 'thinking', thinking: 'The user asks in Chinese: 自带的 Harness', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: '我先看看目录。' },
        {
          type: 'toolCall',
          id: 'chatcmpl-tool-b7b1348a1ec36019',
          name: 'list_directory',
          arguments: { path: '/workspace/projects' },
        },
      ],
      usage: {
        input: 7048,
        output: 581,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 7629,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      rawStopReason: 'toolUse',
      responseId: 'resp-1',
      api: 'openai-completions',
      timestamp: 1790321755012,
    },
  },
  {
    type: 'message',
    id: 'm-toolresult',
    parentId: 'm-assistant',
    timestamp: '2026-09-25T07:35:55.400Z',
    message: {
      role: 'toolResult',
      toolCallId: 'chatcmpl-tool-b7b1348a1ec36019',
      toolName: 'list_directory',
      isError: true,
      content: 'list -> [{"type":"text","text":"Path not found: /workspace/projects"}]',
      details: {},
      timestamp: 1790321755400,
    },
  },
]);

test('Step Code discovery names the source stepcode and keeps Pi JSONL v3 sessions', () => {
  const { root } = writeSession(STEP_CODE_SESSION);
  const provider = createStepcodeProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => null });

  assert.equal(units.length, 1);
  assert.ok(units[0].sessionId.startsWith('stepcode:'));
  assert.equal(provider.descriptor.id, 'stepcode');
  assert.equal(provider.descriptor.name, 'Step Code');
});

test('Step Code sessions stay namespaced away from Pi sessions with the same id', () => {
  const { root } = writeSession(STEP_CODE_SESSION);
  const [unit] = createStepcodeProvider({ rootDir: root }).discover({ lastCursor: () => null });
  assert.equal(unit.sessionId.split(':')[0], 'stepcode');
  assert.notEqual(unit.sessionId.split(':')[0], 'pi');
});

test('Step Code projects tool calls, results, thinking, and usage onto canonical records', () => {
  const { root } = writeSession(STEP_CODE_SESSION);
  const { unit, values, cursor } = parseOnly(root);
  const byKind = kind => values.filter(record => record.kind === kind);

  assert.deepEqual(values[0], { kind: 'delete-session', sessionId: unit.sessionId });
  assert.match(cursor, /^\d+(?:\.\d+)?:0:pi-snapshot-v1:/);

  assert.deepEqual(
    byKind('message').map(record => [record.role, record.content_type]),
    [
      ['user', 'text'],
      ['assistant', 'thinking'],
      ['assistant', 'text'],
      ['assistant', 'tool_use'],
      ['toolResult', 'tool_result'],
    ],
  );
  assert.deepEqual(
    byKind('message').map(record => record.model),
    [null, 'step-5-preview', 'step-5-preview', 'step-5-preview', null],
  );

  // Pi emits the tool_use row without body text (the tool name lives on the
  // paired tool_call record) but keeps the tool_result body on its message row.
  const toolUseMessage = byKind('message').find(record => record.content_type === 'tool_use');
  assert.equal(toolUseMessage.role, 'assistant');
  assert.equal(toolUseMessage.text, null);
  const toolResultMessage = byKind('message').find(record => record.content_type === 'tool_result');
  assert.equal(toolResultMessage.role, 'toolResult');
  assert.match(toolResultMessage.text, /Path not found/);

  const [toolCall] = byKind('tool_call');
  assert.equal(toolCall.name, 'list_directory');
  // Pi only projects file_path for its own read/edit/write tool names. Step Code
  // spells them read_file/edit_file/write_file, so this stays null until the
  // shared whitelist learns those aliases; fileHistory() cannot see them yet.
  assert.equal(toolCall.file_path, null);
  assert.equal(JSON.parse(toolCall.input_json).path, '/workspace/projects');

  const [toolResult] = byKind('tool_result');
  assert.equal(toolResult.content, 'list -> [{"type":"text","text":"Path not found: /workspace/projects"}]');
  // Step Code marks a failed tool run with isError; the projection must keep it.
  assert.equal(toolResult.is_error, 1);
  assert.equal(toolResult.tool_use_id, toolCall.id);
});

test('Step Code reports a missing root as incomplete only once it has indexed sessions', () => {
  const root = join(makeTempDir('obelisk-stepcode-missing-'), 'absent');
  const provider = createStepcodeProvider({ rootDir: root });
  const issues = [];
  const context = {
    lastCursor: () => null,
    reportIncompleteInventory(value) { issues.push(value); },
  };

  assert.deepEqual(provider.discover(context), []);
  assert.deepEqual(issues, []);
  assert.deepEqual(provider.discover({
    ...context,
    indexedSessions: () => [{ sessionId: 'prior', jsonlPath: '/prior/source' }],
  }), []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, root);
});

test('Step Code never certifies an invalid session root as empty', () => {
  const parent = makeTempDir('obelisk-stepcode-invalid-root-');
  const root = join(parent, 'sessions');
  writeFileSync(root, 'not a directory');
  let status = 'unknown';
  const units = createStepcodeProvider({ rootDir: root }).discover({
    lastCursor: () => null,
    reportCompleteInventory: () => { status = 'complete'; },
    reportIncompleteInventory: () => { status = 'incomplete'; },
  });
  assert.deepEqual(units, []);
  assert.equal(status, 'incomplete');
});

test('Step Code rejects a providerRoot that is not absolute', () => {
  const provider = createStepcodeProvider({ rootDir: 'relative/sessions' });
  assert.equal(provider.rootResolution.requiresExplicitRoot, true);
  assert.match(provider.rootResolution.reason, /must be absolute or start with ~/);
  assert.deepEqual(provider.watchTargets(), []);
});
