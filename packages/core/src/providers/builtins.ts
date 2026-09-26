// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { createClaudeProvider } from './claude.ts';
import { createClineProvider } from './cline.ts';
import { createCodexProvider } from './codex.ts';
import { createCopilotProvider, type CopilotChronicleOpener } from './copilot.ts';
import { createDeepseekProvider } from './deepseek.ts';
import { createHermesProvider, type HermesStoreOpener } from './hermes.ts';
import { createKimiProvider } from './kimi.ts';
import { createOmpProvider } from './omp.ts';
import { createPiProvider } from './pi.ts';
import { createQoderCnProvider, createQoderProvider } from './qoder.ts';
import { createProviderRegistry, type ProviderRegistry } from './registry.ts';
import { createStepcodeProvider } from './stepcode.ts';
import { createZcodeProvider, type ZcodeDatabaseOpener } from './zcode.ts';

export type BuiltinProviderRoots = Readonly<Record<string, string | undefined>>;

export function createBuiltinProviderRegistry(
  roots: BuiltinProviderRoots = {},
  {
    cwd,
    openCopilotChronicle,
    openHermesStore,
    openZcodeDatabase,
  }: {
    cwd?: string;
    openCopilotChronicle?: CopilotChronicleOpener;
    openHermesStore?: HermesStoreOpener;
    openZcodeDatabase?: ZcodeDatabaseOpener;
  } = {},
): ProviderRegistry {
  return createProviderRegistry([
    createClaudeProvider({ rootDir: roots['claude'] }),
    createClineProvider({ rootDir: roots['cline'] }),
    createCodexProvider({ rootDir: roots['codex'] }),
    createCopilotProvider({ rootDir: roots['copilot'], openChronicle: openCopilotChronicle }),
    createDeepseekProvider({ rootDir: roots['deepseek'] }),
    createHermesProvider({ rootDir: roots['hermes'], openStore: openHermesStore }),
    createKimiProvider({ rootDir: roots['kimi'] }),
    createOmpProvider({ rootDir: roots['omp'] }),
    createPiProvider({ rootDir: roots['pi'], cwd }),
    createQoderProvider({ rootDir: roots['qoder'] }),
    createQoderCnProvider({ rootDir: roots['qoder-cn'] }),
    createStepcodeProvider({ rootDir: roots['stepcode'], cwd }),
    createZcodeProvider({ rootDir: roots['zcode'], openDatabase: openZcodeDatabase }),
  ]);
}
