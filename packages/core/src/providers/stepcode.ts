// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Step Code (https://github.com/stepfun-ai/Step-Code) is built on Pi and writes
// Pi's JSONL v3 session format, so the whole Pi transcript pipeline applies
// unchanged. Only the root layout, display identity, and default location
// differ, which is what `createPiFamilyProvider` already parameterizes.

import { homedir } from 'node:os';
import { join, isAbsolute, normalize } from 'node:path';

import {
  createPiFamilyProvider,
  type PiFamilyConfig,
  type PiProvider,
  type PiRootResolution,
} from './pi.ts';

const SOURCE = 'stepcode';

// Step Code stores sessions under `~/.stepcode/agent/sessions/<project>/`,
// the same `<root>/<project>/<file>.jsonl` shape Pi uses. An explicit
// `STEPCODE_SESSION_DIR` keeps non-default installs resolvable.
const DEFAULT_AGENT_DIR = join('.stepcode', 'agent');

// Step Code shares Pi's on-disk format, so it tracks the same marker.
const INDEX_VERSION_MARKER = '__pi_canonical_transcript_v9__';

const CONFIG: PiFamilyConfig = {
  source: SOURCE,
  displayName: 'Step Code',
  vendor: 'StepFun',
  color: '#4f6bed',
  indexVersionMarker: INDEX_VERSION_MARKER,
};

function configuredAbsolutePath(value: unknown, homeDir: string): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const trimmed = value.trim();
  const expanded = trimmed === '~'
    ? homeDir
    : trimmed.startsWith('~/')
      ? join(homeDir, trimmed.slice(2))
      : trimmed;
  return isAbsolute(expanded) ? normalize(expanded) : null;
}

function resolveStepcodeRoot(rootDir: string | undefined, cwd: string | undefined): PiRootResolution {
  const homeDir = homedir();
  const fallbackRoot = join(homeDir, DEFAULT_AGENT_DIR, 'sessions');

  if (rootDir !== undefined) {
    const absolute = configuredAbsolutePath(rootDir, homeDir);
    if (absolute !== null) return { root: absolute, requiresExplicitRoot: false };
    return {
      root: fallbackRoot,
      requiresExplicitRoot: true,
      reason: 'Obelisk Step Code providerRoot must be absolute or start with ~',
    };
  }

  const fromEnv = process.env['STEPCODE_SESSION_DIR'];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    const absolute = configuredAbsolutePath(fromEnv, homeDir);
    if (absolute !== null) return { root: absolute, requiresExplicitRoot: false };
    return {
      root: fallbackRoot,
      requiresExplicitRoot: true,
      reason: 'STEPCODE_SESSION_DIR is relative to the Step Code launch cwd',
    };
  }

  // Step Code has no project-local sessionDir override, so the launch cwd
  // never changes where sessions live.
  void cwd;
  return { root: fallbackRoot, requiresExplicitRoot: false };
}

export function createStepcodeProvider({
  rootDir,
  cwd,
}: {
  rootDir?: string;
  cwd?: string;
} = {}): PiProvider {
  const rootResolution = resolveStepcodeRoot(rootDir, cwd);
  return createPiFamilyProvider({ rootResolution, config: CONFIG });
}

export const stepcodeProvider = createStepcodeProvider();
