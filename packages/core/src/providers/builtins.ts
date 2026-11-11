// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { createClaudeProvider } from './claude.ts';
import { createClineProvider } from './cline.ts';
import { createCodexProvider } from './codex.ts';
import { createCodexHostAntigravityProvider } from './codexhost-antigravity.ts';
import { createCopilotProvider, type CopilotChronicleOpener } from './copilot.ts';
import { createDeepseekProvider } from './deepseek.ts';
import { createHermesProvider, type HermesStoreOpener } from './hermes.ts';
import { createKimiProvider } from './kimi.ts';
import { createKiroProvider, type KiroDatabaseOpener } from './kiro.ts';
import { createOmpProvider } from './omp.ts';
import { createOpencodeProvider, type OpencodeDatabaseOpener } from './opencode.ts';
import { createPiProvider } from './pi.ts';
import { createQoderCnProvider, createQoderProvider, type QoderDatabaseOpener } from './qoder.ts';
import { createZcodeProvider, type ZcodeDatabaseOpener } from './zcode.ts';
import { createProviderRegistry, type ProviderRegistry } from './registry.ts';

export type BuiltinProviderRoots = Readonly<Record<string, string | undefined>>;

export function createBuiltinProviderRegistry(
  roots: BuiltinProviderRoots = {},
  {
    homeDir,
    cwd,
    copilotUserDataRoots,
    openCopilotChronicle,
    openHermesStore,
    openZcodeDatabase,
    openKiroDatabase,
    openOpencodeDatabase,
    openQoderDatabase,
  }: {
    homeDir?: string;
    cwd?: string;
    copilotUserDataRoots?: readonly string[];
    openCopilotChronicle?: CopilotChronicleOpener;
    openHermesStore?: HermesStoreOpener;
    openZcodeDatabase?: ZcodeDatabaseOpener;
    openKiroDatabase?: KiroDatabaseOpener;
    openOpencodeDatabase?: OpencodeDatabaseOpener;
    openQoderDatabase?: QoderDatabaseOpener;
  } = {},
): ProviderRegistry {
  return createProviderRegistry([
    createClaudeProvider({ rootDir: roots['claude'] }),
    createClineProvider({ rootDir: roots['cline'] }),
    createCodexProvider({ rootDir: roots['codex'] }),
    createCodexHostAntigravityProvider({ rootDir: roots['codexhost-antigravity'] }),
    createCopilotProvider({ rootDir: roots['copilot'], userDataRoots: copilotUserDataRoots, openChronicle: openCopilotChronicle }),
    createDeepseekProvider({ rootDir: roots['deepseek'] }),
    createHermesProvider({ rootDir: roots['hermes'], openStore: openHermesStore }),
    createKimiProvider({ rootDir: roots['kimi'] }),
    createKiroProvider({ rootDir: roots['kiro'], openDatabase: openKiroDatabase }),
    createOmpProvider({ rootDir: roots['omp'] }),
    createOpencodeProvider({ rootDir: roots['opencode'], homeDir, openDatabase: openOpencodeDatabase }),
    createPiProvider({ rootDir: roots['pi'], cwd }),
    createQoderProvider({ rootDir: roots['qoder'], openDatabase: openQoderDatabase }),
    createQoderCnProvider({ rootDir: roots['qoder-cn'], openDatabase: openQoderDatabase }),
    createZcodeProvider({ rootDir: roots['zcode'], openDatabase: openZcodeDatabase }),
  ]);
}
